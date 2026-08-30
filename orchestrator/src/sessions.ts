import { randomBytes } from 'node:crypto';
import type {
  CreateSessionBody,
  DockerState,
  SessionDetail,
  SessionSummary,
} from '../../shared/types.ts';
import type { Config } from './config.ts';
import type { EgressManager } from './egress.ts';
import { nextSubnetIndex, type Db, type SessionRow } from './db.ts';
import * as dk from './docker.ts';
import { log } from './log.ts';
import { PendingStore } from './gateway/pending.ts';
import { UpstreamSession } from './gateway/upstream.ts';
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

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly egress: EgressManager,
  ) {
    this.pending = new PendingStore(db);
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

  /** The persistent upstream for a session, created on first use. */
  upstream(id: string): UpstreamSession {
    let up = this.upstreams.get(id);
    if (!up) {
      up = new UpstreamSession(id, this.db, this.cfg, this.pending, (status) =>
        this.setStatus(id, status),
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
      ws_volume: dk.names.wsVolume(id),
      home_volume: dk.names.homeVolume(id),
      status: 'creating',
      acp_session_id: null,
      turn_active: 0,
      created_at: now,
      last_active_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
           network_name, subnet, ws_volume, home_volume, status, acp_session_id,
           turn_active, created_at, last_active_at)
         VALUES (@id, @name, @profile, @image, @agent_cmd, @container_id,
           @network_name, @subnet, @ws_volume, @home_volume, @status, @acp_session_id,
           @turn_active, @created_at, @last_active_at)`,
      )
      .run(row);

    const slog = log.session(id);
    try {
      await dk.createNetwork(row.network_name, subnet, id);
      await dk.ensureProxyAttached(row.network_name, this.cfg);
      await dk.createVolume(row.ws_volume, id);
      await dk.createVolume(row.home_volume, id);
      const containerId = await dk.createContainer(
        {
          sessionId: id,
          image: row.image,
          networkName: row.network_name,
          subnet,
          wsVolume: row.ws_volume,
          homeVolume: row.home_volume,
          profile,
          egress: {
            claudeOauthToken: this.egress.sessionValue('claude', profile.claudeOauthToken),
            ghToken: this.egress.sessionValue('github', profile.ghToken),
            caCertificate: this.egress.caCertificate(),
          },
        },
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
    const row = this.mustGet(id);
    if (!row.container_id) throw new HttpError(409, 'Session has no container');
    await dk.startContainer(row.container_id);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    this.setStatus(id, 'running');
    // The upstream reconnects on the next forwarded message, which re-issues
    // session/load and restores the thread.
    return this.detail(id);
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
    // The volumes hold the agent's work and the adapter's thread history.
    // Nothing else refers to them once the session is gone, so a session that
    // is deleted takes them with it rather than leaving them orphaned.
    await dk.removeVolume(row.ws_volume);
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
    return Promise.all(
      rows.map(async (row) => this.summarize(row, counts.get(row.id) ?? 0)),
    );
  }

  /** Builds a summary, resolving the container state against Docker. */
  private async summarize(row: SessionRow, pendingCount: number): Promise<SessionSummary> {
    const dockerState = (await dk.containerState(row.container_id)) as DockerState;
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      status: row.status,
      dockerState,
      turnActive: row.turn_active === 1,
      pendingCount,
      attachedCount: this.upstreams.get(row.id)?.attachedCount ?? 0,
      wsToken: this.cfg.WS_AUTH_TOKEN,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /** A summary plus the Docker object names the detail view shows. */
  async detail(id: string): Promise<SessionDetail> {
    const row = this.mustGet(id);
    const summary = await this.summarize(row, this.pending.countForSession(id));
    return {
      ...summary,
      image: row.image,
      containerId: row.container_id,
      networkName: row.network_name,
      subnet: row.subnet,
      wsVolume: row.ws_volume,
      homeVolume: row.home_volume,
      acpSessionId: row.acp_session_id,
      proxyAttached: await dk.isProxyAttached(row.network_name, this.cfg),
    };
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
      // connection that owned it is gone.
      this.db.prepare('UPDATE sessions SET turn_active = 0 WHERE id = ?').run(row.id);
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

/** An error carrying the HTTP status the API should answer with. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
