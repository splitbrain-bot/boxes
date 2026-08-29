import { client as acpClient, type ClientConnection } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable } from 'node:stream';
import type { Config } from '../config.ts';
import { appendAcpLog, pruneAcpLog, type Db, type SessionRow } from '../db.ts';
import * as dk from '../docker.ts';
import { log, type Logger } from '../log.ts';
import type { PendingStore } from './pending.ts';

/**
 * One persistent ACP client per session, connected to `claude-agent-acp`
 * inside the session container over a long-lived `docker exec` (plan §8.3).
 *
 * This connection is the point of the whole system: it is owned by the
 * orchestrator, not by a browser. Turns run to completion regardless of who
 * is watching, and thread replay is delegated upstream to the adapter's own
 * `session/load` (plan §2) rather than reimplemented here.
 */

/** A browser attached to this session, as seen from the upstream side. */
export interface DownstreamHandle {
  readonly id: number;
  /** Bumped whenever this browser sends something; picks the permission target. */
  lastActiveAt: number;
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
}

/** Raw pass-through parser: keeps `_meta` extensions intact (verified §2). */
const raw = <T = unknown>(params: unknown): T => params as T;

const MAX_SPAWN_ATTEMPTS = 3;
const SPAWN_BACKOFF_MS = [1000, 3000, 8000];

/** JSON-RPC code the ACP SDK uses for `RequestError.resourceNotFound`. */
const RESOURCE_NOT_FOUND = -32002;

/** Did the adapter answer "I do not have that thread" rather than fail? */
function isResourceNotFound(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === RESOURCE_NOT_FOUND;
}

export class UpstreamSession {
  private exec: dk.AdapterExec | null = null;
  private conn: ClientConnection | null = null;
  private initializeResponse: unknown = null;
  private starting: Promise<void> | null = null;
  private readonly downstreams = new Set<DownstreamHandle>();
  private readonly slog: Logger;
  private closed = false;
  /** Guards against reconnect storms after a deliberate stop. */
  private stopping = false;

  constructor(
    readonly sessionId: string,
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly pending: PendingStore,
    private readonly onStatus: (status: SessionRow['status']) => void,
  ) {
    this.slog = log.session(sessionId);
  }

  get attachedCount(): number {
    return this.downstreams.size;
  }

  get isConnected(): boolean {
    return this.conn !== null;
  }

  /** The initialize response to hand browsers, cached verbatim (plan §8.3). */
  get cachedInitialize(): unknown {
    return this.initializeResponse;
  }

  attach(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
    this.slog.info('downstream attached', { attached: this.downstreams.size });
  }

  /** Upstream is deliberately unaffected — this property is the point (§8.3). */
  detach(handle: DownstreamHandle): void {
    this.downstreams.delete(handle);
    this.slog.info('downstream detached', { attached: this.downstreams.size });
  }

  private row(): SessionRow {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(this.sessionId) as SessionRow | undefined;
    if (!row) throw new Error(`Session ${this.sessionId} not found`);
    return row;
  }

  private touch(): void {
    this.db
      .prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')
      .run(Date.now(), this.sessionId);
  }

  private setTurnActive(active: boolean): void {
    this.db
      .prepare('UPDATE sessions SET turn_active = ?, last_active_at = ? WHERE id = ?')
      .run(active ? 1 : 0, Date.now(), this.sessionId);
  }

  /**
   * Brings up container + exec + ACP session, idempotently. Concurrent
   * callers share one attempt.
   *
   * The guard is the cached initialize response rather than the connection.
   * The connection object exists from the moment the exec stream is wired up,
   * but the handshake it carries takes a few hundred milliseconds; a browser
   * asking to initialize inside that window must wait for the handshake, not
   * be told the upstream is unavailable.
   */
  async ensureStarted(): Promise<void> {
    if (this.conn && this.initializeResponse) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    this.stopping = false;
    const row = this.row();
    if (!row.container_id) throw new Error('Session has no container');

    await dk.startContainer(row.container_id);
    await dk.ensureProxyAttached(row.network_name, this.cfg);

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const wait = SPAWN_BACKOFF_MS[attempt - 1] ?? 8000;
        this.slog.warn('retrying adapter spawn', { attempt, waitMs: wait });
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        await this.spawnAndInitialize(row);
        this.onStatus('running');
        return;
      } catch (err) {
        lastError = err;
        this.slog.error('adapter spawn failed', { attempt, error: (err as Error).message });
        this.teardownConnection();
      }
    }
    this.onStatus('error');
    throw new Error(
      `Adapter failed to start after ${MAX_SPAWN_ATTEMPTS} attempts: ${(lastError as Error)?.message}`,
    );
  }

  private async spawnAndInitialize(row: SessionRow): Promise<void> {
    const cmd = JSON.parse(row.agent_cmd) as string[];
    // Prefer the clone as cwd, fall back to the workspace root (plan §8.3).
    const hasRepo = row.repo_url ? await dk.hasRepoDir(row.container_id!) : false;
    const workingDir = hasRepo ? '/workspace/repo' : '/workspace';

    const exec = await dk.spawnAdapterExec(row.container_id!, cmd, workingDir);
    this.exec = exec;

    // stderr is log-only: the adapter's entrypoint redirects all console
    // logging there to keep stdout clean for protocol (plan §2).
    exec.stderr.setEncoding('utf8');
    exec.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.slog.debug('adapter stderr', { line: line.slice(0, 2000) });
      }
    });

    void exec.exited.then((code) => this.handleExecExit(code));

    const stream = this.makeStream(exec);
    const app = acpClient({ name: `boxes-${this.sessionId}` })
      .onNotification('session/update' as string, raw, ({ params }) => {
        this.onSessionUpdate(params);
      })
      .onRequest('session/request_permission' as string, raw, ({ params }) =>
        this.onPermissionRequest(params),
      );

    const conn = app.connect(stream);
    this.conn = conn;

    // Capabilities `{}`: no fs, no terminal, no elicitation. Verified in §2
    // to confine client-bound traffic to the two methods handled above.
    this.initializeResponse = await conn.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    this.slog.info('adapter initialized', { workingDir });

    const replayed = row.acp_session_id
      ? await this.loadSession(conn, row.acp_session_id, workingDir)
      : false;
    if (!replayed) await this.newSession(conn, workingDir);
  }

  /**
   * Replays a stored thread from the home volume (plan §2). Returns false when
   * the adapter no longer holds it, so the caller starts a fresh one.
   *
   * A missing thread is a legitimate state, not a failure: the agent SDK only
   * writes a transcript once a prompt has run, so an id minted by session/new
   * and never prompted does not survive the container stopping. Any other
   * error is rethrown, because falling back on a transient fault would
   * silently discard a thread that still exists.
   */
  private async loadSession(
    conn: ClientConnection,
    acpSessionId: string,
    workingDir: string,
  ): Promise<boolean> {
    try {
      await conn.agent.request('session/load', {
        sessionId: acpSessionId,
        cwd: workingDir,
        mcpServers: [],
      });
      this.slog.info('acp session loaded', { acpSessionId });
      return true;
    } catch (err) {
      if (!isResourceNotFound(err)) throw err;
      this.slog.warn('stored thread is gone; starting a fresh one', {
        acpSessionId,
        error: (err as Error).message,
      });
      this.db
        .prepare('UPDATE sessions SET acp_session_id = NULL WHERE id = ?')
        .run(this.sessionId);
      return false;
    }
  }

  /** Starts a fresh thread and records its id as this session's only one. */
  private async newSession(conn: ClientConnection, workingDir: string): Promise<void> {
    const res = (await conn.agent.request('session/new', {
      cwd: workingDir,
      mcpServers: [],
    })) as { sessionId?: string };
    if (!res?.sessionId) throw new Error('session/new returned no sessionId');
    this.db
      .prepare('UPDATE sessions SET acp_session_id = ? WHERE id = ?')
      .run(res.sessionId, this.sessionId);
    this.slog.info('acp session created', { acpSessionId: res.sessionId });
  }

  /** ACP Stream over the demuxed exec: ndJSON in, ndJSON out. */
  private makeStream(exec: dk.AdapterExec): Stream {
    const readable = Readable.toWeb(exec.stdout) as ReadableStream<Uint8Array>;
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          exec.stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
        }),
      close: () => {
        exec.stdin.end();
      },
    });
    return ndJsonStream(writable, readable);
  }

  private onSessionUpdate(params: unknown): void {
    this.touch();
    this.tap('up', 'session/update', params);
    for (const d of this.downstreams) {
      try {
        d.notify('session/update', params);
      } catch (err) {
        this.slog.warn('broadcast failed', { error: (err as Error).message });
      }
    }
  }

  /**
   * The adapter blocks on this request until we answer, which is exactly what
   * we want when nobody is watching: the turn pauses rather than proceeding
   * without consent (plan §8.3).
   */
  private onPermissionRequest(params: unknown): Promise<unknown> {
    this.touch();
    this.tap('up', 'session/request_permission', params);

    const target = [...this.downstreams].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (target) {
      return target.request('session/request_permission', params).catch((err) => {
        // The browser vanished mid-question: fall back to queueing so the
        // turn is not failed by a closed tab.
        this.slog.warn('permission forward failed; queueing', {
          error: (err as Error).message,
        });
        return this.queuePermission(params);
      });
    }
    return this.queuePermission(params);
  }

  private queuePermission(params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = this.pending.add(
        this.sessionId,
        '',
        'session/request_permission',
        params,
        { resolve, reject },
        this.cfg.PERMISSION_HOLD_MINUTES * 60_000,
        (timedOut) => this.applyPermissionFallback(timedOut.row.id, params, resolve),
      );
      this.slog.info('permission request queued', { pendingId: entry.row.id });
      void this.notifyNtfy();
    });
  }

  /**
   * After PERMISSION_HOLD_MINUTES apply PERMISSION_FALLBACK. `deny` answers
   * with the reject option taken from the request's own options list — never
   * an invented one, and never an approval (plan §8.3, §12.9).
   */
  private applyPermissionFallback(
    pendingId: number,
    params: unknown,
    resolve: (r: unknown) => void,
  ): void {
    if (this.cfg.PERMISSION_FALLBACK === 'hold') {
      this.slog.info('permission hold elapsed; still holding', { pendingId });
      return;
    }
    const options = (params as { options?: Array<{ optionId?: string; kind?: string }> })?.options;
    const reject = options?.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    this.pending.settle(pendingId);
    if (reject?.optionId) {
      this.slog.warn('permission denied by timeout fallback', {
        pendingId,
        optionId: reject.optionId,
      });
      resolve({ outcome: { outcome: 'selected', optionId: reject.optionId } });
    } else {
      this.slog.warn('permission cancelled by timeout fallback (no reject option offered)', {
        pendingId,
      });
      resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private async notifyNtfy(): Promise<void> {
    if (!this.cfg.NTFY_URL) return;
    try {
      await fetch(this.cfg.NTFY_URL, {
        method: 'POST',
        headers: { Title: 'Boxes: approval needed' },
        body: `Session ${this.row().name} is waiting for a permission decision.`,
      });
    } catch (err) {
      this.slog.warn('ntfy notification failed', { error: (err as Error).message });
    }
  }

  /** Deliver queued permission prompts to a browser that just attached. */
  flushPendingTo(handle: DownstreamHandle): void {
    for (const entry of this.pending.listForSession(this.sessionId)) {
      const params = JSON.parse(entry.row.params) as unknown;
      handle
        .request('session/request_permission', params)
        .then((result) => {
          if (this.pending.settle(entry.row.id)) entry.resolve(result);
        })
        .catch((err) => {
          this.slog.warn('pending permission delivery failed; leaving queued', {
            pendingId: entry.row.id,
            error: (err as Error).message,
          });
        });
    }
  }

  /** Forward a browser request upstream. Turn tracking lives here. */
  async forwardRequest(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    this.tap('down', method, params);

    const isPrompt = method === 'session/prompt';
    if (isPrompt) this.setTurnActive(true);
    try {
      return await conn.agent.request(method, params);
    } finally {
      if (isPrompt) this.setTurnActive(false);
    }
  }

  async forwardNotification(method: string, params: unknown): Promise<void> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    this.tap('down', method, params);
    if (method === 'session/cancel') this.setTurnActive(false);
    await conn.agent.notify(method, params);
  }

  private tap(direction: 'up' | 'down', method: string, params: unknown): void {
    try {
      appendAcpLog(this.db, this.sessionId, direction, JSON.stringify({ method, params }));
    } catch (err) {
      this.slog.debug('acp_log write failed', { error: (err as Error).message });
    }
  }

  private handleExecExit(code: number | null): void {
    if (this.closed || this.stopping) return;
    this.slog.warn('adapter exec exited', { code });
    this.teardownConnection();
    this.setTurnActive(false);
    // Reconnect lazily: the next forwarded message calls ensureStarted(),
    // which re-spawns and re-issues session/load to restore the thread.
  }

  private teardownConnection(): void {
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    this.conn = null;
    try {
      this.exec?.kill();
    } catch {
      // already gone
    }
    this.exec = null;
  }

  /** Deliberate stop (reaper, REST stop): do not auto-reconnect. */
  stop(): void {
    this.stopping = true;
    this.teardownConnection();
    this.setTurnActive(false);
    this.pending.failSession(this.sessionId, 'Session stopped');
  }

  close(): void {
    this.closed = true;
    this.stop();
    this.downstreams.clear();
  }

  maintenance(): void {
    try {
      pruneAcpLog(this.db, this.sessionId);
    } catch (err) {
      this.slog.debug('acp_log prune failed', { error: (err as Error).message });
    }
  }
}
