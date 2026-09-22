import { randomBytes } from 'node:crypto';
import {
  GLOBAL_AGENT_SET,
  type CreateBoxBody,
  type CreateThreadBody,
  type HarnessId,
  type BoxDetail,
  type BoxSummary,
  type ThreadOptions,
  type ThreadSummary,
} from '../../shared/types.ts';
import { AgentStore, ensureAgentsRoot, hostAgentConfigPath } from './agents.ts';
import type { Config } from './config.ts';
import type { EgressManager } from './egress.ts';
import {
  clearBoxTurns,
  currentThread,
  getThread,
  insertThread,
  listThreads,
  nextSubnetIndex,
  boxTurnActive,
  boxesWithActiveTurns,
  setThreadDone,
  threadConfig,
  takenSubnets,
  touchBox,
  type Db,
  type BoxRow,
  type ThreadRow,
} from './db.ts';
import { BoxUsage, BOX_SIZE_TTL_MS } from './diskusage.ts';
import * as dk from './docker.ts';
import { DEFAULT_HARNESS, harness } from './harness.ts';
import { HttpError } from './http-error.ts';
import { LOGIN_CONTAINER_MAX_AGE_MS } from './login.ts';
import { log } from './log.ts';
import type { Notifier } from './notify.ts';
import { generateWsToken } from './secret.ts';
import { readSettings } from './settings.ts';
import * as ws from './workspaces.ts';
import { PendingStore } from './gateway/pending.ts';
import { NOTHING_TO_FORK, THREAD_NOT_FOUND, UpstreamBox } from './gateway/upstream.ts';
import { allocateSubnet } from './subnet.ts';

/**
 * Box lifecycle and the owner of every UpstreamBox. Docker is the
 * runtime truth; the boxes table is metadata.
 */

/**
 * How many times more boxes the host may hold than the database knows of
 * before the orphan sweep refuses to run.
 *
 * The case worth catching is a database that does not belong to these files —
 * a data volume mounted from the wrong place, or replaced — where the host is
 * full of boxes and the table knows almost none of them. One box
 * created against the wrong database must not disarm that, so the guard is a
 * ratio rather than an empty table; an empty table falls under the same rule,
 * because any stray at all outnumbers nothing.
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

/** Creates, starts, stops and describes boxes. */
export class BoxManager {
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

  /** How big each box has got, measured off the request path. */
  private readonly usage = new BoxUsage({
    // Everything a box is on disk. A box still backed by a named
    // home volume contributes only its workspace, there being no path to the
    // other half.
    pathsOf: (id) => [this.workspacePathOf(id), this.homePathOf(id)],
    ttlMs: BOX_SIZE_TTL_MS,
    onTrouble: (id, error) =>
      log.box(id).warn('could not measure what a box is using', {
        error: error.message,
      }),
  });

  /**
   * Host-side path of DATA_DIR, which is what a workspace bind source has to
   * name. Starts as this process's own path — the truth outside a container,
   * where `npm run dev` and the tests run — and is replaced at boot by
   * resolveHostDataDir().
   */
  private hostDataDir: string;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly egress: EgressManager,
    /** Where "a thread wants you" goes; see notify.ts. */
    private readonly notifier: Notifier,
    /**
     * The AGENTS.md, skills and commands a box is given. Owned by the app
     * so the REST routes and the lifecycle share one, since editing a set and
     * starting a box are two halves of the same feature.
     */
    private readonly agents: AgentStore,
  ) {
    this.pending = new PendingStore(db);
    this.hostDataDir = cfg.HOST_DATA_DIR || cfg.DATA_DIR;
  }

  // --- one operation per box at a time -----------------------------------
  //
  // Repairing a container is check-then-act: the daemon is asked what it has,
  // and the answer is acted on a moment later. Three paths reach those
  // repairs — start, a local command, and the gateway opening a thread on a
  // stopped box — and the reaper stops boxes under all of them. Two of
  // them at once would have one remove the container the other is about to
  // exec into. So every operation that changes a box runs alone, in the
  // order it arrived; reads are not queued.

  /**
   * Runs `fn` with the box to itself, after whatever is already queued
   * for it.
   *
   * A plain promise chain rather than a mutex library: the queue is per
   * box, and a rejection must not wedge it — hence the catch on the
   * stored tail. A request for a busy box waits; it is not refused and
   * there is no timeout that gives up on it.
   *
   * Nothing `fn` calls may take a slot for the same box again, or it
   * would wait for itself forever. That is why each queued method here is a
   * thin wrapper around a private form that takes no slot of its own: the
   * repairs and the teardown call those, and only a public entry point ever
   * calls this.
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

  // --- workspaces -----------------------------------------------------------

  /**
   * Resolves the host-side path of DATA_DIR, once, at boot.
   *
   * Inside a container the orchestrator's own path for its data volume is not
   * the path the daemon would resolve a bind source against, and getting this
   * wrong is silent: the daemon would happily create an empty directory at
   * that path on the host and mount that instead, leaving the agent's files
   * somewhere the orchestrator cannot see. So a failure here is fatal, and
   * says which setting fixes it.
   */
  async resolveHostDataDir(): Promise<void> {
    ws.ensureWorkspacesRoot(this.cfg.DATA_DIR);
    ensureAgentsRoot(this.cfg.DATA_DIR);
    if (this.cfg.HOST_DATA_DIR) {
      log.info('using the configured host path for the data directory', {
        hostDataDir: this.hostDataDir,
      });
      return;
    }
    if (!dk.inContainer()) return;
    const source = await dk.resolveHostMountSource(this.cfg.DATA_DIR);
    if (!source) {
      throw new Error(
        `Could not resolve the host-side path of ${this.cfg.DATA_DIR}: this process is in a ` +
          'container but has no mount there, or its own container could not be identified. ' +
          'Mount the data directory, or set HOST_DATA_DIR to the path the Docker daemon knows it by.',
      );
    }
    this.hostDataDir = source;
    log.info('resolved the host path of the data directory', { hostDataDir: source });
  }

  /**
   * Where a box's files are on this process's own filesystem, or null for
   * a box still backed by a named volume.
   *
   * Derived from the current DATA_DIR rather than read from the row, so moving
   * the data volume moves the workspaces with it; the stored column says only
   * whether the box has a directory. An unknown or deleted box is
   * null as well, and the caller answers that with its own 404.
   */
  workspacePathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted' || !row.workspace_dir) return null;
    return ws.workspacePath(this.cfg.DATA_DIR, row.id);
  }

  /**
   * Where a box's home is on this process's own filesystem, on the same
   * terms as its workspace, and null for one still backed by a named volume.
   */
  homePathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted' || !row.home_dir) return null;
    return ws.homePath(this.cfg.DATA_DIR, row.id);
  }

  // --- the box image ----------------------------------------------------

  /**
   * Makes sure the box image is on this host, pulling it when it is not.
   *
   * Absent, there is nothing to create a box out of, so this is the one
   * pull that is allowed to fail loudly. Present, it costs one inspect and
   * says nothing.
   */
  async ensureBoxImage(): Promise<void> {
    if (!(await dk.imageId(this.cfg.BOX_IMAGE))) {
      log.info('the box image is not on this host; pulling it', {
        image: this.cfg.BOX_IMAGE,
      });
      await dk.pullImage(this.cfg.BOX_IMAGE);
      log.info('pulled the box image', { image: this.cfg.BOX_IMAGE });
    }
    await this.warnOnBoxUidDrift();
  }

  /**
   * Says so when the box image was built on a different uid than
   * BOX_UID.
   *
   * A container can be run as any uid, so the workspace bind is fine either
   * way. The home volume is not: Docker initialises a new one from the image's
   * own `/home/agent`, so it arrives owned by the uid the image was built on,
   * and nothing outside the container can chown it afterwards. Mismatched,
   * the agent cannot write its own home and every turn fails.
   *
   * A warning and not a refusal: the image is the deployment's to fix, the
   * rest of the orchestrator works, and reviewing an existing box does not
   * need a container at all.
   */
  private async warnOnBoxUidDrift(): Promise<void> {
    let imageUid: number | null;
    try {
      imageUid = await dk.imageUserUid(this.cfg.BOX_IMAGE);
    } catch (err) {
      log.warn('could not read the box image user', { error: (err as Error).message });
      return;
    }
    if (imageUid === null || imageUid === this.cfg.BOX_UID) return;
    log.warn(
      'the box image was built on a different uid than BOX_UID; ' +
        "a box's home volume will not be writable by the agent",
      {
        image: this.cfg.BOX_IMAGE,
        imageUid,
        boxUid: this.cfg.BOX_UID,
      },
    );
  }

  /**
   * Pulls the box image again, so a moving tag moves here.
   *
   * Best-effort: the image already on the host still works. Nothing running
   * is touched, and a box adopts what arrived the next time it is
   * started.
   */
  async refreshBoxImage(): Promise<void> {
    const before = await dk.imageId(this.cfg.BOX_IMAGE);
    await dk.pullImage(this.cfg.BOX_IMAGE);
    const after = await dk.imageId(this.cfg.BOX_IMAGE);
    if (after && after !== before) {
      log.info('the box image moved; boxes adopt it as they are started', {
        image: this.cfg.BOX_IMAGE,
      });
      // The copy it moved off is now untagged, on this host, and a gigabyte
      // or two that nothing else reclaims.
      await this.pruneSupersededImages(before);
    }
  }

  /**
   * Removes copies of the box image that a pull has superseded.
   *
   * Called after a refresh that moved the tag, which is the only thing that
   * makes one. `supersededId` is the image the pull replaced, known exactly
   * because this process watched it happen; the sweep alongside it catches
   * the ones an earlier process replaced and did not live to clean up, which
   * the image's own label makes possible.
   *
   * Nothing here is forced. An image a container was created from is refused
   * by the daemon, and that refusal is what makes this safe to run while
   * boxes exist: a box that has not been started since the tag moved is
   * still on the old image, and start recreates it onto the new one. The
   * image goes on a later sweep.
   */
  private async pruneSupersededImages(supersededId: string | null): Promise<void> {
    if (!this.cfg.BOX_IMAGE_PRUNE) return;
    const current = await dk.imageId(this.cfg.BOX_IMAGE);
    const candidates = new Set(await dk.listSupersededBoxImages());
    // A deployment building its own box image without the label has no
    // superseded copy this can find later. The one this process just replaced
    // is known outright.
    if (supersededId) candidates.add(supersededId);
    candidates.delete(current ?? '');

    for (const id of candidates) {
      try {
        if (await dk.removeImage(id)) {
          log.info('removed a superseded box image', { image: id });
        }
      } catch (err) {
        log.warn('could not remove a superseded box image', {
          image: id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Removes Docker objects and workspace directories belonging to boxes
   * that no longer exist.
   *
   * Everything Boxes creates is labelled with its box, and reconcile()
   * reads that one way only: for each row, what Docker has. This reads it the
   * other way, and so finds what a crash between `docker create` and the
   * row's own update, or a teardown that failed halfway, left behind.
   *
   * The rule is exact rather than heuristic because of the order create()
   * works in: the row is inserted before any Docker object exists, so an
   * object labelled with a box that has no live row cannot be one on its
   * way up. A deleted box's tombstone counts as no row, which is what
   * makes a failed teardown recoverable.
   *
   * Ordering matters: a network with a container still on it, or a volume
   * still mounted into one, is refused. Containers go first.
   */
  async sweepOrphans(): Promise<void> {
    // First, and whatever the rest of this decides: a login container belongs
    // to no box at all, so none of the reasoning below reaches it.
    await this.sweepLoginContainers();

    const containers = await dk.listBoxContainers();
    const networks = await dk.listBoxNetworks();
    const volumes = await dk.listBoxVolumes();
    // The files are read separately, because a teardown removes the Docker
    // objects first: a box it gave up on halfway has nothing left to find
    // it by except the two directories it wrote.
    const directories = ws.boxDirectoryIds(this.cfg.DATA_DIR);
    // Last, after everything it is matched against: create() inserts the row
    // before it makes anything, so a box created while the readings
    // above were running has its row by now, and its network, workspace and
    // home are not orphans.
    const live = new Set(this.allRows().map((row) => row.id));
    const orphaned = <T extends { boxId: string }>(all: T[]): T[] =>
      all.filter((o) => !live.has(o.boxId));
    const strayContainers = orphaned(containers);
    const strayNetworks = orphaned(networks);
    const strayVolumes = orphaned(volumes);
    const strayDirectories = directories.filter((id) => !live.has(id));

    const strays = [...strayContainers, ...strayNetworks, ...strayVolumes];
    const boxes = new Set([...strays.map((o) => o.boxId), ...strayDirectories]);
    if (boxes.size === 0) return;

    // A host holding far more boxes than this database knows of is
    // likelier to be a database these objects do not belong to than a genuine
    // pile of orphans: a data volume mounted from the wrong place, or
    // replaced, leaves exactly that, and sweeping would take every box's
    // home.
    //
    // Deleted boxes are counted, tombstones and all, so a deployment whose
    // boxes have all been deleted still has rows and still gets its failed
    // teardowns swept.
    const known = (
      this.db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number }
    ).n;
    if (boxes.size > known * STRAY_BOX_RATIO) {
      log.warn('not sweeping: the host holds far more boxes than this database knows of', {
        strays: boxes.size,
        known,
        ratio: STRAY_BOX_RATIO,
        boxes: [...boxes],
        containers: strayContainers.length,
        networks: strayNetworks.length,
        volumes: strayVolumes.length,
        directories: strayDirectories.length,
      });
      return;
    }

    log.info('sweeping what is left of boxes that are gone', { boxes: [...boxes] });
    for (const container of strayContainers) {
      await this.sweeping(container.boxId, 'container', () =>
        dk.removeContainer(container.id),
      );
    }
    for (const network of strayNetworks) {
      await this.sweeping(network.boxId, 'network', () =>
        dk.removeNetwork(network.name, this.cfg),
      );
    }
    for (const volume of strayVolumes) {
      await this.sweeping(volume.boxId, 'volume', () => dk.removeVolume(volume.name));
    }
    // And the files, which are the size of all of the above put together.
    // The workspace and home of a box with no row are reachable from
    // nothing Boxes has.
    for (const boxId of boxes) {
      await this.sweeping(boxId, 'workspace', () =>
        Promise.resolve(ws.removeWorkspace(this.cfg.DATA_DIR, boxId)),
      );
      await this.sweeping(boxId, 'home', () =>
        Promise.resolve(ws.removeHome(this.cfg.DATA_DIR, boxId)),
      );
    }
  }

  /**
   * Removes login containers that nothing is waiting on.
   *
   * A login runs the harness's own CLI in a container of its own and removes
   * it when the flow ends, but a flow only ends while the orchestrator is
   * alive to end it: a restart mid-login leaves a container holding a tmpfs
   * home with half a credential in it, on the default bridge, forever.
   *
   * Age is the whole rule, because a login container has no other owner to
   * ask about. The cutoff is longer than the ten minutes a flow is allowed to
   * take, so a person still in a browser is never swept out from under. A
   * container whose creation time cannot be read is treated as old, which is
   * the safe direction: the thing it might interrupt lives for minutes.
   */
  private async sweepLoginContainers(): Promise<void> {
    const cutoff = Date.now() - LOGIN_CONTAINER_MAX_AGE_MS;
    let containers: Awaited<ReturnType<typeof dk.listLoginContainers>>;
    try {
      containers = await dk.listLoginContainers();
    } catch (err) {
      log.warn('could not list login containers', { error: (err as Error).message });
      return;
    }
    for (const container of containers) {
      if (container.createdAt > cutoff) continue;
      try {
        await dk.removeContainer(container.id);
        log.info('swept an abandoned login container', {
          credential: container.credentialId,
          container: container.id,
        });
      } catch (err) {
        log.warn('could not sweep an abandoned login container', {
          container: container.id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Runs one removal of the sweep, keeping the rest going when it fails.
   *
   * A stray object that cannot be removed is worth a line and nothing more:
   * whatever is holding it will let go eventually, and the next sweep tries
   * again.
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

  /**
   * Rebuilds a box's container when Docker no longer has the one the row
   * names, and returns the row as it now stands.
   *
   * Everything a box container is comes from the row and the two
   * directories the row points at — the image, the network, the mounts, the
   * environment — so a container is reproducible and losing one costs nothing
   * durable.
   *
   * A container goes missing more easily than it sounds. `docker container
   * prune` takes every stopped container, and an idle box is a
   * stopped container, since the reaper stops them all day. `docker system
   * prune` does that and the network too, which is why this makes the network
   * again as well.
   *
   * Only for a container the daemon says is not there. `unknown` is a daemon
   * that would not answer, and rebuilding on that would replace a container
   * running perfectly well behind a failed inspect.
   *
   * A box still on a workspace volume is left to `migrateWorkspace`,
   * which runs before this and rebuilds the container itself. Its row has no
   * workspace directory to bind, so `containerSpec` cannot describe it.
   */
  private async restoreMissingContainer(row: BoxRow): Promise<BoxRow> {
    if (!row.container_id || !row.workspace_dir) return row;
    if ((await dk.containerState(row.container_id)) !== 'missing') return row;

    const slog = log.box(row.id);
    slog.warn('the container is gone; rebuilding it from the box row', {
      container: row.container_id,
    });
    // The network goes at the same moment the container does, under any prune
    // that takes both, and a container cannot be created into one that is not
    // there.
    if (await dk.ensureNetwork(row.network_name, row.subnet, row.id)) {
      slog.info('the box network was gone too; made it again', {
        network: row.network_name,
        subnet: row.subnet,
      });
    }
    const containerId = await this.recreateContainer(row);
    this.db
      .prepare('UPDATE boxes SET container_id = ? WHERE id = ?')
      .run(containerId, row.id);
    slog.info('rebuilt the container', { container: containerId });
    return this.mustGet(row.id);
  }

  /**
   * Moves a box onto the current box image, when what its container
   * was created from is no longer what BOX_IMAGE resolves to.
   *
   * Recreating is how a box container changes anything about itself —
   * migrateWorkspace does the same for its mount — and it is cheap: the
   * rootfs is read-only and everything durable lives in the two mounts, so
   * the workspace and the adapter's thread history come across untouched.
   *
   * Start is the only moment this can happen. Under a running container it
   * would kill the adapter exec mid-turn, so a running box is left alone
   * and comes through here at its next stop/start cycle — which the idle
   * reaper produces on its own within IDLE_STOP_MINUTES.
   *
   * The comparison is on image ids, not on the tag, because the case worth
   * catching is `latest` having moved under a name that did not change.
   */
  private async rollOntoCurrentImage(row: BoxRow): Promise<BoxRow> {
    if (!row.container_id) return row;
    const slog = log.box(row.id);

    let wanted: string | null;
    let current: string | null;
    try {
      wanted = await dk.imageId(this.cfg.BOX_IMAGE);
      current = await dk.containerImageId(row.container_id);
    } catch (err) {
      // Whatever the daemon is unhappy about, it is not worth refusing to
      // start a box that already has a container over.
      slog.warn('could not compare the box image; starting as it is', {
        error: (err as Error).message,
      });
      return row;
    }
    // Nothing on the host to move to, or a container Docker no longer has:
    // either way there is nothing to decide, and start() surfaces the second.
    if (!wanted || !current || wanted === current) return row;

    if (await this.deferredWhileRunning(row, 'box image change')) return row;

    slog.info('recreating the container on the current box image', {
      from: current,
      image: this.cfg.BOX_IMAGE,
    });
    // The adapter ran as an exec inside the container about to be removed, so
    // anything the gateway still holds for this box is already dead.
    this.upstreams.get(row.id)?.stop();

    const containerId = await this.recreateContainer({
      ...row,
      image: this.cfg.BOX_IMAGE,
    });
    this.db
      .prepare('UPDATE boxes SET container_id = ?, image = ? WHERE id = ?')
      .run(containerId, this.cfg.BOX_IMAGE, row.id);
    slog.info('box moved onto the current box image', {
      image: this.cfg.BOX_IMAGE,
    });
    return this.mustGet(row.id);
  }

  // --- recreating a container -----------------------------------------------
  //
  // A container's image and its mounts are fixed when it is created, so every
  // change to either replaces the container. That is cheap — the rootfs is
  // read-only and everything durable lives in the mounts — but it is only
  // safe while nothing is running in it, hence the guard the three callers
  // share.

  /**
   * Whether a change that has to replace the container must wait, because the
   * container is still running. Says so in the log when it does.
   *
   * Killing a live container would take the adapter exec, and any turn in it,
   * with it. The change comes through at the box's next stop/start cycle,
   * which the idle reaper produces on its own within IDLE_STOP_MINUTES.
   */
  private async deferredWhileRunning(row: BoxRow, what: string): Promise<boolean> {
    if ((await dk.containerState(row.container_id)) !== 'running') return false;
    log.box(row.id).info(`${what} deferred: the container is still running`);
    return true;
  }

  /**
   * Replaces a box's container with a fresh one built from `row`, and
   * returns the new container's id. The row names the new container and the
   * workspace directory it binds before it is started, so a start that fails
   * cannot leave the row naming the removed container or the mount it no
   * longer has; the caller records whatever else changed with it.
   *
   * The old container is stopped before it is removed even where it is known
   * to be down already: both calls tolerate a container that is gone, and one
   * order for all three callers is worth more than the saved request.
   */
  private async recreateContainer(row: BoxRow): Promise<string> {
    if (row.container_id) {
      await dk.stopContainer(row.container_id);
      await dk.removeContainer(row.container_id);
    }
    const containerId = await dk.createContainer(this.containerSpec(row), this.cfg);
    this.db
      .prepare('UPDATE boxes SET container_id = ?, workspace_dir = ? WHERE id = ?')
      .run(containerId, row.workspace_dir, row.id);
    await dk.startContainer(containerId);
    return containerId;
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
   * still retrying when the box was removed reports its outcome
   * afterwards, and that must not resurrect the row.
   */
  private setStatus(id: string, status: BoxRow['status']): void {
    this.db
      .prepare("UPDATE boxes SET status = ? WHERE id = ? AND status != 'deleted'")
      .run(status, id);
  }

  /**
   * Everything createContainer needs about a box, built from its stored
   * row and what the deployment currently holds.
   *
   * One place rather than two, because a box's container is created twice:
   * once at create, and once more when a volume-backed workspace migrates to a
   * directory and the container has to be recreated with the new mount.
   *
   * What goes in for the credentials is a placeholder apiece, and the same
   * ones for every box: a box created before a credential was entered holds
   * what a box created after it holds, and the proxy is where the difference
   * is made. So nothing here has to be rebuilt when a credential arrives.
   */
  private containerSpec(row: BoxRow): dk.CreateContainerSpec {
    const settings = readSettings(this.db);
    return {
      boxId: row.id,
      image: row.image,
      networkName: row.network_name,
      subnet: row.subnet,
      workspaceSource: ws.hostWorkspacePath(this.hostDataDir, row.id),
      agentConfigSource: hostAgentConfigPath(this.hostDataDir, row.id),
      // A directory for every box created since homes became
      // directories, and the old named volume for one created before, which
      // goes on mounting it for as long as it lives. There is no migration;
      // the two arrangements coexist until the last old box is deleted.
      homeSource: row.home_dir
        ? ws.hostHomePath(this.hostDataDir, row.id)
        : row.home_volume,
      env: dk.credentialEnv(
        (id) => this.egress.placeholderFor(id),
        { gitName: settings.gitName, gitEmail: settings.gitEmail },
        this.cfg.GITLAB_HOST,
      ),
      caCertificate: this.egress.caCertificate(),
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
        async () => {
          // Opening a thread starts a stopped box without going through
          // start(), so the repairs have to happen here too — and under the
          // same slot, or they would race a start, a local command or a stop.
          // They leave the row's container id current, which is what the
          // caller reads next; the row is read inside the slot, because a
          // wait here can outlast what it says.
          await this.withSlot(id, async () => {
            const row = this.getRow(id);
            if (!row || row.status === 'deleted') return;
            await this.prepareContainer(row);
          });
        },
      );
      this.upstreams.set(id, up);
    }
    return up;
  }

  // --- create ---------------------------------------------------------------

  /**
   * Creates the network, volumes and container for a new box. Any failed
   * step tears the whole box down and marks it as an error.
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

    // What the box's first conversation is, settled before anything is
    // allocated so a request naming an agent nobody has does not build a box on
    // its way to a 400.
    const thread = threadOptions(body.thread);

    // Before anything is allocated, and after the checks above: a request
    // naming a set that is not there should not pull an image on its way to a
    // 400.
    try {
      await this.ensureBoxImage();
    } catch (err) {
      throw new HttpError(
        503,
        `Box image ${this.cfg.BOX_IMAGE} is not available: ${(err as Error).message}`,
      );
    }

    // Server-generated: user input never reaches a Docker object name.
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const subnet = allocateSubnet(
      this.cfg.BOX_SUBNET_POOL,
      nextSubnetIndex(this.db),
      takenSubnets(this.db),
    );
    if (!subnet) throw new HttpError(503, 'No free subnet in the pool');
    const row: BoxRow = {
      id,
      name,
      // Every box is DEFAULT. The column is what a deployment with named
      // credential profiles would key on, and there is no such thing: one
      // global set of credentials is what the settings page manages.
      profile: 'DEFAULT',
      image: this.cfg.BOX_IMAGE,
      container_id: null,
      network_name: dk.names.network(id),
      subnet,
      // Directory-backed from the start, both of them, so neither volume is
      // created and the columns that named them stay empty.
      ws_volume: '',
      home_volume: '',
      workspace_dir: ws.workspacePath(this.cfg.DATA_DIR, id),
      home_dir: ws.homePath(this.cfg.DATA_DIR, id),
      // No base revision until the reviewer picks one: a review compares
      // against each repository's own working tree by default.
      review_base_rev: null,
      status: 'creating',
      agent_set_id: agentSetId,
      current_thread_id: null,
      // Its own from the start: what opens this box's WebSocket opens no
      // other box.
      ws_token: generateWsToken(),
      created_at: now,
      last_active_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO boxes (id, name, profile, image, container_id,
           network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
           status, agent_set_id, current_thread_id, ws_token, created_at, last_active_at)
         VALUES (@id, @name, @profile, @image, @container_id,
           @network_name, @subnet, @ws_volume, @home_volume, @workspace_dir, @home_dir,
           @status, @agent_set_id, @current_thread_id, @ws_token, @created_at, @last_active_at)`,
      )
      .run(row);

    const slog = log.box(id);
    try {
      await this.withSlot(id, () => this.createResources(row));
      this.setStatus(id, 'running');
      // The first conversation, as a row and nothing more. Nothing is minted
      // here: a thread with no adapter-side conversation is a state the
      // gateway already handles — it is what an adapter restart leaves behind —
      // and the first browser to open the box brings it up. So creating a box
      // costs no adapter spawn, and a box can be created for a harness whose
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
   * Builds the network, the two directories and the container of a new
   * box, and starts it.
   *
   * Split out of {@link create} so it can run under the box's slot: this
   * is the half that touches Docker and the filesystem, and its order is the
   * one that works — the network before the container that joins it, and both
   * directories before the container that binds them.
   */
  private async createResources(row: BoxRow): Promise<void> {
    const id = row.id;
    await dk.createNetwork(row.network_name, row.subnet, id);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    ws.createWorkspace(this.cfg.DATA_DIR, id);
    // Before the container, because it is one of its mounts.
    this.agents.materialize(id, row.agent_set_id);
    // A bind mount covers what the image put in /home/agent rather than
    // being seeded from it the way a named volume is, so seedHomeFromImage
    // fills it. An empty home costs the agent's own `~/.local/bin` on the
    // PATH of a login shell.
    ws.createHome(this.cfg.DATA_DIR, id);
    await dk.seedHomeFromImage(ws.hostHomePath(this.hostDataDir, id), row.image, id);
    const containerId = await dk.createContainer(this.containerSpec(row), this.cfg);
    // Recorded before the start, so a start that fails leaves a row naming
    // the container and the teardown removes it.
    this.db.prepare('UPDATE boxes SET container_id = ? WHERE id = ?').run(containerId, id);
    await dk.startContainer(containerId);
  }

  // --- start / stop / delete ------------------------------------------------

  /**
   * Everything a box's container has to be brought up to date on before
   * it is started, in the one order that is safe. Returns the row as it now
   * stands, which is what names the container to start.
   *
   * Every repair is a no-op for a box that does not need it, and each is
   * put off while the container is running, so a box mid-turn is never pulled
   * out from under its adapter.
   *
   * Runs under the caller's slot and takes none of its own, which is what
   * lets the three paths that start a box share it without any of them
   * waiting for itself. A stop or a delete arriving meanwhile is honoured
   * between the repairs rather than inside one.
   */
  private async prepareContainer(row: BoxRow): Promise<BoxRow> {
    this.giveUpIfPreempted(row.id);
    // Rewritten on every start, so an edited set reaches the box here — the
    // entrypoint installs what this leaves behind, and nothing else does.
    // Before either step below, both of which may create a container that
    // binds the directory: the daemon would otherwise create it itself, empty
    // and owned by root.
    this.agents.materialize(row.id, row.agent_set_id);
    // Before anything binds the other two, for the same reason.
    this.requireDirectories(row);
    let current = await this.migrateWorkspace(row);
    this.giveUpIfPreempted(row.id);
    // Before the two below, which both ask the daemon about a container that
    // may not be there: after this one, there is a container to ask about.
    current = await this.restoreMissingContainer(current);
    this.giveUpIfPreempted(row.id);
    // Before the mount check below: a roll recreates the container from
    // containerSpec, which already binds the agent configuration, so a
    // box that moves image comes back with the mount and the check that
    // follows finds nothing to do.
    current = await this.rollOntoCurrentImage(current);
    this.giveUpIfPreempted(row.id);
    return this.ensureAgentConfigMount(current);
  }

  /**
   * Refuses to go on when a box's bind sources are gone, naming what is
   * missing, and marks the box as an error.
   *
   * Docker creates a bind source it cannot find, empty and owned by root. The
   * box then starts and looks healthy while the agent cannot write a thing:
   * every turn fails, and nothing says why. A crash during a delete, a backup
   * restored in part, or a HOST_DATA_DIR that stopped being right all leave
   * exactly this.
   *
   * Nothing is recreated here. The home holds the adapter's thread
   * transcripts, so seeding a fresh one would erase every conversation while
   * looking like a repair. Whoever restores the files is the one who can tell
   * what happened.
   *
   * Only the halves the row says are directories are checked. A box from
   * before either became one still mounts a named volume, which Docker keeps
   * on its own.
   */
  private requireDirectories(row: BoxRow): void {
    const missing: string[] = [];
    const workspace = ws.workspacePath(this.cfg.DATA_DIR, row.id);
    const home = ws.homePath(this.cfg.DATA_DIR, row.id);
    if (row.workspace_dir && !ws.directoryExists(workspace)) {
      missing.push(`its workspace directory (${workspace})`);
    }
    if (row.home_dir && !ws.directoryExists(home)) {
      missing.push(`its home directory (${home})`);
    }
    if (missing.length === 0) return;

    this.setStatus(row.id, 'error');
    log.box(row.id).error('refusing to start a box whose files are gone', { missing });
    throw new HttpError(
      409,
      `This box cannot start: ${missing.join(' and ')} cannot be found. ` +
        'Restore the files from a backup, or delete the box.',
    );
  }

  /**
   * Starts a stopped box's container and re-attaches the egress proxy.
   * Waits for whatever else the box is in the middle of.
   */
  async start(id: string): Promise<BoxDetail> {
    return this.withSlot(id, () => this.startHeld(id));
  }

  /** The body of {@link start}, which runs under the box's slot. */
  private async startHeld(id: string): Promise<BoxDetail> {
    const stored = this.mustGet(id);
    if (!stored.container_id) throw new HttpError(409, 'Box has no container');
    const row = await this.prepareContainer(stored);
    this.giveUpIfPreempted(id);
    await dk.startContainer(row.container_id!);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    this.setStatus(id, 'running');
    // The upstream reconnects on the next forwarded message, which re-issues
    // session/load and restores the thread.
    return this.detail(id);
  }

  /**
   * Moves a box created before this change off its workspace volume and
   * onto a directory, and returns the row as it now stands.
   *
   * Start is the only moment this can happen: the mount is fixed when a
   * container is created, so the container has to be replaced. That is cheap
   * here — a box container has a read-only rootfs and everything durable
   * lives in its two mounts — but it is not free of risk, so the order is
   * chosen to lose nothing at any step: copy first, recreate second, and drop
   * the volume only once the new container has started. The row says which
   * mount it has the moment the container that has it exists, so a crash
   * cannot leave a running container on the directory beside a row that says
   * volume, which is what copies the volume over the agent's own work.
   *
   * A running legacy box is left alone. Its container works, and it will
   * come through here at its next stop/start cycle.
   */
  private async migrateWorkspace(row: BoxRow): Promise<BoxRow> {
    if (row.workspace_dir) return row;
    const slog = log.box(row.id);
    if (await this.deferredWhileRunning(row, 'workspace migration')) return row;

    slog.info('migrating the workspace volume to a directory', { volume: row.ws_volume });
    const directory = ws.createWorkspace(this.cfg.DATA_DIR, row.id);
    const hostDirectory = ws.hostWorkspacePath(this.hostDataDir, row.id);

    if (row.ws_volume) {
      await dk.copyVolumeToDirectory(row.ws_volume, hostDirectory, row.image, row.id);
    }
    // The agent has to own what it works in, and cp -a brought the volume's
    // own ownership with it, which a Docker-initialised volume gets right.
    ws.chownToAgent(directory);

    // The directory it is given is the one the new container binds, and
    // recreateContainer records both together before the start.
    await this.recreateContainer({ ...row, workspace_dir: directory });
    this.db.prepare("UPDATE boxes SET ws_volume = '' WHERE id = ?").run(row.id);

    if (row.ws_volume) await dk.removeVolume(row.ws_volume);
    slog.info('workspace migrated', { directory });
    return this.mustGet(row.id);
  }

  /**
   * Gives a box created before agent configuration existed the mount that
   * carries it, and returns the row as it now stands.
   *
   * Nothing is lost if this fails halfway, because the directory is already
   * written and the next start tries again.
   *
   * A running box is left alone, and gets the mount at its next
   * stop/start cycle.
   */
  private async ensureAgentConfigMount(row: BoxRow): Promise<BoxRow> {
    if (!row.container_id) return row;
    if (await dk.hasMount(row.container_id, dk.AGENT_CONFIG_DIR)) return row;
    if (await this.deferredWhileRunning(row, 'agent configuration')) return row;
    log.box(row.id).info('recreating the container with the agent configuration mount');
    const containerId = await this.recreateContainer(row);
    this.db
      .prepare('UPDATE boxes SET container_id = ? WHERE id = ?')
      .run(containerId, row.id);
    return this.mustGet(row.id);
  }

  /**
   * Stops the container and drops the upstream connection.
   *
   * Overtakes what the box is in the middle of rather than queueing
   * behind it: the flag and the upstream's own stop are both set before the
   * slot is asked for, so the work in flight gives up at its next step and
   * this gets the slot a step later rather than after a spawn's retries.
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
   * For the reaper, which must never wait: a box with an operation in
   * flight is somebody's, so it is left alone and looked at again on the next
   * tick. The queue is read and taken in the same step, so nothing can slip
   * in between.
   */
  async stopUnlessBusy(id: string): Promise<boolean> {
    if (this.slots.has(id)) return false;
    await this.stop(id);
    return true;
  }

  /** The body of {@link stop}, which runs under the box's slot. */
  private async stopHeld(id: string): Promise<BoxDetail> {
    // Everything queued before this has given up by now, and what was queued
    // behind it is not this stop's to abandon.
    this.preempted.delete(id);
    const row = this.mustGet(id);
    if (row.container_id) await dk.stopContainer(row.container_id);
    this.setStatus(id, 'stopped');
    log.box(id).info('box stopped');
    return this.detail(id);
  }

  /**
   * Deletes a box and everything it is made of, its volumes included.
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
    // The tombstone goes down first, before a single row is deleted and while
    // the slot is held. It is what every writer that can still be in flight
    // checks — the ACP tap, a streaming command that is just finishing, a
    // touch — so none of them can insert a row for a box that is going
    // away, and setStatus itself will not move the row out again.
    this.setStatus(id, 'deleted');
    this.upstreams.delete(id);
    await this.teardownResources(id);
    // Every table keyed by the box id, so a deleted box leaves nothing
    // behind: the row itself stays as a tombstone — see setStatus — and these
    // have no reader once it does.
    for (const table of ['pending_requests', 'threads']) {
      this.db.prepare(`DELETE FROM ${table} WHERE box_id = ?`).run(id);
    }
    this.usage.forget(id);
    log.box(id).info('box deleted', { name: row.name });
  }

  /**
   * Removes a box's container, network and volumes. Every failure is
   * logged rather than thrown, so teardown always finishes.
   */
  private async teardownResources(id: string): Promise<void> {
    const row = this.getRow(id);
    if (!row) return;
    const slog = log.box(id);
    if (row.container_id) {
      try {
        await dk.stopContainer(row.container_id);
        await dk.removeContainer(row.container_id);
      } catch (err) {
        slog.warn('container teardown failed', { error: (err as Error).message });
      }
    }
    try {
      await dk.removeNetwork(row.network_name, this.cfg);
    } catch (err) {
      slog.warn('network teardown failed', { error: (err as Error).message });
    }
    // The workspace and the home hold the agent's work and the adapter's
    // thread history, and nothing refers to either once the box is gone,
    // so a deleted box takes them with it.
    if (row.workspace_dir) {
      try {
        ws.removeWorkspace(this.cfg.DATA_DIR, row.id);
      } catch (err) {
        slog.warn('workspace removal failed', { error: (err as Error).message });
      }
    }
    if (row.home_dir) {
      try {
        ws.removeHome(this.cfg.DATA_DIR, row.id);
      } catch (err) {
        slog.warn('home removal failed', { error: (err as Error).message });
      }
    }
    try {
      this.agents.removeMaterialized(row.id);
    } catch (err) {
      slog.warn('agent configuration removal failed', { error: (err as Error).message });
    }
    // Only a box from before each of these became a directory still has
    // a volume.
    if (row.ws_volume) await dk.removeVolume(row.ws_volume);
    if (row.home_volume) await dk.removeVolume(row.home_volume);
  }

  // --- views ----------------------------------------------------------------

  /** The stored row for a live box, or a 404. */
  mustGet(id: string): BoxRow {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Box not found');
    return row;
  }

  /**
   * Where a local command should run for this box, starting the
   * container if it is stopped. The workspace root, which is where the
   * adapter runs too.
   *
   * Marks the box active, because everything that asks for this is about
   * to work in the box: a terminal opening a shell, or a review running git.
   */
  async execTarget(id: string): Promise<{ containerId: string; workingDir: string }> {
    return this.withSlot(id, () => this.execTargetHeld(id));
  }

  /** The body of {@link execTarget}, which runs under the box's slot. */
  private async execTargetHeld(id: string): Promise<{ containerId: string; workingDir: string }> {
    const stored = this.mustGet(id);
    if (!stored.container_id) throw new HttpError(409, 'Box has no container');
    // Reaching in starts a stopped container, so it is as good a moment as
    // any to put the box right: the same repairs start() runs, in the same
    // order.
    const row = await this.prepareContainer(stored);
    this.giveUpIfPreempted(id);
    await dk.startContainer(row.container_id!);
    // Reaching into the box is use of the box, whoever is asking, and it
    // holds the reaper off for as long as the asking goes on.
    this.touch(id);
    return { containerId: row.container_id!, workingDir: dk.WORKSPACE_DIR };
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
   * Says the orchestrator has written into a box's workspace, so its size
   * is measured again rather than answered from what a stopped box was left
   * at.
   *
   * A box that is down cannot grow on its own, which is what lets a stopped
   * box be measured once and then left alone. An upload is the one
   * exception, and this is it saying so.
   */
  workspaceChanged(id: string): void {
    this.usage.forget(id);
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

  /** Builds a summary, resolving the container state against Docker. */
  private async summarize(
    row: BoxRow,
    pendingCount: number,
    turnActive: boolean,
  ): Promise<BoxSummary> {
    const dockerState = await dk.containerState(row.container_id);
    const pendingByThread = this.pending.countsByThread(row.id);
    // What the gateway believes about the box right now, which lives in
    // memory beside the adapter rather than in the database: the agent is
    // talking on these threads, and these tasks are still running in them.
    // Read once here so every thread of one summary answers from the same
    // moment. `upstreams.get` rather than `upstream()`, which would start one.
    const upstream = this.upstreams.get(row.id);
    const speaking = new Set(upstream?.speakingThreads ?? []);
    const working = new Set(upstream?.workingThreads ?? []);
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      status: row.status,
      dockerState,
      // Derived from the threads rather than stored beside them: a turn runs
      // on a conversation, and the box's answer is that any of them has
      // one.
      turnActive,
      speaking: speaking.size > 0,
      backgroundBusy: upstream?.backgroundActive ?? false,
      pendingCount,
      attachedCount: upstream?.attachedCount ?? 0,
      wsToken: row.ws_token,
      threads: listThreads(this.db, row.id).map((thread) =>
        toThreadSummary(
          thread,
          pendingByThread,
          speaking,
          working,
          // Forking is per thread, because the answer is per adapter: a box
          // may hold two, and each says for itself whether it can branch a
          // conversation. An adapter that has not been reached is absent from
          // the set, which is the honest answer rather than an assumed one.
          upstream?.forkableHarnesses ?? new Set<HarnessId>(),
        ),
      ),
      currentThreadId: row.current_thread_id,
      agentSetId: row.agent_set_id,
      agentSetName: this.agents.nameOf(row.agent_set_id),
      // What was last measured, and null until there is a measurement.
      // 'unknown' counts as live: a Docker read that failed says nothing
      // about whether the agent is working.
      diskBytes: this.usage.bytes(
        row.id,
        dockerState !== 'exited' && dockerState !== 'missing',
      ),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /** A summary plus the Docker object names the detail view shows. */
  async detail(id: string): Promise<BoxDetail> {
    const row = this.mustGet(id);
    const summary = await this.summarize(
      row,
      this.pending.countForBox(id),
      boxTurnActive(this.db, id),
    );
    return {
      ...summary,
      image: row.image,
      containerId: row.container_id,
      networkName: row.network_name,
      subnet: row.subnet,
      wsVolume: row.ws_volume,
      workspaceDir: row.workspace_dir,
      homeVolume: row.home_volume,
      homeDir: row.home_dir,
      acpSessionId: currentThread(this.db, id)?.acp_session_id ?? null,
      proxyAttached: await dk.isProxyAttached(row.network_name, this.cfg),
      // `upstreams.get` rather than `upstream()`, which would start one: a
      // box nothing holds has nothing read about it, and an empty list is the
      // honest answer rather than a reason to go and look.
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
   * The thread a request is about: the one it names, or the box's current
   * one when it names none — and null before the box has any thread at
   * all.
   *
   * Same rule as the WebSocket paths, so a route that can name a thread is
   * still usable by a caller that knows nothing about threads.
   */
  resolveThread(id: string, threadId?: string): string | null {
    this.mustGet(id);
    if (threadId === undefined) return currentThread(this.db, id)?.id ?? null;
    return this.mustGetThread(id, threadId).id;
  }

  /**
   * Adds a conversation to a box and makes it current: on the agent and
   * settings the body names, or carrying another thread's context when `from`
   * names one.
   *
   * A fork needs the adapter, because only the adapter can branch a
   * transcript. A fresh thread does not: its row is written first and its
   * conversation minted after, so a harness whose credential nobody has
   * entered still gets a thread — the dialog is what keeps a person from
   * asking for one, and the API is not a gate.
   */
  async createThread(id: string, body: CreateThreadBody | undefined): Promise<ThreadSummary> {
    this.mustGet(id);
    const from = body?.from?.trim();
    // A fork's options are its source's: only the adapter that wrote a
    // transcript can load it, so a fork stays on that harness whatever the
    // request says.
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
      // A thread minted and never prompted has no adapter-side conversation
      // to branch from, which is the caller's timing rather than a fault.
      if (message === NOTHING_TO_FORK) throw new HttpError(409, message);
      throw new HttpError(500, `Failed to create thread: ${message}`);
    }
  }

  /**
   * Makes one of a box's threads current: the thread a connection that
   * names none gets.
   *
   * Nobody is dropped and nothing reconnects. A browser is pinned to its own
   * thread for the life of its socket, so the box's default is read only
   * at a handshake; see UpstreamBox.switchThread.
   */
  selectThread(id: string, threadId: string): ThreadSummary {
    this.mustGet(id);
    this.mustGetThread(id, threadId);
    const up = this.upstream(id);
    return toThreadSummary(
      up.switchThread(threadId),
      new Map(),
      new Set(),
      new Set(),
      up.forkableHarnesses,
    );
  }

  /**
   * Marks one of a box's conversations done, or takes the mark off again.
   *
   * The reader's own note about which threads they are finished with. Nothing
   * else changes: the thread keeps its adapter conversation, whatever it is
   * running goes on running, and a prompt sent to it is answered as always.
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
   * Stops one task that conversation left running, or every task it has.
   *
   * A thread the adapter has no conversation for cannot have announced a task:
   * a task is named by the adapter's own id for the conversation it is on, and
   * this thread has none.
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
   * Kills everything running in a box, whether or not a conversation claims it.
   *
   * The answer to a box that is busy with work no thread has a task for, which
   * is what every adapter restart leaves behind: the tasks went with the
   * process that announced them, and a signal is the only thing that reaches
   * the build they left running.
   */
  async stopBoxWork(id: string): Promise<{ stopped: number }> {
    this.mustGet(id);
    return { stopped: await this.upstream(id).stopBoxWork() };
  }

  // --- boot reconciliation --------------------------------------------------

  /**
   * Aligns the stored rows with what Docker runs: adopts live containers,
   * marks missing ones stopped, fails a create that was interrupted, and
   * re-attaches the egress proxy. Upstream connections are re-established on
   * first use.
   */
  async reconcile(): Promise<void> {
    this.pending.clearStale();
    // Helpers are left out: one that outlived its job is labelled with the
    // box too, and adopting it would leave the row naming a copy script.
    const live = new Map(
      (await dk.listBoxContainers()).filter((c) => !c.helper).map((c) => [c.boxId, c]),
    );
    for (const row of this.allRows()) {
      // A turn cannot survive an orchestrator restart: the upstream
      // connection that owned it is gone, on every thread of the box,
      // whether or not its container is.
      clearBoxTurns(this.db, row.id);
      const container = live.get(row.id);
      if (!container) {
        if (row.status === 'running') {
          log.box(row.id).warn('container missing at boot; marking stopped');
          this.setStatus(row.id, 'stopped');
        } else if (row.status === 'creating') {
          // create() fails a box it cannot finish, so a row still saying
          // this has nobody left to finish it: the process that was creating
          // it is gone. Nothing is deleted — the sweep takes what it left —
          // but the row has to stop holding its subnet and refusing a start.
          log.box(row.id).warn('create did not finish before the restart; marking error');
          this.setStatus(row.id, 'error');
        }
        continue;
      }
      if (container.id !== row.container_id) {
        this.db
          .prepare('UPDATE boxes SET container_id = ? WHERE id = ?')
          .run(container.id, row.id);
      }
      this.setStatus(row.id, container.running ? 'running' : 'stopped');
      await dk.ensureProxyAttached(row.network_name, this.cfg);
    }
    log.info('boot reconciliation complete', { boxes: this.allRows().length });
  }

  /**
   * Re-attaches the egress proxy to every running box's network. Returns
   * the ids of the boxes where that failed.
   */
  async reconcileProxyAttachments(): Promise<string[]> {
    const warnings: string[] = [];
    for (const row of this.allRows()) {
      if (row.status !== 'running') continue;
      const ok = await dk.ensureProxyAttached(row.network_name, this.cfg);
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
   * The reaper asks each running box's upstream what is in its box, which
   * builds one for every box nobody has opened, and nothing else lets go
   * of them. An upstream with no browser attached, no request waiting and no
   * connection to an adapter holds nothing a fresh one could not rebuild.
   *
   * Only for a box whose row says it is not running: while a box is up,
   * the upstream carries the reading of what is running in it, and the reaper
   * asks for that reading every tick. Dropping one would throw the reading
   * away a minute after it was taken, and a box with no reading is held.
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
 * `pendingByThread` is keyed by the adapter's own id, which is what a queued
 * permission request records, and a thread the adapter has forgotten has no
 * queued requests by definition.
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
    // These three are the live gateway's, keyed by the adapter's own id: a
    // thread the adapter has forgotten has nothing running in it and nobody
    // talking on it, by definition.
    speaking: acp ? speaking.has(acp) : false,
    backgroundBusy: acp ? working.has(acp) : false,
    pendingCount: acp ? (pendingByThread.get(acp) ?? 0) : 0,
    modeId: row.mode_id,
    config: threadConfig(row),
    // Whether this thread's own adapter advertised the fork capability, and
    // false while it has not been reached.
    canFork: forkable.has(row.harness),
    done: row.done === 1,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}


/**
 * What a request asked a thread to be, checked.
 *
 * An absent body is Claude on its defaults, which is what every client from
 * before harnesses existed means and what the dashboard sends until somebody
 * chooses otherwise. An unknown harness is a 400 rather than a thread on the
 * wrong agent, and a config map is taken as it comes: which options a harness
 * offers is the adapter's to say, and one it does not know is refused by the
 * adapter and logged rather than fatal.
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
