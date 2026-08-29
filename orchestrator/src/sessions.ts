import { randomBytes } from 'node:crypto';
import type {
  CreateSessionBody,
  DockerState,
  SessionDetail,
  SessionSummary,
} from '../../shared/types.ts';
import type { Config } from './config.ts';
import { nextSubnetIndex, type Db, type SessionRow } from './db.ts';
import * as dk from './docker.ts';
import { log } from './log.ts';
import { PendingStore } from './gateway/pending.ts';
import { UpstreamSession } from './gateway/upstream.ts';
import { allocateSubnet } from './subnet.ts';

/**
 * Session lifecycle state machine (plan §8.2) and the owner of every
 * UpstreamSession. Docker is runtime truth; this table is metadata.
 */

/** argv for the pinned ACP adapter inside the session container. */
const AGENT_CMD = ['claude-agent-acp'];

export class SessionManager {
  private readonly upstreams = new Map<string, UpstreamSession>();
  readonly pending: PendingStore;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {
    this.pending = new PendingStore(db);
  }

  // --- helpers --------------------------------------------------------------

  getRow(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
  }

  private allRows(): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status != 'deleted' ORDER BY created_at DESC")
      .all() as SessionRow[];
  }

  private setStatus(id: string, status: SessionRow['status']): void {
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
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
   * Creates network, volumes and container, tearing everything down and
   * marking the session `error` if any step fails (plan §8.2).
   */
  async create(body: CreateSessionBody): Promise<SessionDetail> {
    const name = body.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (name.length > 100) throw new HttpError(400, 'name must be 100 characters or fewer');

    const repoUrl = body.repoUrl?.trim() || null;
    if (repoUrl && !/^https:\/\/[^\s]+$/.test(repoUrl)) {
      throw new HttpError(400, 'repoUrl must be an https:// URL');
    }

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
      repo_url: repoUrl,
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
        `INSERT INTO sessions (id, name, profile, repo_url, image, agent_cmd, container_id,
           network_name, subnet, ws_volume, home_volume, status, acp_session_id,
           turn_active, created_at, last_active_at)
         VALUES (@id, @name, @profile, @repo_url, @image, @agent_cmd, @container_id,
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
          repoUrl,
          profile,
        },
        this.cfg,
      );
      await dk.startContainer(containerId);
      this.db
        .prepare("UPDATE sessions SET container_id = ?, status = 'running' WHERE id = ?")
        .run(containerId, id);
      slog.info('session created', { name, repoUrl });
    } catch (err) {
      slog.error('session create failed; tearing down', { error: (err as Error).message });
      await this.teardownResources(id, { purge: true });
      this.setStatus(id, 'error');
      throw new HttpError(500, `Failed to create session: ${(err as Error).message}`);
    }

    return this.detail(id);
  }

  // --- start / stop / delete ------------------------------------------------

  async start(id: string): Promise<SessionDetail> {
    const row = this.mustGet(id);
    if (!row.container_id) throw new HttpError(409, 'Session has no container');
    await dk.startContainer(row.container_id);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    this.setStatus(id, 'running');
    // The upstream reconnects lazily on the next forwarded message, which
    // re-issues session/load and restores the thread (plan §8.6).
    return this.detail(id);
  }

  async stop(id: string): Promise<SessionDetail> {
    const row = this.mustGet(id);
    this.upstreams.get(id)?.stop();
    if (row.container_id) await dk.stopContainer(row.container_id);
    this.setStatus(id, 'stopped');
    log.session(id).info('session stopped');
    return this.detail(id);
  }

  async remove(id: string, purge: boolean): Promise<void> {
    const row = this.mustGet(id);
    this.upstreams.get(id)?.close();
    this.upstreams.delete(id);
    await this.teardownResources(id, { purge });
    this.db.prepare('DELETE FROM pending_requests WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM acp_log WHERE session_id = ?').run(id);
    this.setStatus(id, 'deleted');
    log.session(id).info('session deleted', { purge, name: row.name });
  }

  /** SIGTERM (10s) → rm container → disconnect proxy → rm network (§8.2). */
  private async teardownResources(id: string, opts: { purge: boolean }): Promise<void> {
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
    if (opts.purge) {
      // Volumes are kept unless explicitly purged: they hold the agent's
      // work and the adapter's replayable thread history.
      await dk.removeVolume(row.ws_volume);
      await dk.removeVolume(row.home_volume);
    }
  }

  // --- views ----------------------------------------------------------------

  private mustGet(id: string): SessionRow {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Session not found');
    return row;
  }

  async list(): Promise<SessionSummary[]> {
    const rows = this.allRows();
    const counts = this.pending.countsBySession();
    return Promise.all(
      rows.map(async (row) => this.summarize(row, counts.get(row.id) ?? 0)),
    );
  }

  private async summarize(row: SessionRow, pendingCount: number): Promise<SessionSummary> {
    const dockerState = (await dk.containerState(row.container_id)) as DockerState;
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      repoUrl: row.repo_url,
      status: row.status,
      dockerState,
      turnActive: row.turn_active === 1,
      pendingCount,
      attachedCount: this.upstreams.get(row.id)?.attachedCount ?? 0,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

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
      wsUrl: `wss://${this.cfg.BASE_DOMAIN}/ws/sessions/${id}/acp`,
      wsToken: this.cfg.WS_AUTH_TOKEN,
      proxyAttached: await dk.isProxyAttached(row.network_name, this.cfg),
    };
  }

  // --- boot reconciliation --------------------------------------------------

  /**
   * Docker is runtime truth (plan §8.2): adopt what is actually there, mark
   * what is gone, and re-ensure the proxy attachment on every session
   * network. Upstream connections are re-established lazily.
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
      // A turn cannot have survived our own restart: the upstream connection
      // that owned it is gone.
      this.db.prepare('UPDATE sessions SET turn_active = 0 WHERE id = ?').run(row.id);
      await dk.ensureProxyAttached(row.network_name, this.cfg);
    }
    log.info('boot reconciliation complete', { sessions: this.allRows().length });
  }

  /** 60s loop: proxy attachments drift when compose recreates it (§8.4). */
  async reconcileProxyAttachments(): Promise<string[]> {
    const warnings: string[] = [];
    for (const row of this.allRows()) {
      if (row.status !== 'running') continue;
      const ok = await dk.ensureProxyAttached(row.network_name, this.cfg);
      if (!ok) warnings.push(row.id);
    }
    return warnings;
  }

  closeAll(): void {
    for (const up of this.upstreams.values()) up.close();
    this.upstreams.clear();
  }

  maintenance(): void {
    for (const up of this.upstreams.values()) up.maintenance();
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
