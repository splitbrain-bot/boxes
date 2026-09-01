import { randomBytes } from 'node:crypto';
import {
  GLOBAL_AGENT_SET,
  type CreateSessionBody,
  type CreateThreadBody,
  type DockerState,
  type SessionDetail,
  type SessionSummary,
  type ThreadSummary,
} from '../../shared/types.ts';
import { AgentStore, ensureAgentsRoot, hostAgentConfigPath } from './agents.ts';
import type { Config, SessionProfile } from './config.ts';
import type { EgressManager } from './egress.ts';
import {
  clearSessionTurns,
  currentThread,
  getThread,
  listThreads,
  nextSubnetIndex,
  sessionTurnActive,
  sessionsWithActiveTurns,
  type Db,
  type SessionRow,
  type ThreadRow,
} from './db.ts';
import * as dk from './docker.ts';
import { log } from './log.ts';
import type { Notifier } from './notify.ts';
import * as ws from './workspaces.ts';
import { PendingStore } from './gateway/pending.ts';
import { NOTHING_TO_FORK, UpstreamSession } from './gateway/upstream.ts';
import { allocateSubnet } from './subnet.ts';

/**
 * Session lifecycle and the owner of every UpstreamSession. Docker is the
 * runtime truth; the sessions table is metadata.
 */

/** argv for the pinned ACP adapter inside the session container. */
const AGENT_CMD = ['claude-agent-acp'];

/** Creates, starts, stops and describes sessions. */
export class SessionManager {
  private readonly upstreams = new Map<string, UpstreamSession>();

  /** Permission requests waiting for a browser, across all sessions. */
  readonly pending: PendingStore;

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
     * The AGENTS.md, skills and commands a session is given. Owned by the app
     * so the REST routes and the lifecycle share one, since editing a set and
     * starting a session are two halves of the same feature.
     */
    private readonly agents: AgentStore,
  ) {
    this.pending = new PendingStore(db);
    this.hostDataDir = cfg.HOST_DATA_DIR || cfg.DATA_DIR;
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
   * Where a session's files are on this process's own filesystem, or null for
   * a session still backed by a named volume — which the review surface reads
   * as "not reviewable until this session is started once".
   *
   * Derived from the current DATA_DIR rather than read from the row, so moving
   * the data volume moves the workspaces with it; the stored column only says
   * whether the session has a directory at all. An unknown or deleted session
   * is null too: the caller's own 404 says so more precisely than a throw from
   * here would.
   */
  workspacePathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted' || !row.workspace_dir) return null;
    return ws.workspacePath(this.cfg.DATA_DIR, row.id);
  }

  // --- helpers --------------------------------------------------------------

  /** The stored row for a session, including deleted ones. */
  getRow(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
  }

  /** Every session that has not been deleted, newest first. */
  private allRows(): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status != 'deleted' ORDER BY created_at DESC")
      .all() as SessionRow[];
  }

  /**
   * Records a new status, leaving a deleted session deleted. An upstream spawn
   * still retrying when the session was removed reports its outcome
   * afterwards, and that must not resurrect the row.
   */
  private setStatus(id: string, status: SessionRow['status']): void {
    this.db
      .prepare("UPDATE sessions SET status = ? WHERE id = ? AND status != 'deleted'")
      .run(status, id);
  }

  /**
   * Everything createContainer needs about a session, built from its stored
   * row and the deployment's current credentials.
   *
   * One place rather than two, because a session's container is created twice:
   * once at create, and once more when a volume-backed workspace migrates to a
   * directory and the container has to be recreated with the new mount.
   */
  private containerSpec(row: SessionRow, profile: SessionProfile): dk.CreateContainerSpec {
    return {
      sessionId: row.id,
      image: row.image,
      networkName: row.network_name,
      subnet: row.subnet,
      workspaceSource: ws.hostWorkspacePath(this.hostDataDir, row.id),
      agentConfigSource: hostAgentConfigPath(this.hostDataDir, row.id),
      homeVolume: row.home_volume,
      profile,
      egress: {
        claudeOauthToken: this.egress.sessionValue('claude', profile.claudeOauthToken),
        ghToken: this.egress.sessionValue('github', profile.ghToken),
        caCertificate: this.egress.caCertificate(),
      },
    };
  }

  /**
   * The profile a session was created with, or the default when the deployment
   * has since dropped it. A session that outlived its profile must still start.
   */
  private profileFor(row: SessionRow): SessionProfile {
    const profile = this.cfg.profiles[row.profile];
    if (profile) return profile;
    const fallback = this.cfg.profiles['DEFAULT'];
    if (!fallback) throw new HttpError(500, `Unknown profile: ${row.profile}`);
    log.session(row.id).warn('profile is gone; falling back to DEFAULT', {
      profile: row.profile,
    });
    return fallback;
  }

  /** The persistent upstream for a session, created on first use. */
  upstream(id: string): UpstreamSession {
    let up = this.upstreams.get(id);
    if (!up) {
      up = new UpstreamSession(
        id,
        this.db,
        this.cfg,
        this.pending,
        this.notifier,
        (status) => this.setStatus(id, status),
        () => {
          const row = this.getRow(id);
          if (row && row.status !== 'deleted') this.agents.materialize(id, row.agent_set_id);
        },
      );
      this.upstreams.set(id, up);
    }
    return up;
  }

  // --- create ---------------------------------------------------------------

  /**
   * Creates the network, volumes and container for a new session. Any failed
   * step tears the whole session down and marks it as an error.
   */
  async create(body: CreateSessionBody): Promise<SessionDetail> {
    const name = body.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (name.length > 100) throw new HttpError(400, 'name must be 100 characters or fewer');

    const profileName = body.profile?.trim() || 'DEFAULT';
    const profile = this.cfg.profiles[profileName];
    if (!profile) throw new HttpError(400, `Unknown profile: ${profileName}`);

    // The global set is applied whatever this says, so naming it is the same
    // as naming nothing and is stored as nothing.
    const requested = body.agentSet?.trim() ?? '';
    const agentSetId = requested === '' || requested === GLOBAL_AGENT_SET ? null : requested;
    if (agentSetId && !this.agents.has(agentSetId)) {
      throw new HttpError(400, `Unknown agent set: ${agentSetId}`);
    }

    // Server-generated: user input never reaches a Docker object name.
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const subnet = allocateSubnet(this.cfg.SESSION_SUBNET_POOL, nextSubnetIndex(this.db));
    const row: SessionRow = {
      id,
      name,
      profile: profileName,
      image: this.cfg.SESSION_IMAGE,
      agent_cmd: JSON.stringify(AGENT_CMD),
      container_id: null,
      network_name: dk.names.network(id),
      subnet,
      // Directory-backed from the start, so no workspace volume is created
      // and the column that named one stays empty.
      ws_volume: '',
      home_volume: dk.names.homeVolume(id),
      workspace_dir: ws.workspacePath(this.cfg.DATA_DIR, id),
      // Resolved and remembered on first review, not now: the workspace is
      // empty at create and the shape a clone leaves is what decides them.
      review_root: null,
      review_base_rev: null,
      review_base_commit: null,
      status: 'creating',
      agent_set_id: agentSetId,
      current_thread_id: null,
      created_at: now,
      last_active_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
           network_name, subnet, ws_volume, home_volume, workspace_dir, status,
           agent_set_id, current_thread_id, created_at, last_active_at)
         VALUES (@id, @name, @profile, @image, @agent_cmd, @container_id,
           @network_name, @subnet, @ws_volume, @home_volume, @workspace_dir, @status,
           @agent_set_id, @current_thread_id, @created_at, @last_active_at)`,
      )
      .run(row);

    const slog = log.session(id);
    try {
      await dk.createNetwork(row.network_name, subnet, id);
      await dk.ensureProxyAttached(row.network_name, this.cfg);
      ws.createWorkspace(this.cfg.DATA_DIR, id);
      // Before the container, because it is one of its mounts.
      this.agents.materialize(id, agentSetId);
      await dk.createVolume(row.home_volume, id);
      const containerId = await dk.createContainer(
        this.containerSpec(row, profile),
        this.cfg,
      );
      await dk.startContainer(containerId);
      this.db
        .prepare("UPDATE sessions SET container_id = ?, status = 'running' WHERE id = ?")
        .run(containerId, id);
      slog.info('session created', { name });
    } catch (err) {
      slog.error('session create failed; tearing down', { error: (err as Error).message });
      await this.teardownResources(id);
      this.setStatus(id, 'error');
      throw new HttpError(500, `Failed to create session: ${(err as Error).message}`);
    }

    return this.detail(id);
  }

  // --- start / stop / delete ------------------------------------------------

  /** Starts a stopped session's container and re-attaches the egress proxy. */
  async start(id: string): Promise<SessionDetail> {
    let row = this.mustGet(id);
    if (!row.container_id) throw new HttpError(409, 'Session has no container');
    // Rewritten on every start, so an edited set reaches the box here — the
    // entrypoint installs what this leaves behind, and nothing else does.
    // Before either step below, both of which may create a container that
    // binds the directory: the daemon would otherwise create it itself, empty
    // and owned by root.
    this.agents.materialize(row.id, row.agent_set_id);
    row = await this.migrateWorkspace(row);
    row = await this.ensureAgentConfigMount(row);
    await dk.startContainer(row.container_id!);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    this.setStatus(id, 'running');
    // The upstream reconnects on the next forwarded message, which re-issues
    // session/load and restores the thread.
    return this.detail(id);
  }

  /**
   * Moves a session created before this change off its workspace volume and
   * onto a directory, and returns the row as it now stands.
   *
   * Start is the only moment this can happen: the mount is fixed when a
   * container is created, so the container has to be replaced. That is cheap
   * here — a session container has a read-only rootfs and everything durable
   * lives in its two mounts — but it is not free of risk, so the order is
   * chosen to lose nothing at any step: copy first, recreate second, and drop
   * the volume only once the new container has started. A crash anywhere
   * before the row is updated leaves a volume-backed session that migrates
   * again on the next attempt.
   *
   * A running legacy session is left alone. Its container works, and it will
   * come through here at its next stop/start cycle.
   */
  private async migrateWorkspace(row: SessionRow): Promise<SessionRow> {
    if (row.workspace_dir) return row;
    const slog = log.session(row.id);
    if ((await dk.containerState(row.container_id)) === 'running') {
      slog.info('workspace migration deferred: the container is still running');
      return row;
    }

    slog.info('migrating the workspace volume to a directory', { volume: row.ws_volume });
    const directory = ws.createWorkspace(this.cfg.DATA_DIR, row.id);
    const hostDirectory = ws.hostWorkspacePath(this.hostDataDir, row.id);

    if (row.ws_volume) {
      await dk.copyVolumeToDirectory(row.ws_volume, hostDirectory, row.image, row.id);
    }
    // The agent has to own what it works in, and cp -a brought the volume's
    // own ownership with it, which a Docker-initialised volume gets right.
    ws.chownToAgent(directory);

    if (row.container_id) {
      await dk.stopContainer(row.container_id);
      await dk.removeContainer(row.container_id);
    }
    const containerId = await dk.createContainer(
      this.containerSpec(row, this.profileFor(row)),
      this.cfg,
    );
    await dk.startContainer(containerId);

    this.db
      .prepare(
        `UPDATE sessions SET container_id = ?, workspace_dir = ?, ws_volume = ''
          WHERE id = ?`,
      )
      .run(containerId, directory, row.id);

    if (row.ws_volume) await dk.removeVolume(row.ws_volume);
    slog.info('workspace migrated', { directory });
    return this.mustGet(row.id);
  }

  /**
   * Gives a session created before agent configuration existed the mount that
   * carries it, and returns the row as it now stands.
   *
   * A container's mounts are fixed when it is created, so the container has to
   * be replaced — the same trade the workspace migration makes, and cheap for
   * the same reason: a session container has a read-only rootfs and everything
   * durable is in its mounts. Nothing is lost if this fails halfway, because
   * the directory is already written and the next start tries again.
   *
   * A running session is left alone. Restarting it under the user would be a
   * worse surprise than configuration arriving one stop/start cycle late.
   */
  private async ensureAgentConfigMount(row: SessionRow): Promise<SessionRow> {
    if (!row.container_id) return row;
    if (await dk.hasMount(row.container_id, dk.AGENT_CONFIG_DIR)) return row;
    const slog = log.session(row.id);
    if ((await dk.containerState(row.container_id)) === 'running') {
      slog.info('agent configuration deferred: the container is still running');
      return row;
    }
    slog.info('recreating the container with the agent configuration mount');
    await dk.stopContainer(row.container_id);
    await dk.removeContainer(row.container_id);
    const containerId = await dk.createContainer(
      this.containerSpec(row, this.profileFor(row)),
      this.cfg,
    );
    this.db
      .prepare('UPDATE sessions SET container_id = ? WHERE id = ?')
      .run(containerId, row.id);
    return this.mustGet(row.id);
  }

  /** Stops the container and drops the upstream connection. */
  async stop(id: string): Promise<SessionDetail> {
    const row = this.mustGet(id);
    this.upstreams.get(id)?.stop();
    if (row.container_id) await dk.stopContainer(row.container_id);
    this.setStatus(id, 'stopped');
    log.session(id).info('session stopped');
    return this.detail(id);
  }

  /** Deletes a session and everything it is made of, its volumes included. */
  async remove(id: string): Promise<void> {
    const row = this.mustGet(id);
    this.upstreams.get(id)?.close();
    this.upstreams.delete(id);
    await this.teardownResources(id);
    this.db.prepare('DELETE FROM pending_requests WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM acp_log WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM threads WHERE session_id = ?').run(id);
    this.setStatus(id, 'deleted');
    log.session(id).info('session deleted', { name: row.name });
  }

  /**
   * Removes a session's container, network and volumes. Every failure is
   * logged rather than thrown, so teardown always finishes.
   */
  private async teardownResources(id: string): Promise<void> {
    const row = this.getRow(id);
    if (!row) return;
    const slog = log.session(id);
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
    // The workspace and the home volume hold the agent's work and the
    // adapter's thread history. Nothing else refers to either once the session
    // is gone, so a session that is deleted takes them with it rather than
    // leaving them orphaned.
    if (row.workspace_dir) {
      try {
        ws.removeWorkspace(this.cfg.DATA_DIR, row.id);
      } catch (err) {
        slog.warn('workspace removal failed', { error: (err as Error).message });
      }
    }
    try {
      this.agents.removeMaterialized(row.id);
    } catch (err) {
      slog.warn('agent configuration removal failed', { error: (err as Error).message });
    }
    // Only a session that never migrated still has one.
    if (row.ws_volume) await dk.removeVolume(row.ws_volume);
    await dk.removeVolume(row.home_volume);
  }

  // --- views ----------------------------------------------------------------

  /** The stored row for a live session, or a 404. */
  private mustGet(id: string): SessionRow {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Session not found');
    return row;
  }

  /**
   * Where a local command should run for this session, starting the
   * container if it is stopped. The workspace root, which is where the
   * adapter runs too.
   */
  async execTarget(id: string): Promise<{ containerId: string; workingDir: string }> {
    const row = this.mustGet(id);
    if (!row.container_id) throw new HttpError(409, 'Session has no container');
    // A stopped container starts here too, and the entrypoint installs
    // whatever is on disk when it does.
    this.agents.materialize(row.id, row.agent_set_id);
    await dk.startContainer(row.container_id);
    return { containerId: row.container_id, workingDir: dk.WORKSPACE_DIR };
  }

  /** Marks a session active, so running a command holds off the reaper. */
  touch(id: string): void {
    this.db
      .prepare("UPDATE sessions SET last_active_at = ? WHERE id = ? AND status != 'deleted'")
      .run(Date.now(), id);
  }

  /** Summaries of every live session. */
  async list(): Promise<SessionSummary[]> {
    const rows = this.allRows();
    const counts = this.pending.countsBySession();
    const running = sessionsWithActiveTurns(this.db);
    return Promise.all(
      rows.map(async (row) =>
        this.summarize(row, counts.get(row.id) ?? 0, running.has(row.id)),
      ),
    );
  }

  /** Builds a summary, resolving the container state against Docker. */
  private async summarize(
    row: SessionRow,
    pendingCount: number,
    turnActive: boolean,
  ): Promise<SessionSummary> {
    const dockerState = (await dk.containerState(row.container_id)) as DockerState;
    const pendingByThread = this.pending.countsByThread(row.id);
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      status: row.status,
      dockerState,
      // Derived from the threads rather than stored beside them: a turn runs
      // on a conversation, and the session's answer is that any of them has
      // one.
      turnActive,
      pendingCount,
      attachedCount: this.upstreams.get(row.id)?.attachedCount ?? 0,
      wsToken: this.cfg.WS_AUTH_TOKEN,
      threads: listThreads(this.db, row.id).map((thread) =>
        toThreadSummary(thread, pendingByThread),
      ),
      currentThreadId: row.current_thread_id,
      // False until the adapter has been reached and has advertised it. The
      // capability is unstable, so an absent one is taken at face value.
      canFork: this.upstreams.get(row.id)?.canFork ?? false,
      agentSetId: row.agent_set_id,
      agentSetName: this.agents.nameOf(row.agent_set_id),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /** A summary plus the Docker object names the detail view shows. */
  async detail(id: string): Promise<SessionDetail> {
    const row = this.mustGet(id);
    const summary = await this.summarize(
      row,
      this.pending.countForSession(id),
      sessionTurnActive(this.db, id),
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
      acpSessionId: currentThread(this.db, id)?.acp_session_id ?? null,
      proxyAttached: await dk.isProxyAttached(row.network_name, this.cfg),
    };
  }

  // --- threads --------------------------------------------------------------

  /** Every conversation of a session, oldest first. */
  threads(id: string): ThreadSummary[] {
    this.mustGet(id);
    const pendingByThread = this.pending.countsByThread(id);
    return listThreads(this.db, id).map((thread) => toThreadSummary(thread, pendingByThread));
  }

  /**
   * Whether a thread belongs to a session. The WebSocket upgrade asks before
   * a socket exists, so a path naming another session's thread is a 404
   * rather than a connection that fails later.
   */
  hasThread(sessionId: string, threadId: string): boolean {
    const row = getThread(this.db, threadId);
    return row !== undefined && row.session_id === sessionId;
  }

  /**
   * Adds a conversation to a session and makes it current: empty by default,
   * or carrying another thread's context when `from` names one.
   *
   * Both need the adapter, because only the adapter can mint a thread.
   */
  async createThread(id: string, body: CreateThreadBody | undefined): Promise<ThreadSummary> {
    this.mustGet(id);
    const from = body?.from?.trim();
    const up = this.upstream(id);
    try {
      const row = from ? await up.forkThread(from) : await up.newThread();
      return toThreadSummary(row, this.pending.countsByThread(id));
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Thread not found') throw new HttpError(404, message);
      // A thread minted and never prompted has no adapter-side conversation
      // to branch from, which is the caller's timing rather than a fault.
      if (message === NOTHING_TO_FORK) throw new HttpError(409, message);
      throw new HttpError(500, `Failed to create thread: ${message}`);
    }
  }

  /**
   * Makes one of a session's threads current. The browsers watching it are
   * dropped and reconnect onto the new one.
   */
  selectThread(id: string, threadId: string): ThreadSummary {
    this.mustGet(id);
    const row = getThread(this.db, threadId);
    if (!row || row.session_id !== id) throw new HttpError(404, 'Thread not found');
    return toThreadSummary(this.upstream(id).switchThread(threadId));
  }

  // --- boot reconciliation --------------------------------------------------

  /**
   * Aligns the stored rows with what Docker runs: adopts live
   * containers, marks missing ones stopped, and re-attaches the egress proxy.
   * Upstream connections are re-established on first use.
   */
  async reconcile(): Promise<void> {
    this.pending.clearStale();
    const live = new Map(
      (await dk.listSessionContainers()).map((c) => [c.sessionId, c]),
    );
    for (const row of this.allRows()) {
      const container = live.get(row.id);
      if (!container) {
        if (row.status === 'running') {
          log.session(row.id).warn('container missing at boot; marking stopped');
          this.setStatus(row.id, 'stopped');
        }
        continue;
      }
      if (container.id !== row.container_id) {
        this.db
          .prepare('UPDATE sessions SET container_id = ? WHERE id = ?')
          .run(container.id, row.id);
      }
      this.setStatus(row.id, container.running ? 'running' : 'stopped');
      // A turn cannot survive an orchestrator restart: the upstream
      // connection that owned it is gone, on every thread of the session.
      clearSessionTurns(this.db, row.id);
      await dk.ensureProxyAttached(row.network_name, this.cfg);
    }
    log.info('boot reconciliation complete', { sessions: this.allRows().length });
  }

  /**
   * Re-attaches the egress proxy to every running session's network. Returns
   * the ids of the sessions where that failed.
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

  /** Periodic housekeeping on every upstream. */
  maintenance(): void {
    for (const up of this.upstreams.values()) up.maintenance();
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
): ThreadSummary {
  return {
    id: row.id,
    acpSessionId: row.acp_session_id,
    title: row.title,
    ordinal: row.ordinal,
    turnActive: row.turn_active === 1,
    pendingCount: row.acp_session_id ? (pendingByThread.get(row.acp_session_id) ?? 0) : 0,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

/** An error carrying the HTTP status the API should answer with. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
