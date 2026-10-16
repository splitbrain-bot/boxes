import { randomBytes } from 'node:crypto';
import {
  GLOBAL_AGENT_SET,
  type CreateBoxBody,
  type CreateThreadBody,
  type HarnessId,
  type BoxDetail,
  type BoxSummary,
  type BoxTunnel,
  type ThreadOptions,
  type ThreadSummary,
} from '../../shared/types.ts';
import type { AgentStore } from './agents.ts';
import type { Config } from './config.ts';
import { boxEnv } from './boxenv.ts';
import type { EgressManager } from './egress.ts';
import {
  clearBoxTurns,
  latestThread,
  getThread,
  insertThread,
  listThreads,
  boxTurnActive,
  boxesWithActiveTurns,
  setThreadDone,
  threadConfig,
  touchBox,
  type Db,
  type BoxRow,
  type ThreadRow,
} from './db.ts';
import { BoxUsage, BOX_SIZE_TTL_MS } from './diskusage.ts';
import { fileService, OutdatedImageError } from './files.ts';
import { DEFAULT_HARNESS, harness } from './harness.ts';
import { HttpError } from './http-error.ts';
import { LOGIN_CONTAINER_MAX_AGE_MS } from './login.ts';
import { log } from './log.ts';
import type { Notifier } from './notify.ts';
import { boxProcesses } from './processes.ts';
import {
  runtime,
  WORKSPACE_DIR,
  type BoxSpec,
  type PullEvent,
  type RuntimeObject,
} from './runtime/runtime.ts';
import { generateWsToken } from './secret.ts';
import { setUpBox } from './setup.ts';
import { readSettings } from './settings.ts';
import type { BoxReading } from './tunnels.ts';
import { PendingStore } from './gateway/pending.ts';
import { NOTHING_TO_FORK, THREAD_NOT_FOUND, UpstreamBox } from './gateway/upstream.ts';

/**
 * How many times more boxes the host may hold than the database knows of
 * before the orphan sweep refuses to run.
 *
 * It catches a database that does not belong to these files, such as a data
 * volume mounted from the wrong place. A ratio rather than an empty-table
 * check, so one box created against the wrong database does not disarm it.
 */
const STRAY_BOX_RATIO = 3;

/**
 * How often typing in a terminal writes the box's activity back, in
 * milliseconds.
 *
 * The reaper reads activity in minutes, so writing a row per keystroke would
 * record nothing it acts on any differently.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Creates, starts, stops and describes boxes, and owns every UpstreamBox.
 * The runtime holds the runtime state; the boxes table holds the metadata.
 */
export class BoxManager {
  /** The gateway connection of each box, created on first use. */
  private readonly upstreams = new Map<string, UpstreamBox>();

  /**
   * One promise chain per box, so two operations that change the same box
   * never overlap. Different boxes do not wait on each other, and a
   * box's entry goes as soon as its chain drains.
   */
  private readonly slots = new Map<string, Promise<unknown>>();

  /**
   * Boxes a stop or a delete has overtaken. Whatever is queued or running
   * for one gives itself up at its next step; see {@link giveUpIfPreempted}.
   */
  private readonly preempted = new Set<string>();

  /**
   * How many terminals are open on each box, and when typing in one last
   * marked it active.
   *
   * A box with a terminal open holds the reaper off the way an attached
   * browser does. Entries go as the last terminal of a box closes.
   */
  private readonly terminals = new Map<string, { open: number; touchedAt: number }>();

  /** Permission requests waiting for a browser, across all boxes. */
  readonly pending: PendingStore;

  /** How big each box has got, measured by the file service in the box. */
  private readonly usage = new BoxUsage({
    measure: (id) => this.measureDisk(id),
    store: (id, bytes, at) => {
      this.db
        .prepare('UPDATE boxes SET disk_bytes = ?, disk_measured_at = ? WHERE id = ?')
        .run(bytes, at, id);
    },
    ttlMs: BOX_SIZE_TTL_MS,
    onTrouble: (id, error) =>
      log.box(id).warn('could not measure what a box is using', {
        error: error.message,
      }),
  });

  /** The error of the last pull of the box image, or null when it worked. */
  private lastPullError: string | null = null;

  constructor(
    /** Where the boxes and their threads are stored. */
    private readonly db: Db,
    /** The deployment's configuration. */
    private readonly cfg: Config,
    /** The egress policy, and the credential placeholders a box is given. */
    private readonly egress: EgressManager,
    /** Sends the push notifications a thread raises. */
    private readonly notifier: Notifier,
    /**
     * The AGENTS.md and skills a box is given. The app creates it,
     * so the REST routes and the lifecycle share one store.
     */
    private readonly agents: AgentStore,
    /** The dev tunnel ports a box hosts, as the tunnel reconciler last read them. */
    private readonly tunnelsOf: (boxId: string) => BoxTunnel[] = () => [],
  ) {
    this.pending = new PendingStore(db);
  }

  // --- one operation per box at a time -----------------------------------

  /**
   * Runs `fn` with the box to itself, after whatever is already queued
   * for it.
   *
   * Container repairs check the runtime's state and act on it a moment later.
   * Start, a local command and the gateway all reach them, and the reaper
   * stops boxes under all three. So every operation that changes a box runs
   * alone, in arrival order. Reads are not queued. A request for a busy box
   * waits without a timeout, and a rejection does not block the queue.
   *
   * Nothing `fn` calls may take a slot for the same box again, or it would
   * wait for itself forever. So each queued public method wraps a private
   * form that takes no slot, and the repairs and the teardown call those.
   */
  private withSlot<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.slots.get(id) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail: Promise<void> = result.then(
      () => this.releaseSlot(id, tail),
      () => this.releaseSlot(id, tail),
    );
    this.slots.set(id, tail);
    return result;
  }

  /** Forgets a box's chain once nothing is left waiting on it. */
  private releaseSlot(id: string, tail: Promise<void>): void {
    if (this.slots.get(id) === tail) this.slots.delete(id);
  }

  /**
   * Gives up the operation in flight when a stop or a delete has overtaken
   * it.
   *
   * Checked between the steps of an operation rather than inside one: a
   * container half created is worse than one step too many, and every step
   * here is short.
   */
  private giveUpIfPreempted(id: string): void {
    if (!this.preempted.has(id)) return;
    throw new HttpError(409, 'This box was stopped while the request was in flight');
  }

  // --- the box image ----------------------------------------------------

  /**
   * Makes the box image available, and throws when it cannot. Without the
   * image, no box can be created.
   *
   * @param onProgress Called with each progress event of a pull.
   */
  async ensureBoxImage(onProgress?: (event: PullEvent) => void): Promise<void> {
    await runtime().ensureImage(onProgress);
  }

  /**
   * Asks the runtime for a new image behind the tag of the box image. A box
   * moves onto the new image at its next start. The manager keeps the error
   * of a failed pull for the error message of a failed setup.
   *
   * @param onProgress Called with each progress event of a pull.
   */
  async refreshBoxImage(onProgress?: (event: PullEvent) => void): Promise<void> {
    try {
      await runtime().refreshImage(onProgress);
    } catch (err) {
      this.lastPullError = (err as Error).message;
      throw err;
    }
    this.lastPullError = null;
  }

  /**
   * Removes the runtime objects of boxes that no longer exist, and the login
   * containers that nothing waits for.
   *
   * reconcile() looks up what the runtime has for each row; this looks up the
   * row for each object of the inventory. It finds what a crash during a create, or a
   * teardown that failed halfway, left behind.
   *
   * create() inserts the row before any runtime object exists, so an object
   * whose box has no live row is never one being created. A deleted box's
   * tombstone counts as no row, so a failed teardown is swept too.
   *
   * The objects go in the order of the inventory, which is the order the
   * runtime can remove them in.
   */
  async sweepOrphans(): Promise<void> {
    const inventory = await runtime().inventory();
    // A login belongs to no box, so the rules below do not apply to it.
    await this.sweepLogins(inventory);

    // Read last: a box created while the inventory was read has its row by
    // now, so its objects are not taken for orphans.
    const live = new Set(this.allRows().map((row) => row.id));
    const strays = inventory.filter(
      (obj): obj is Exclude<RuntimeObject, { kind: 'login' }> =>
        obj.kind !== 'login' && !live.has(obj.boxId),
    );
    const boxes = new Set(strays.map((obj) => obj.boxId));
    if (boxes.size === 0) return;

    // Tombstones count, so a deployment whose boxes were all deleted still
    // gets its failed teardowns swept.
    const known = (
      this.db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number }
    ).n;
    if (boxes.size > known * STRAY_BOX_RATIO) {
      log.warn('not sweeping: the runtime holds far more boxes than this database knows of', {
        strays: boxes.size,
        known,
        ratio: STRAY_BOX_RATIO,
        boxes: [...boxes],
        objects: strays.length,
      });
      return;
    }

    log.info('sweeping what is left of boxes that are gone', { boxes: [...boxes] });
    for (const obj of strays) {
      await this.sweeping(obj.boxId, obj.kind, () => runtime().removeObject(obj));
    }
  }

  /**
   * Removes login containers that nothing is waiting on.
   *
   * A login removes its container when the flow ends. A restart mid-login
   * leaves the container behind, holding half a credential in a tmpfs home.
   *
   * Age is the only rule, because a login container has no owner to ask. The
   * cutoff is longer than the ten minutes a flow may take, so a login in
   * progress is never swept.
   */
  private async sweepLogins(inventory: RuntimeObject[]): Promise<void> {
    const cutoff = Date.now() - LOGIN_CONTAINER_MAX_AGE_MS;
    for (const obj of inventory) {
      if (obj.kind !== 'login' || obj.createdAt > cutoff) continue;
      try {
        await runtime().removeObject(obj);
        log.info('swept an abandoned login container', {
          credential: obj.credentialId,
          container: obj.ref,
        });
      } catch (err) {
        log.warn('could not sweep an abandoned login container', {
          container: obj.ref,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Runs one removal of the sweep, keeping the rest going when it fails.
   *
   * A failure is logged, and the next sweep tries again.
   */
  private async sweeping(
    boxId: string,
    what: string,
    remove: () => Promise<void>,
  ): Promise<void> {
    try {
      await remove();
      log.box(boxId).info('swept an orphaned object', { what });
    } catch (err) {
      log.box(boxId).warn('could not sweep an orphaned object', {
        what,
        error: (err as Error).message,
      });
    }
  }

  // --- helpers --------------------------------------------------------------

  /** The stored row for a box, including deleted ones. */
  getRow(id: string): BoxRow | undefined {
    return this.db.prepare('SELECT * FROM boxes WHERE id = ?').get(id) as
      | BoxRow
      | undefined;
  }

  /** Every box that has not been deleted, newest first. */
  private allRows(): BoxRow[] {
    return this.db
      .prepare("SELECT * FROM boxes WHERE status != 'deleted' ORDER BY created_at DESC")
      .all() as BoxRow[];
  }

  /**
   * Records a new status, leaving a deleted box deleted. An upstream spawn
   * still retrying when the box was removed reports its outcome later, and
   * that must not bring the row back.
   */
  private setStatus(id: string, status: BoxRow['status']): void {
    this.db
      .prepare("UPDATE boxes SET status = ? WHERE id = ? AND status != 'deleted'")
      .run(status, id);
  }

  /**
   * Everything the runtime needs to create or repair the container of a box.
   * Both a new box and every recreated container are built from it.
   *
   * The placeholders are those of the credentials stored right now, so a
   * credential that arrives later reaches a box when its container is next
   * created.
   */
  private boxSpec(id: string): BoxSpec {
    return {
      boxId: id,
      env: boxEnv({
        placeholderFor: (credential) => this.egress.placeholderFor(credential),
        methodFor: (credential) => this.egress.methodFor(credential),
        gitlabHost: this.cfg.GITLAB_HOST,
        proxyUrl: runtime().proxyUrl(),
        hasCa: this.egress.caCertificate() !== '',
      }),
    };
  }

  /** The persistent upstream for a box, created on first use. */
  upstream(id: string): UpstreamBox {
    let up = this.upstreams.get(id);
    if (!up) {
      up = new UpstreamBox(
        id,
        this.db,
        this.cfg,
        this.pending,
        this.notifier,
        (status) => this.setStatus(id, status),
        // Opening a thread starts a stopped box without start(), so the
        // repairs and the setup run here too, under the same slot.
        () => this.withSlot(id, () => this.bringUp(id)),
      );
      this.upstreams.set(id, up);
    }
    return up;
  }

  // --- create ---------------------------------------------------------------

  /**
   * Creates the storage and the container of a new box. Any failed step
   * tears the whole box down and marks it as an error.
   */
  async create(body: CreateBoxBody): Promise<BoxDetail> {
    const name = body.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (name.length > 100) throw new HttpError(400, 'name must be 100 characters or fewer');

    // The global set is applied whatever this says, so naming it is the same
    // as naming nothing and is stored as nothing.
    const requested = body.agentSet?.trim() ?? '';
    const agentSetId = requested === '' || requested === GLOBAL_AGENT_SET ? null : requested;
    if (agentSetId && !this.agents.has(agentSetId)) {
      throw new HttpError(400, `Unknown agent set: ${agentSetId}`);
    }

    // Checked before anything is allocated, so an unknown harness costs no
    // resources on its way to a 400.
    const thread = threadOptions(body.thread);

    // After the checks above, so an invalid request pulls no image.
    try {
      await this.ensureBoxImage();
    } catch (err) {
      throw new HttpError(
        503,
        `Box image ${this.cfg.BOX_IMAGE} is not available: ${(err as Error).message}`,
      );
    }

    // Server-generated: user input never reaches a runtime object name.
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const row: BoxRow = {
      id,
      name,
      // Every box is DEFAULT: the deployment has one set of credentials.
      profile: 'DEFAULT',
      // No base revision until the reviewer picks one. A review compares
      // each repository against its own HEAD by default.
      review_base_rev: null,
      status: 'creating',
      agent_set_id: agentSetId,
      // A token of its own, so it opens this box's WebSocket and no other.
      ws_token: generateWsToken(),
      created_at: now,
      last_active_at: now,
      disk_bytes: null,
      disk_measured_at: null,
      ready_at: null,
    };

    this.db
      .prepare(
        `INSERT INTO boxes (id, name, profile, status, agent_set_id,
           ws_token, created_at, last_active_at)
         VALUES (@id, @name, @profile, @status, @agent_set_id,
           @ws_token, @created_at, @last_active_at)`,
      )
      .run(row);

    const slog = log.box(id);
    try {
      await this.withSlot(id, () => this.createResources(id));
      this.setStatus(id, 'running');
      // The first conversation, as a row only. The first browser to open it
      // starts the adapter, so a box can be created for a harness whose
      // credential has not been entered yet.
      insertThread(this.db, id, {
        harness: thread.harness,
        modeId: thread.modeId ?? null,
        config: thread.config ?? { ...harness(thread.harness).defaultConfig },
      });
      slog.info('box created', { name, harness: thread.harness });
    } catch (err) {
      slog.error('box create failed; tearing down', { error: (err as Error).message });
      await this.teardownResources(id);
      this.setStatus(id, 'error');
      throw new HttpError(500, `Failed to create box: ${(err as Error).message}`);
    }

    return this.detail(id);
  }

  /**
   * Builds the storage and the container of a new box, starts it and makes
   * it ready. Runs under the box's slot. The storage comes before the
   * container that mounts it.
   */
  private async createResources(id: string): Promise<void> {
    await runtime().createStorage(id);
    await runtime().ensure(this.boxSpec(id));
    await runtime().start(id);
    await this.makeReady(this.mustGet(id));
  }

  // --- start / stop / delete ------------------------------------------------

  /**
   * Brings a box's container and isolation up to date before it is started.
   *
   * Runs under the caller's slot and takes none of its own. A stop or a
   * delete that arrives meanwhile takes effect before the repair.
   */
  private async prepareContainer(id: string): Promise<void> {
    this.giveUpIfPreempted(id);
    // Before anything mounts the storage.
    await this.requireStorage(id);
    this.giveUpIfPreempted(id);
    await runtime().ensure(this.boxSpec(id));
  }

  /**
   * Refuses to go on when a box's storage is gone, naming what is missing,
   * and marks the box as an error.
   *
   * The storage is not created again, because a fresh home would erase the
   * adapter's thread transcripts.
   */
  private async requireStorage(id: string): Promise<void> {
    const missing = await runtime().missingStorage(id);
    if (missing.length === 0) return;

    this.setStatus(id, 'error');
    log.box(id).error('refusing to start a box whose files are gone', { missing });
    throw new HttpError(
      409,
      `This box cannot start: ${missing.join(' and ')} cannot be found. ` +
        'Restore the files from a backup, or delete the box.',
    );
  }

  /**
   * Starts a stopped box, after its container and isolation are repaired.
   * Waits for whatever else the box is in the middle of.
   */
  async start(id: string): Promise<BoxDetail> {
    return this.withSlot(id, () => this.startHeld(id));
  }

  /** The body of {@link start}, which runs under the box's slot. */
  private async startHeld(id: string): Promise<BoxDetail> {
    await this.bringUp(id);
    this.setStatus(id, 'running');
    // The upstream reconnects on the next forwarded message, which sends
    // session/load again and restores the thread.
    return this.detail(id);
  }

  /**
   * Brings a box up and makes it ready. Runs under the caller's slot.
   *
   * Every path into a box comes through here, so nothing reaches a box
   * before its setup is complete.
   */
  private async bringUp(id: string): Promise<void> {
    this.mustGet(id);
    await this.prepareContainer(id);
    this.giveUpIfPreempted(id);
    if ((await runtime().state(id)) !== 'running') {
      // Taken off before the start, so a crash between the two leaves the box
      // not ready.
      this.db.prepare('UPDATE boxes SET ready_at = NULL WHERE id = ?').run(id);
      await runtime().start(id);
    }
    this.giveUpIfPreempted(id);
    await this.makeReady(this.mustGet(id));
  }

  /**
   * Runs the setup in a started box, unless it is marked ready. A box whose
   * setup fails is marked as an error, with the message.
   *
   * The mark survives a restart of the orchestrator, so a running box is not
   * set up twice.
   */
  private async makeReady(row: BoxRow): Promise<void> {
    if (this.mustGet(row.id).ready_at !== null) return;
    const slog = log.box(row.id);
    const settings = readSettings(this.db);
    try {
      await setUpBox(
        row.id,
        {
          caCertificate: this.egress.caCertificate(),
          identity: { gitName: settings.gitName, gitEmail: settings.gitEmail },
          agentSet: this.agents.pack(row.agent_set_id),
        },
        slog,
      );
    } catch (err) {
      let message = (err as Error).message;
      if (err instanceof OutdatedImageError && this.lastPullError) {
        message += ` The last pull of the box image failed: ${this.lastPullError}`;
      }
      this.setStatus(row.id, 'error');
      slog.error('the box setup failed', { error: message });
      throw new HttpError(409, `This box cannot start: ${message}`);
    }
    this.db.prepare('UPDATE boxes SET ready_at = ? WHERE id = ?').run(Date.now(), row.id);
    slog.info('box ready');
  }

  /**
   * Stops the box and drops the upstream connection.
   *
   * Overtakes what the box is in the middle of rather than queueing behind
   * it. The flag and the upstream's stop are set before the slot is asked
   * for, so the work in flight gives up at its next step.
   */
  async stop(id: string): Promise<BoxDetail> {
    this.preempted.add(id);
    this.upstreams.get(id)?.stop();
    return this.withSlot(id, () => this.stopHeld(id));
  }

  /**
   * Stops a box unless something else is already working on it, and says
   * whether it did.
   *
   * For the reaper, which must never wait. A box with an operation in flight
   * is in use, so the reaper looks at it again on the next tick. The queue
   * is checked and taken in the same synchronous step.
   */
  async stopUnlessBusy(id: string): Promise<boolean> {
    if (this.slots.has(id)) return false;
    await this.stop(id);
    return true;
  }

  /** The body of {@link stop}, which runs under the box's slot. */
  private async stopHeld(id: string): Promise<BoxDetail> {
    // Everything queued before this has given up; what comes after may run.
    this.preempted.delete(id);
    this.mustGet(id);
    // Nothing in a stopped box changes, so the value measured now stays
    // correct until the next start.
    if ((await runtime().state(id)) === 'running') {
      await this.usage.measureNow(id);
    }
    await runtime().stop(id);
    this.setStatus(id, 'stopped');
    log.box(id).info('box stopped');
    return this.detail(id);
  }

  /**
   * Deletes a box and everything it is made of, its storage included.
   * Overtakes what the box is in the middle of, the way a stop does.
   */
  async remove(id: string): Promise<void> {
    this.preempted.add(id);
    this.upstreams.get(id)?.close();
    return this.withSlot(id, () => this.removeHeld(id));
  }

  /** The body of {@link remove}, which runs under the box's slot. */
  private async removeHeld(id: string): Promise<void> {
    this.preempted.delete(id);
    const row = this.mustGet(id);
    // The tombstone goes first. Every writer still in flight checks it, so
    // none of them inserts a row for a box that is going away.
    this.setStatus(id, 'deleted');
    this.upstreams.delete(id);
    await this.teardownResources(id);
    // Every table keyed by the box id. The box row stays as a tombstone.
    for (const table of ['pending_requests', 'threads']) {
      this.db.prepare(`DELETE FROM ${table} WHERE box_id = ?`).run(id);
    }
    log.box(id).info('box deleted', { name: row.name });
  }

  /**
   * Removes a box's container, isolation and storage. Every failure is
   * logged rather than thrown, so teardown always finishes.
   */
  private async teardownResources(id: string): Promise<void> {
    if (!this.getRow(id)) return;
    const slog = log.box(id);
    try {
      await runtime().remove(id);
    } catch (err) {
      slog.warn('container and isolation teardown failed', { error: (err as Error).message });
    }
    try {
      await runtime().removeStorage(id);
    } catch (err) {
      slog.warn('storage removal failed', { error: (err as Error).message });
    }
  }

  // --- views ----------------------------------------------------------------

  /** The stored row for a live box, or a 404. */
  mustGet(id: string): BoxRow {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Box not found');
    return row;
  }

  /**
   * Where a local command should run for this box, starting the box if it
   * is stopped. The workspace root, which is where the adapter runs too.
   *
   * Marks the box active, because everything that asks for this is about
   * to work in the box: a terminal opening a shell, or a review running git.
   */
  async execTarget(id: string): Promise<{ boxId: string; workingDir: string }> {
    return this.withSlot(id, () => this.execTargetHeld(id));
  }

  /** The body of {@link execTarget}, which runs under the box's slot. */
  private async execTargetHeld(id: string): Promise<{ boxId: string; workingDir: string }> {
    await this.bringUp(id);
    this.touch(id);
    return { boxId: id, workingDir: WORKSPACE_DIR };
  }

  /**
   * What a running box takes up on disk, in bytes, as the file service in it
   * measures. It neither starts the box nor marks it active, so a
   * measurement does not keep a box from the reaper.
   */
  private async measureDisk(id: string): Promise<number> {
    this.mustGet(id);
    return fileService(id).size();
  }

  /** Marks a box active, so reaching into the box holds off the reaper. */
  touch(id: string): void {
    touchBox(this.db, id);
  }

  /**
   * Marks a box active, at most once every {@link TOUCH_INTERVAL_MS}.
   *
   * What a terminal calls as its reader types.
   */
  touchThrottled(id: string): void {
    const held = this.terminals.get(id);
    const now = Date.now();
    if (held && now - held.touchedAt < TOUCH_INTERVAL_MS) return;
    if (held) held.touchedAt = now;
    this.touch(id);
  }

  /**
   * Counts one open terminal onto a box, and returns the handle that
   * takes it off again.
   *
   * The count is what the reaper reads, so it has to go up before the box is
   * started rather than once the shell is there: starting takes seconds, and
   * a tick landing inside them must not stop the box being opened.
   */
  holdTerminal(id: string): () => void {
    const held = this.terminals.get(id) ?? { open: 0, touchedAt: 0 };
    held.open++;
    this.terminals.set(id, held);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.terminals.get(id);
      if (!current) return;
      current.open--;
      if (current.open <= 0) this.terminals.delete(id);
    };
  }

  /** How many terminals are open on a box. */
  terminalCount(id: string): number {
    return this.terminals.get(id)?.open ?? 0;
  }

  /**
   * The command lines running in every box that has not been deleted, for
   * the tunnel reconciler. A box that is not running has none. A box whose
   * state or processes cannot be read is reported as null.
   */
  async processReadings(): Promise<BoxReading[]> {
    return Promise.all(
      this.allRows().map(async (row): Promise<BoxReading> => {
        const state = await runtime().state(row.id);
        if (state === 'stopped') return { boxId: row.id, commands: [] };
        if (state !== 'running') return { boxId: row.id, commands: null };
        try {
          const processes = await boxProcesses(row.id);
          return { boxId: row.id, commands: processes.map((p) => p.command) };
        } catch {
          return { boxId: row.id, commands: null };
        }
      }),
    );
  }

  /** Summaries of every live box. */
  async list(): Promise<BoxSummary[]> {
    const rows = this.allRows();
    const counts = this.pending.countsByBox();
    const running = boxesWithActiveTurns(this.db);
    return Promise.all(
      rows.map(async (row) =>
        this.summarize(row, counts.get(row.id) ?? 0, running.has(row.id)),
      ),
    );
  }

  /** Builds a summary, resolving the state against the runtime. */
  private async summarize(
    row: BoxRow,
    pendingCount: number,
    turnActive: boolean,
  ): Promise<BoxSummary> {
    const runtimeState = await runtime().state(row.id);
    if (runtimeState === 'running') this.usage.refresh(row.id, row.disk_measured_at);
    const pendingByThread = this.pending.countsByThread(row.id);
    // The gateway's in-memory view of which threads are speaking and which
    // have tasks running, read once so every thread answers from the same
    // moment. `upstreams.get` rather than `upstream()`, which would create one.
    const upstream = this.upstreams.get(row.id);
    const speaking = new Set(upstream?.speakingThreads ?? []);
    const working = new Set(upstream?.workingThreads ?? []);
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      status: row.status,
      runtimeState,
      // True when any of the box's threads has a turn running.
      turnActive,
      speaking: speaking.size > 0,
      backgroundBusy: upstream?.backgroundActive ?? false,
      backgroundCount: upstream?.backgroundCount ?? 0,
      pendingCount,
      attachedCount: upstream?.attachedCount ?? 0,
      wsToken: row.ws_token,
      threads: listThreads(this.db, row.id).map((thread) =>
        toThreadSummary(
          thread,
          pendingByThread,
          speaking,
          working,
          // Each adapter says for itself whether it can fork. An adapter not
          // yet reached is absent from the set.
          upstream?.forkableHarnesses ?? new Set<HarnessId>(),
        ),
      ),
      agentSetId: row.agent_set_id,
      agentSetName: this.agents.nameOf(row.agent_set_id),
      // What was last measured, and null until there is a measurement.
      diskBytes: row.disk_bytes,
      diskMeasuredAt: row.disk_measured_at,
      tunnels: this.tunnelsOf(row.id),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /** A summary plus the runtime facts the detail view shows. */
  async detail(id: string): Promise<BoxDetail> {
    const row = this.mustGet(id);
    const summary = await this.summarize(
      row,
      this.pending.countForBox(id),
      boxTurnActive(this.db, id),
    );
    return {
      ...summary,
      runtimeDetails: await runtime().details(id),
      acpSessionId: latestThread(this.db, id)?.acp_session_id ?? null,
      isolated: await runtime().isolated(id),
      // `upstreams.get` rather than `upstream()`, which would create one. A
      // box without an upstream has no reading, so the list is empty.
      boxWork: [...(this.upstreams.get(id)?.boxWork ?? [])],
    };
  }

  // --- threads --------------------------------------------------------------

  /** Every conversation of a box, oldest first. */
  threads(id: string): ThreadSummary[] {
    this.mustGet(id);
    const pendingByThread = this.pending.countsByThread(id);
    const forkable = this.upstreams.get(id)?.forkableHarnesses ?? new Set<HarnessId>();
    return listThreads(this.db, id).map((thread) =>
      toThreadSummary(thread, pendingByThread, new Set(), new Set(), forkable),
    );
  }

  /**
   * Whether a thread belongs to a box. The WebSocket upgrade asks before
   * a socket exists, so a path naming another box's thread is a 404
   * rather than a connection that fails later.
   */
  hasThread(boxId: string, threadId: string): boolean {
    const row = getThread(this.db, threadId);
    return row !== undefined && row.box_id === boxId;
  }

  /** One of a box's threads, or a 404 when the box has no such thread. */
  private mustGetThread(id: string, threadId: string): ThreadRow {
    const row = getThread(this.db, threadId);
    if (!row || row.box_id !== id) throw new HttpError(404, THREAD_NOT_FOUND);
    return row;
  }

  /**
   * Adds a conversation to a box: on the agent and
   * settings the body names, or carrying another thread's context when `from`
   * names one.
   *
   * A fork needs the adapter, because only the adapter can branch a
   * transcript. A fresh thread's row is written before its conversation is
   * created, so a harness without a credential still gets a thread.
   */
  async createThread(id: string, body: CreateThreadBody | undefined): Promise<ThreadSummary> {
    this.mustGet(id);
    const from = body?.from?.trim();
    // A fork keeps its source's harness and options, because only the adapter
    // that wrote a transcript can load it.
    const options = from ? undefined : threadOptions(body?.options);
    const up = this.upstream(id);
    try {
      const row = from ? await up.forkThread(from) : await up.newThread(options);
      return toThreadSummary(
        row,
        this.pending.countsByThread(id),
        new Set(),
        new Set(),
        up.forkableHarnesses,
      );
    } catch (err) {
      const message = (err as Error).message;
      if (message === THREAD_NOT_FOUND) throw new HttpError(404, message);
      // A thread never prompted has no conversation to fork yet.
      if (message === NOTHING_TO_FORK) throw new HttpError(409, message);
      throw new HttpError(500, `Failed to create thread: ${message}`);
    }
  }

  /**
   * Marks one of a box's conversations done, or takes the mark off again.
   *
   * The mark is the reader's own note. The thread keeps its conversation, its
   * tasks go on running, and it still answers prompts.
   */
  setThreadDone(id: string, threadId: string, done: boolean): ThreadSummary {
    this.mustGet(id);
    const row = this.mustGetThread(id, threadId);
    setThreadDone(this.db, threadId, done);
    return toThreadSummary(
      { ...row, done: done ? 1 : 0 },
      this.pending.countsByThread(id),
      new Set(),
      new Set(),
      this.upstreams.get(id)?.forkableHarnesses ?? new Set<HarnessId>(),
    );
  }

  /**
   * Stops one task a thread left running, or every task it has.
   *
   * A thread with no adapter conversation has no tasks, so it answers zero.
   */
  async stopBackgroundWork(
    id: string,
    threadId: string,
    taskId?: string,
  ): Promise<{ stopped: number }> {
    this.mustGet(id);
    const row = this.mustGetThread(id, threadId);
    if (!row.acp_session_id) return { stopped: 0 };
    return { stopped: await this.upstream(id).stopBackgroundWork(row.acp_session_id, taskId) };
  }

  /**
   * Kills every process in a box that Boxes did not start itself, whether or
   * not a thread has a task for it.
   *
   * An adapter restart loses the tasks the old process announced, and a
   * signal is the only way to reach the work they left running.
   */
  async stopBoxWork(id: string): Promise<{ stopped: number }> {
    this.mustGet(id);
    return { stopped: await this.upstream(id).stopBoxWork() };
  }

  // --- boot reconciliation --------------------------------------------------

  /**
   * Aligns the stored rows with what the runtime runs: adopts live boxes,
   * marks missing ones stopped, fails a create that was interrupted, and
   * repairs the isolation of every box that runs. Upstream connections are
   * re-established on first use.
   */
  async reconcile(): Promise<void> {
    this.pending.clearStale();
    const live = new Map(
      (await runtime().inventory()).flatMap((obj) =>
        obj.kind === 'box' ? [[obj.boxId, obj] as const] : [],
      ),
    );
    for (const row of this.allRows()) {
      // A turn cannot survive an orchestrator restart, because the upstream
      // connection that owned it is gone.
      clearBoxTurns(this.db, row.id);
      const box = live.get(row.id);
      if (!box) {
        if (row.status === 'running') {
          log.box(row.id).warn('container missing at boot; marking stopped');
          this.setStatus(row.id, 'stopped');
        } else if (row.status === 'creating') {
          // The process that was creating it is gone, so the create cannot finish.
          log.box(row.id).warn('create did not finish before the restart; marking error');
          this.setStatus(row.id, 'error');
        }
        continue;
      }
      this.setStatus(row.id, box.running ? 'running' : 'stopped');
      // A stopped box gets its repair at its next start. A failed repair is
      // retried by the isolation loop, so it does not stop the boot.
      if (!box.running) continue;
      try {
        await this.withSlot(row.id, () => runtime().ensure(this.boxSpec(row.id)));
      } catch (err) {
        log.box(row.id).warn('could not repair the box at boot', { error: (err as Error).message });
      }
    }
    log.info('boot reconciliation complete', { boxes: this.allRows().length });
  }

  /**
   * Repairs the isolation of every running box. Returns the ids of the boxes
   * where that failed.
   *
   * A box with an operation in flight is skipped, so the loop never waits.
   * That operation is a start, which repairs the isolation itself, or a stop
   * or a delete, after which there is nothing to repair. The state is read
   * under the slot, so a box that stopped meanwhile is left alone.
   */
  async reconcileIsolation(): Promise<string[]> {
    const warnings: string[] = [];
    for (const row of this.allRows()) {
      if (row.status !== 'running' || this.slots.has(row.id)) continue;
      const ok = await this.withSlot(row.id, async () => {
        try {
          if ((await runtime().state(row.id)) !== 'running') return true;
          await runtime().ensure(this.boxSpec(row.id));
          return await runtime().isolated(row.id);
        } catch (err) {
          log.box(row.id).warn('could not repair the isolation', { error: (err as Error).message });
          return false;
        }
      });
      if (!ok) warnings.push(row.id);
    }
    return warnings;
  }

  /** Drops every upstream connection, for shutdown. */
  closeAll(): void {
    for (const up of this.upstreams.values()) up.close();
    this.upstreams.clear();
  }

  /** Periodic housekeeping: forgetting the upstreams that hold nothing. */
  maintenance(): void {
    this.dropIdleUpstreams();
  }

  /**
   * Forgets every upstream of a box that is down and holding nothing.
   *
   * The reaper creates an upstream for every running box it checks, and
   * nothing else drops them. An upstream with no browser attached, no request
   * waiting and no adapter connection holds nothing a fresh one could not
   * rebuild.
   *
   * A running box keeps its upstream, because the upstream holds the reading
   * of what runs in the box, which the reaper asks for every tick.
   */
  private dropIdleUpstreams(): void {
    for (const [id, up] of this.upstreams) {
      if (!up.holdsNothing) continue;
      if (this.getRow(id)?.status === 'running') continue;
      up.close();
      this.upstreams.delete(id);
    }
  }
}

/**
 * One stored thread, as the API reports it.
 *
 * The live sets and `pendingByThread` are keyed by the adapter's own id. A
 * thread without one has nothing running, nobody speaking and no request
 * waiting.
 */
function toThreadSummary(
  row: ThreadRow,
  pendingByThread: Map<string, number> = new Map(),
  speaking: ReadonlySet<string> = new Set(),
  working: ReadonlySet<string> = new Set(),
  forkable: ReadonlySet<HarnessId> = new Set(),
): ThreadSummary {
  const acp = row.acp_session_id;
  return {
    id: row.id,
    harness: row.harness,
    acpSessionId: acp,
    title: row.title,
    ordinal: row.ordinal,
    turnActive: row.turn_active === 1,
    // These three come from the live gateway, keyed by the adapter's own id.
    speaking: acp ? speaking.has(acp) : false,
    backgroundBusy: acp ? working.has(acp) : false,
    pendingCount: acp ? (pendingByThread.get(acp) ?? 0) : 0,
    modeId: row.mode_id,
    config: threadConfig(row),
    // False while this thread's adapter has not been reached.
    canFork: forkable.has(row.harness),
    done: row.done === 1,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}


/**
 * What a request asked a thread to be, checked.
 *
 * An absent harness means Claude on its defaults. An unknown harness is a
 * 400. The config map keeps its string values unchecked, because the adapter
 * decides which options a harness offers.
 */
function threadOptions(options: ThreadOptions | undefined): ThreadOptions {
  const wanted = options?.harness ?? DEFAULT_HARNESS;
  try {
    harness(wanted);
  } catch {
    throw new HttpError(400, `Unknown harness: ${String(wanted)}`);
  }
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.config ?? {})) {
    if (typeof value === 'string') config[key] = value;
  }
  return {
    harness: wanted,
    ...(options?.modeId ? { modeId: options.modeId } : {}),
    ...(options?.config ? { config } : {}),
  };
}
