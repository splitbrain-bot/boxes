import { randomBytes } from 'node:crypto';
import {
  type BoxDetail,
  type BoxSummary,
  type BoxTunnel,
  type CreateBoxBody,
  type CreateThreadBody,
  GLOBAL_AGENT_SET,
  type HarnessId,
  type ThreadOptions,
  type ThreadSummary,
} from '../../shared/types.ts';
import type { AgentStore } from './agents.ts';
import { boxEnv } from './boxenv.ts';
import type { Config } from './config.ts';
import {
  type BoxRow,
  boxesWithActiveTurns,
  boxTurnActive,
  clearBoxTurns,
  type Db,
  getThread,
  insertThread,
  latestThread,
  listThreads,
  setThreadDone,
  type ThreadRow,
  threadConfig,
  touchBox,
} from './db.ts';
import { BOX_SIZE_TTL_MS, BoxUsage } from './diskusage.ts';
import type { EgressManager } from './egress.ts';
import { fileService, OutdatedImageError } from './files.ts';
import { PendingStore } from './gateway/pending.ts';
import { NOTHING_TO_FORK, THREAD_NOT_FOUND, UpstreamBox } from './gateway/upstream.ts';
import { DEFAULT_HARNESS, harness } from './harness.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import { LOGIN_CONTAINER_MAX_AGE_MS } from './login.ts';
import type { Notifier } from './notify.ts';
import { boxProcesses } from './processes.ts';
import {
  type BoxSpec,
  type PullEvent,
  type RuntimeObject,
  runtime,
  WORKSPACE_DIR,
} from './runtime/runtime.ts';
import { generateWsToken } from './secret.ts';
import { readSettings } from './settings.ts';
import { setUpBox } from './setup.ts';
import type { BoxReading } from './tunnels.ts';

/**
 * The maximum ratio of stray boxes in the runtime to rows in the boxes table.
 * Above it, the orphan sweep refuses to run.
 *
 * The check catches a database that does not belong to these files, for
 * example a data volume mounted from the wrong place. The check uses a ratio
 * and not an empty table, so one box created with the wrong database does not
 * disable it.
 */
const STRAY_BOX_RATIO = 3;

/**
 * The minimum time between two activity writes from typing in a terminal, in
 * milliseconds.
 *
 * The reaper reads activity in minutes, so a write for each keystroke would not
 * change what the reaper does.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * The manager of the box lifecycle, which also holds every UpstreamBox. The
 * runtime holds the runtime state, and the boxes table holds the metadata.
 */
export class BoxManager {
  /** The gateway connection of each box, created on first use. */
  private readonly upstreams = new Map<string, UpstreamBox>();

  /**
   * One promise chain for each box, so two operations that change the same box
   * do not overlap. Different boxes do not wait for each other. The entry of a
   * box goes when its chain is empty.
   */
  private readonly slots = new Map<string, Promise<unknown>>();

  /**
   * The boxes where a stop or a delete has overtaken the queued operations.
   * Each queued or running operation of such a box gives up at its next step,
   * in {@link giveUpIfPreempted}.
   */
  private readonly preempted = new Set<string>();

  /**
   * The number of open terminals of each box, and the time of the last
   * activity mark from typing.
   *
   * The reaper does not stop a box with an open terminal, the same as a box
   * with an attached browser. The entry goes when the last terminal closes.
   */
  private readonly terminals = new Map<string, { open: number; touchedAt: number }>();

  /** Permission requests waiting for a browser, across all boxes. */
  readonly pending: PendingStore;

  /** The disk usage of each box, which the file service in the box measures. */
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

  /**
   * @param db The database that stores the boxes and their threads.
   * @param cfg The configuration of the deployment.
   * @param egress The egress manager.
   * @param notifier The sender of push notifications.
   * @param agents The store of agent sets.
   * @param tunnelsOf The function that returns the dev tunnel ports of a box.
   */
  constructor(
    /** Where the boxes and their threads are stored. */
    private readonly db: Db,
    /** The deployment's configuration. */
    private readonly cfg: Config,
    /** The egress manager, which gives the policy and the credential placeholders of a box. */
    private readonly egress: EgressManager,
    /** Sends the push notifications a thread raises. */
    private readonly notifier: Notifier,
    /** The agent sets. The app creates the store, so the routes and the lifecycle share it. */
    private readonly agents: AgentStore,
    /** Returns the dev tunnel ports of a box, from the last read of the tunnel reconciler. */
    private readonly tunnelsOf: (boxId: string) => BoxTunnel[] = () => [],
  ) {
    this.pending = new PendingStore(db);
  }

  /**
   * Runs `fn` alone for the box, after the operations already in the queue of
   * the box.
   *
   * A container repair reads the state of the runtime and acts on it a moment
   * later. Start, a local command and the gateway all start repairs, and the
   * reaper can stop a box during each of them. So each operation that changes
   * a box runs alone, in the order of arrival. Reads do not go into the queue.
   * A request for a busy box waits without a timeout, and a rejection does not
   * block the queue.
   *
   * `fn` must not take a slot for the same box again, because it would wait for
   * itself forever. So each queued public method wraps a private form that
   * takes no slot, and the repairs and the teardown call the private forms.
   *
   * @param id The id of the box.
   * @param fn The operation.
   * @returns The result of the operation.
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

  /**
   * Removes the chain of a box when nothing waits on it.
   *
   * @param id The id of the box.
   * @param tail The end of the chain that the caller added.
   */
  private releaseSlot(id: string, tail: Promise<void>): void {
    if (this.slots.get(id) === tail) this.slots.delete(id);
  }

  /**
   * Throws a 409 when a stop or a delete has overtaken the running operation.
   *
   * The check runs between the steps of an operation and not in a step,
   * because a half-created container is worse than one step too many. Each
   * step is short.
   *
   * @param id The id of the box.
   * @throws {HttpError} A 409 when a stop or a delete has overtaken the operation.
   */
  private giveUpIfPreempted(id: string): void {
    if (!this.preempted.has(id)) return;
    throw new HttpError(409, 'This box was stopped while the request was in flight');
  }

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
   * gets the new image at its next start. The manager keeps the error
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
   * Removes the runtime objects of deleted boxes, and the login containers
   * that nothing waits for.
   *
   * reconcile() looks up the runtime objects for each row. This method looks
   * up the row for each object of the inventory. It finds the objects that a
   * crash during a create, or a teardown that failed halfway, left.
   *
   * create() inserts the row before it creates a runtime object, so an object
   * without a live row is never part of a create. The tombstone of a deleted
   * box counts as no row, so the sweep also removes a failed teardown.
   *
   * The sweep removes the objects in the order of the inventory, which is an
   * order that the runtime can remove them in.
   */
  async sweepOrphans(): Promise<void> {
    const inventory = await runtime().inventory();
    // A login belongs to no box, so the rules below do not apply to it.
    await this.sweepLogins(inventory);

    // The rows are read last, so a box created during the inventory read has its
    // row, and its objects are not orphans.
    const live = new Set(this.allRows().map((row) => row.id));
    const strays = inventory.filter(
      (obj): obj is Exclude<RuntimeObject, { kind: 'login' }> =>
        obj.kind !== 'login' && !live.has(obj.boxId),
    );
    const boxes = new Set(strays.map((obj) => obj.boxId));
    if (boxes.size === 0) return;

    // Tombstones count, so a deployment whose boxes were all deleted still
    // gets its failed teardowns swept.
    const known = (this.db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number }).n;
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
   * A login removes its container when the flow ends. A restart during a login
   * leaves the container, with part of a credential in a tmpfs home.
   *
   * Age is the only rule, because a login container has no owner to ask. The
   * cutoff is longer than the ten minutes of a login, so the sweep never
   * removes a running login.
   *
   * @param inventory The runtime objects of the deployment.
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
   * Runs one removal of the sweep. A failure goes to the log and does not stop
   * the sweep. The next sweep tries again.
   *
   * @param boxId The id of the box that the object belonged to.
   * @param what The kind of the object, for the log.
   * @param remove The removal.
   */
  private async sweeping(boxId: string, what: string, remove: () => Promise<void>): Promise<void> {
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

  /**
   * Gives the stored row of a box, also of a deleted box.
   *
   * @param id The id of the box.
   * @returns The row, or undefined when no row has this id.
   */
  getRow(id: string): BoxRow | undefined {
    return this.db.prepare('SELECT * FROM boxes WHERE id = ?').get(id) as BoxRow | undefined;
  }

  /**
   * Gives the row of a box that a user can see and use.
   *
   * @param id The id of the box.
   * @param user The user, or null in single user mode, in which the user sees every box.
   * @returns The row, or undefined when the box does not exist, is deleted, or belongs to another user.
   */
  visibleRow(id: string, user: string | null): BoxRow | undefined {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') return undefined;
    return user === null || row.owner === user ? row : undefined;
  }

  /**
   * Gives the rows of the boxes that are not deleted.
   *
   * @param owner The owner of the boxes, or null for the boxes of every user.
   * @returns The rows, newest first.
   */
  private allRows(owner: string | null = null): BoxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM boxes WHERE status != 'deleted' AND (? IS NULL OR owner = ?)
          ORDER BY created_at DESC`,
      )
      .all(owner, owner) as BoxRow[];
  }

  /**
   * Records a new status, but a deleted box stays deleted. An upstream spawn
   * that still retries after the box was removed reports its result later, and
   * that report must not bring the row back.
   *
   * @param id The id of the box.
   * @param status The new status.
   */
  private setStatus(id: string, status: BoxRow['status']): void {
    this.db
      .prepare("UPDATE boxes SET status = ? WHERE id = ? AND status != 'deleted'")
      .run(status, id);
  }

  /**
   * The data that the runtime needs to create or repair the container of a
   * box. The runtime builds a new box and each recreated container from it.
   *
   * The placeholders are those of the credentials that the owner of the box
   * has stored now. A credential that arrives later reaches a box when its
   * container is created again.
   *
   * @param id The id of the box.
   * @returns The id and the environment of the box.
   */
  private boxSpec(id: string): BoxSpec {
    const { owner } = this.mustGet(id);
    return {
      boxId: id,
      env: boxEnv({
        placeholderFor: (credential) => this.egress.placeholderFor(owner, credential),
        methodFor: (credential) => this.egress.methodFor(owner, credential),
        gitlabHost: this.cfg.GITLAB_HOST,
        proxyUrl: runtime().proxyUrl(),
        hasCa: this.egress.caCertificate() !== '',
        apiKeys: this.egress.apiKeyEnv(owner),
      }),
    };
  }

  /**
   * Gives the persistent upstream of a box, and creates it on first use.
   *
   * @param id The id of the box.
   * @returns The upstream.
   */
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

  /**
   * Creates the storage and the container of a new box. Any failed step
   * tears the whole box down and marks it as an error.
   *
   * @param body The name, the agent set and the first thread of the box.
   * @param owner The user who owns the new box.
   * @returns The detail of the new box.
   * @throws {HttpError} A 400 for a request that is not valid, a 503 when the box image is
   *   not available, or a 500 when a step of the create fails.
   */
  async create(body: CreateBoxBody, owner: string): Promise<BoxDetail> {
    const name = body.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (name.length > 100) throw new HttpError(400, 'name must be 100 characters or fewer');

    // Each box gets the global set of its owner, so a request that names it is
    // the same as a request without a set, and the row stores null.
    const requested = body.agentSet?.trim() ?? '';
    const agentSetId =
      requested === '' ||
      requested === GLOBAL_AGENT_SET ||
      requested === this.agents.globalId(owner)
        ? null
        : requested;
    if (agentSetId && !this.agents.has(owner, agentSetId)) {
      throw new HttpError(400, `Unknown agent set: ${agentSetId}`);
    }

    // The check comes before any allocation, so an unknown harness gets a 400
    // without cost.
    const thread = threadOptions(body.thread);

    // The pull comes after the checks above, so an invalid request pulls no image.
    try {
      await this.ensureBoxImage();
    } catch (err) {
      throw new HttpError(
        503,
        `Box image ${this.cfg.BOX_IMAGE} is not available: ${(err as Error).message}`,
      );
    }

    // The orchestrator makes the id, so user input never gets into the name of a
    // runtime object.
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const row: BoxRow = {
      id,
      name,
      owner,
      // Each box has the DEFAULT profile, because each user has one set of credentials.
      profile: 'DEFAULT',
      // No base revision until the reviewer selects one. By default, a review
      // compares each repository with its own HEAD.
      review_base_rev: null,
      status: 'creating',
      agent_set_id: agentSetId,
      // The box has its own token, which opens only the WebSocket of this box.
      ws_token: generateWsToken(),
      created_at: now,
      last_active_at: now,
      disk_bytes: null,
      disk_measured_at: null,
      ready_at: null,
    };

    this.db
      .prepare(
        `INSERT INTO boxes (id, name, owner, profile, status, agent_set_id,
           ws_token, created_at, last_active_at)
         VALUES (@id, @name, @owner, @profile, @status, @agent_set_id,
           @ws_token, @created_at, @last_active_at)`,
      )
      .run(row);

    const slog = log.box(id);
    try {
      await this.withSlot(id, () => this.createResources(id));
      this.setStatus(id, 'running');
      // The first thread is only a row. The first browser that opens it starts
      // the adapter, so a box can be created for a harness without a stored
      // credential.
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
   * it ready. Runs under the slot of the box.
   *
   * @param id The id of the box.
   */
  private async createResources(id: string): Promise<void> {
    await runtime().createStorage(id);
    const spec = this.boxSpec(id);
    await runtime().ensure(spec);
    await runtime().start(spec);
    await this.makeReady(this.mustGet(id));
  }

  /**
   * Repairs the container and the isolation of a box before the start.
   *
   * Runs under the slot of the caller. A stop or a delete that arrives in the
   * meantime takes effect before the repair.
   *
   * @param id The id of the box.
   */
  private async prepareContainer(id: string): Promise<void> {
    this.giveUpIfPreempted(id);
    // The check comes before anything mounts the storage.
    await this.requireStorage(id);
    this.giveUpIfPreempted(id);
    await runtime().ensure(this.boxSpec(id));
  }

  /**
   * Throws a 409 that names the missing storage when the storage of a box is
   * gone, and marks the box as an error.
   *
   * The method does not create the storage again, because a new home would
   * erase the thread transcripts of the adapter.
   *
   * @param id The id of the box.
   * @throws {HttpError} A 409 when a part of the storage is missing.
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
   * Waits for the other queued operations of the box.
   *
   * @param id The id of the box.
   * @returns The detail of the box.
   */
  async start(id: string): Promise<BoxDetail> {
    return this.withSlot(id, () => this.startHeld(id));
  }

  /**
   * The body of {@link start}, which runs under the slot of the box.
   *
   * @param id The id of the box.
   * @returns The detail of the box.
   */
  private async startHeld(id: string): Promise<BoxDetail> {
    await this.bringUp(id);
    this.setStatus(id, 'running');
    // The upstream reconnects on the next forwarded message, which sends
    // session/load again and restores the thread.
    return this.detail(id);
  }

  /**
   * Starts a box and makes it ready. Runs under the slot of the caller.
   *
   * Each path into a box goes through this method, so nothing reaches a box
   * before its setup is complete.
   *
   * @param id The id of the box.
   */
  private async bringUp(id: string): Promise<void> {
    this.mustGet(id);
    await this.prepareContainer(id);
    this.giveUpIfPreempted(id);
    if ((await runtime().state(id)) !== 'running') {
      // The ready mark goes before the start, so a crash between the two leaves
      // the box not ready.
      this.db.prepare('UPDATE boxes SET ready_at = NULL WHERE id = ?').run(id);
      await runtime().start(this.boxSpec(id));
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
   *
   * @param row The row of the box.
   * @throws {HttpError} A 409 when the setup fails.
   */
  private async makeReady(row: BoxRow): Promise<void> {
    if (this.mustGet(row.id).ready_at !== null) return;
    const slog = log.box(row.id);
    const settings = readSettings(this.db, row.owner);
    try {
      await setUpBox(
        row.id,
        {
          caCertificate: this.egress.caCertificate(),
          identity: { gitName: settings.gitName, gitEmail: settings.gitEmail },
          agentSet: this.agents.pack(row.owner, row.agent_set_id),
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
   * The stop overtakes the running operation of the box and does not wait in
   * the queue. The method sets the flag and stops the upstream before it asks
   * for the slot, so the running work gives up at its next step.
   *
   * @param id The id of the box.
   * @returns The detail of the box.
   */
  async stop(id: string): Promise<BoxDetail> {
    this.preempted.add(id);
    this.upstreams.get(id)?.stop();
    return this.withSlot(id, () => this.stopHeld(id));
  }

  /**
   * Stops a box when no other operation runs on it, and returns true when it
   * stopped the box.
   *
   * The reaper uses this method, because it must never wait. A box with a
   * running operation is in use, so the reaper checks it again at the next
   * tick. The check and the slot request happen in the same synchronous step.
   *
   * @param id The id of the box.
   * @returns True when the method stopped the box.
   */
  async stopUnlessBusy(id: string): Promise<boolean> {
    if (this.slots.has(id)) return false;
    await this.stop(id);
    return true;
  }

  /**
   * The body of {@link stop}, which runs under the slot of the box.
   *
   * @param id The id of the box.
   * @returns The detail of the box.
   */
  private async stopHeld(id: string): Promise<BoxDetail> {
    // Each operation queued before this one gave up. Later operations can run.
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
   * Deletes a box with all its parts, also its storage. Like a stop, it
   * overtakes the running operation of the box.
   *
   * @param id The id of the box.
   */
  async remove(id: string): Promise<void> {
    this.preempted.add(id);
    this.upstreams.get(id)?.close();
    return this.withSlot(id, () => this.removeHeld(id));
  }

  /**
   * The body of {@link remove}, which runs under the slot of the box.
   *
   * @param id The id of the box.
   */
  private async removeHeld(id: string): Promise<void> {
    this.preempted.delete(id);
    const row = this.mustGet(id);
    // The tombstone goes first. Each writer that still runs checks it, so no
    // writer inserts a row for the deleted box.
    this.setStatus(id, 'deleted');
    this.upstreams.delete(id);
    await this.teardownResources(id);
    // The threads and the pending requests go. The box row stays as a tombstone.
    for (const table of ['pending_requests', 'threads']) {
      this.db.prepare(`DELETE FROM ${table} WHERE box_id = ?`).run(id);
    }
    log.box(id).info('box deleted', { name: row.name });
  }

  /**
   * Removes the container, the isolation and the storage of a box. Each
   * failure goes to the log and is not thrown, so the teardown always finishes.
   *
   * @param id The id of the box.
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

  /**
   * Gives the stored row of a box that is not deleted.
   *
   * @param id The id of the box.
   * @returns The row.
   * @throws {HttpError} A 404 when the box does not exist or is deleted.
   */
  mustGet(id: string): BoxRow {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Box not found');
    return row;
  }

  /**
   * The place for a local command of this box, which is the workspace root,
   * where the adapter also runs. The method starts a stopped box.
   *
   * It marks the box active, because each caller is about to work in the box,
   * for example a terminal that opens a shell, or a review that runs git.
   *
   * @param id The id of the box.
   * @returns The id of the box and the working directory in the box.
   */
  async execTarget(id: string): Promise<{ boxId: string; workingDir: string }> {
    return this.withSlot(id, () => this.execTargetHeld(id));
  }

  /**
   * The body of {@link execTarget}, which runs under the slot of the box.
   *
   * @param id The id of the box.
   * @returns The id of the box and the working directory in the box.
   */
  private async execTargetHeld(id: string): Promise<{ boxId: string; workingDir: string }> {
    await this.bringUp(id);
    this.touch(id);
    return { boxId: id, workingDir: WORKSPACE_DIR };
  }

  /**
   * The disk usage of a running box in bytes, from the file service in the
   * box. The method does not start the box or mark it active, so a measurement
   * does not keep the reaper from a box.
   *
   * @param id The id of the box.
   * @returns The size in bytes.
   */
  private async measureDisk(id: string): Promise<number> {
    this.mustGet(id);
    return fileService(id).size();
  }

  /**
   * Marks a box active, which delays the reaper.
   *
   * @param id The id of the box.
   */
  touch(id: string): void {
    touchBox(this.db, id);
  }

  /**
   * Marks a box active, at most once in each {@link TOUCH_INTERVAL_MS}.
   *
   * The terminal calls this method when the user types, and it holds a terminal
   * of the box during the call. The throttle keeps its time in that terminal
   * entry, so a box without an open terminal gets a mark on each call.
   *
   * @param id The id of the box.
   */
  touchThrottled(id: string): void {
    const held = this.terminals.get(id);
    const now = Date.now();
    if (held && now - held.touchedAt < TOUCH_INTERVAL_MS) return;
    if (held) held.touchedAt = now;
    this.touch(id);
  }

  /**
   * Adds one open terminal to the count of a box, and returns the function that
   * removes it again.
   *
   * The reaper reads the count, so the count must go up before the box starts
   * and not when the shell is there. A start takes seconds, and a reaper tick
   * in that time must not stop the box that opens.
   *
   * @param id The id of the box.
   * @returns The function that removes the terminal from the count. A second call does nothing.
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

  /**
   * Gives the number of open terminals of a box.
   *
   * @param id The id of the box.
   * @returns The number of open terminals.
   */
  terminalCount(id: string): number {
    return this.terminals.get(id)?.open ?? 0;
  }

  /**
   * The command lines running in each box of the given owners that has not
   * been deleted, for the tunnel reconciler. A box that is not running has
   * none. A box whose state or processes cannot be read is reported as null.
   *
   * @param owners The owners whose boxes to read.
   * @returns The reading of each box.
   */
  async processReadings(owners: ReadonlySet<string>): Promise<BoxReading[]> {
    const rows = this.allRows().filter((row) => owners.has(row.owner));
    return Promise.all(
      rows.map(async (row): Promise<BoxReading> => {
        const state = await runtime().state(row.id);
        const reading = { boxId: row.id, owner: row.owner };
        if (state === 'stopped') return { ...reading, commands: [] };
        if (state !== 'running') return { ...reading, commands: null };
        try {
          const processes = await boxProcesses(row.id);
          return { ...reading, commands: processes.map((p) => p.command) };
        } catch {
          return { ...reading, commands: null };
        }
      }),
    );
  }

  /**
   * Lists the boxes that are not deleted.
   *
   * @param owner The owner of the boxes, or null for the boxes of every user.
   * @returns The summary of each box, newest first.
   */
  async list(owner: string | null): Promise<BoxSummary[]> {
    const rows = this.allRows(owner);
    const counts = this.pending.countsByBox();
    const running = boxesWithActiveTurns(this.db);
    return Promise.all(
      rows.map(async (row) => this.summarize(row, counts.get(row.id) ?? 0, running.has(row.id))),
    );
  }

  /**
   * Builds the summary of a box, with the state from the runtime.
   *
   * @param row The row of the box.
   * @param pendingCount The number of waiting permission requests of the box.
   * @param turnActive True when a thread of the box has a running turn.
   * @returns The summary.
   */
  private async summarize(
    row: BoxRow,
    pendingCount: number,
    turnActive: boolean,
  ): Promise<BoxSummary> {
    const runtimeState = await runtime().state(row.id);
    if (runtimeState === 'running') this.usage.refresh(row.id, row.disk_measured_at);
    const pendingByThread = this.pending.countsByThread(row.id);
    // The gateway holds the speaking threads and the threads with running tasks
    // in memory. The code reads them once, so all threads use the same moment.
    // `upstreams.get` does not create an upstream, but `upstream()` would.
    const upstream = this.upstreams.get(row.id);
    const speaking = new Set(upstream?.speakingThreads ?? []);
    const working = new Set(upstream?.workingThreads ?? []);
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      status: row.status,
      runtimeState,
      // True when a thread of the box has a running turn.
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
          // Each adapter tells if it can fork. An adapter that was not reached yet
          // is not in the set.
          upstream?.forkableHarnesses ?? new Set<HarnessId>(),
        ),
      ),
      agentSetId: row.agent_set_id,
      agentSetName: this.agents.nameOf(row.agent_set_id),
      // The last measurement, or null until there is one.
      diskBytes: row.disk_bytes,
      diskMeasuredAt: row.disk_measured_at,
      tunnels: this.tunnelsOf(row.id),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /**
   * Builds the summary of a box with the runtime facts for the detail view.
   *
   * @param id The id of the box.
   * @returns The detail.
   * @throws {HttpError} A 404 when the box does not exist or is deleted.
   */
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
      // `upstreams.get` does not create an upstream. A box without an upstream
      // has no reading, so the list is empty.
      boxWork: [...(this.upstreams.get(id)?.boxWork ?? [])],
    };
  }

  /**
   * Lists the threads of a box.
   *
   * @param id The id of the box.
   * @returns The summary of each thread, oldest first.
   * @throws {HttpError} A 404 when the box does not exist or is deleted.
   */
  threads(id: string): ThreadSummary[] {
    this.mustGet(id);
    const pendingByThread = this.pending.countsByThread(id);
    const forkable = this.upstreams.get(id)?.forkableHarnesses ?? new Set<HarnessId>();
    return listThreads(this.db, id).map((thread) =>
      toThreadSummary(thread, pendingByThread, new Set(), new Set(), forkable),
    );
  }

  /**
   * Checks if a thread belongs to a box. The WebSocket upgrade calls it before
   * a socket exists, so a path with the thread of another box gets a 404 and
   * not a connection that fails later.
   *
   * @param boxId The id of the box.
   * @param threadId The id of the thread.
   * @returns True when the thread belongs to the box.
   */
  hasThread(boxId: string, threadId: string): boolean {
    const row = getThread(this.db, threadId);
    return row !== undefined && row.box_id === boxId;
  }

  /**
   * Gives the row of one thread of a box.
   *
   * @param id The id of the box.
   * @param threadId The id of the thread.
   * @returns The row of the thread.
   * @throws {HttpError} A 404 when the box has no such thread.
   */
  private mustGetThread(id: string, threadId: string): ThreadRow {
    const row = getThread(this.db, threadId);
    if (!row || row.box_id !== id) throw new HttpError(404, THREAD_NOT_FOUND);
    return row;
  }

  /**
   * Adds a thread to a box, with the harness and the settings in the body, or
   * with the context of the thread that `from` names.
   *
   * A fork needs the adapter, because only the adapter can branch a
   * transcript. The row of a new thread is written before its adapter session,
   * so a harness without a credential still gets a thread.
   *
   * @param id The id of the box.
   * @param body The options of the new thread, or the thread to fork.
   * @returns The summary of the new thread.
   * @throws {HttpError} A 404 for an unknown box or source thread, a 409 for a source
   *   without a session, a 400 for an unknown harness, or a 500 when the adapter fails.
   */
  async createThread(id: string, body: CreateThreadBody | undefined): Promise<ThreadSummary> {
    this.mustGet(id);
    const from = body?.from?.trim();
    // A fork keeps the harness and the options of its source, because only the
    // adapter that wrote a transcript can load it.
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
      // A thread without a prompt has no session to fork yet.
      if (message === NOTHING_TO_FORK) throw new HttpError(409, message);
      throw new HttpError(500, `Failed to create thread: ${message}`);
    }
  }

  /**
   * Marks one thread of a box done, or removes the mark.
   *
   * The mark is a note of the user. The thread keeps its session, its tasks
   * continue to run, and it still answers prompts.
   *
   * @param id The id of the box.
   * @param threadId The id of the thread.
   * @param done True to set the mark, false to remove it.
   * @returns The summary of the thread.
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
   * Stops one background task of a thread, or every task of the thread.
   *
   * A thread without an adapter session has no tasks, so the answer is zero.
   *
   * @param id The id of the box.
   * @param threadId The id of the thread.
   * @param taskId The id of the task in the adapter. Without it, every task of the thread stops.
   * @returns The number of tasks that the adapter stopped.
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
   * Kills every process in a box that Boxes did not start, with or without a
   * task of a thread.
   *
   * An adapter restart loses the tasks that the old process announced. A signal
   * is the only way to reach the work of those tasks.
   *
   * @param id The id of the box.
   * @returns The number of processes that got a signal.
   */
  async stopBoxWork(id: string): Promise<{ stopped: number }> {
    this.mustGet(id);
    return { stopped: await this.upstream(id).stopBoxWork() };
  }

  /**
   * Aligns the stored rows with the runtime. The method adopts live boxes,
   * marks missing boxes stopped, marks an interrupted create as an error, and
   * repairs the isolation of each running box. Upstream connections are made
   * again on first use.
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
      // A stopped box gets its repair at its next start. The isolation loop
      // retries a failed repair, so it does not stop the boot.
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
   * Repairs the isolation of every running box.
   *
   * The loop skips a box with a running operation, so it never waits. The
   * running operation is a start, which repairs the isolation, or a stop or a
   * delete, after which nothing needs a repair. The state is read under the
   * slot, so a box that stopped in the meantime stays as it is.
   *
   * @returns The ids of the boxes where the repair failed.
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

  /** Runs the periodic housekeeping, which removes the upstreams that hold nothing. */
  maintenance(): void {
    this.dropIdleUpstreams();
  }

  /**
   * Removes each upstream that holds nothing, when its box is not running.
   *
   * The reaper creates an upstream for each running box that it checks, and
   * nothing else removes them. An upstream without an attached browser, a
   * waiting request or an adapter connection holds nothing that a new upstream
   * cannot build again.
   *
   * A running box keeps its upstream, because the upstream holds the process
   * reading of the box, and the reaper asks for it at each tick.
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
 * Converts one stored thread to the form that the API reports.
 *
 * The live sets and `pendingByThread` use the session id of the adapter as
 * key. A thread without a session id has no running task, no speech and no
 * waiting request.
 *
 * @param row The stored thread.
 * @param pendingByThread The number of waiting requests, by session id.
 * @param speaking The session ids of the threads that speak now.
 * @param working The session ids of the threads with running tasks.
 * @param forkable The harnesses whose adapter can fork.
 * @returns The summary of the thread.
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
    speaking: acp ? speaking.has(acp) : false,
    backgroundBusy: acp ? working.has(acp) : false,
    pendingCount: acp ? (pendingByThread.get(acp) ?? 0) : 0,
    modeId: row.mode_id,
    config: threadConfig(row),
    // False until the adapter of this thread is reached.
    canFork: forkable.has(row.harness),
    done: row.done === 1,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

/**
 * Checks the thread options of a request.
 *
 * An absent harness means Claude. An unknown harness is a 400. The config map
 * keeps only its string values and does not check them, because the adapter
 * decides which options a harness offers.
 *
 * @param options The options from the request.
 * @returns The checked options.
 * @throws {HttpError} A 400 for an unknown harness.
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
