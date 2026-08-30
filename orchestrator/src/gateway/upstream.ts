import { client as acpClient, type ClientConnection } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable } from 'node:stream';
import type { Config } from '../config.ts';
import { appendAcpLog, pruneAcpLog, type Db, type SessionRow } from '../db.ts';
import * as dk from '../docker.ts';
import { log, type Logger } from '../log.ts';
import { Broadcast } from './broadcast.ts';
import type { PendingStore } from './pending.ts';

/**
 * One persistent ACP client per session, connected to the adapter inside the
 * session container over a long-lived docker exec.
 *
 * The orchestrator owns this connection, not a browser, so a turn runs to
 * completion whoever is watching. Thread replay belongs to the adapter's own
 * session/load.
 */

/** The modes an adapter advertises for a thread, and the one it is in. */
interface SessionModeState {
  currentModeId: string;
  availableModes: Array<{ id: string }>;
}

/**
 * One thing about a thread the adapter lets a client set, and its current
 * value. `category` says what the option is for, which is how the model
 * selector is found without depending on the adapter's own id for it.
 */
interface SessionConfigOption {
  id: string;
  category?: string | null;
  currentValue?: string;
  options?: Array<{ value: string }>;
}

/** A browser attached to this session, as seen from the upstream side. */
export interface DownstreamHandle {
  readonly id: number;
  /** Bumped whenever this browser sends something; picks the permission target. */
  lastActiveAt: number;
  /** Sends a notification to this browser. */
  notify(method: string, params: unknown): void;
  /** Sends a request to this browser and awaits its answer. */
  request(method: string, params: unknown): Promise<unknown>;
}

/** Pass-through parser, leaving params and their _meta untouched. */
const raw = <T = unknown>(params: unknown): T => params as T;

/** How often a failed adapter spawn is retried before the session errors. */
const MAX_SPAWN_ATTEMPTS = 3;

/** Wait before each retry, in milliseconds. */
const SPAWN_BACKOFF_MS = [1000, 3000, 8000];

/** JSON-RPC code the ACP SDK uses for a resource that does not exist. */
const RESOURCE_NOT_FOUND = -32002;

/**
 * The mode a fresh thread is switched into, when the adapter advertises one
 * by that id. An adapter that offers no such mode is left in whichever mode
 * it starts in.
 */
const DEFAULT_MODE_ID = 'auto';

/**
 * The model a fresh thread is put on, when the adapter offers it. An adapter
 * that offers no such model leaves the thread on whichever one it starts on.
 */
const DEFAULT_MODEL_ID = 'opus';

/**
 * The value to select for a wanted model: the name itself when the adapter
 * offers it, else a bracketed variant of it such as `opus[1m]`, which is the
 * same model with a different context window. A name that merely starts the
 * same way, such as `opusplan`, is a different model and never matches.
 */
function pickModel(options: Array<{ value: string }>, wanted: string): string | null {
  if (options.some((option) => option.value === wanted)) return wanted;
  return options.find((option) => option.value.startsWith(`${wanted}[`))?.value ?? null;
}

/** True when the adapter reported a missing thread rather than a failure. */
function isResourceNotFound(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === RESOURCE_NOT_FOUND;
}

/** The orchestrator's own ACP connection to one session's adapter. */
export class UpstreamSession {
  private exec: dk.AdapterExec | null = null;
  private conn: ClientConnection | null = null;
  private initializeResponse: unknown = null;
  private starting: Promise<void> | null = null;
  /** Who each adapter update goes to; see broadcast.ts. */
  private readonly downstreams: Broadcast;
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
    this.downstreams = new Broadcast(sessionId);
  }

  /** How many browsers are attached to this session. */
  get attachedCount(): number {
    return this.downstreams.size;
  }

  /** Whether the adapter connection is up. */
  get isConnected(): boolean {
    return this.conn !== null;
  }

  /** The initialize response to hand browsers, cached verbatim. */
  get cachedInitialize(): unknown {
    return this.initializeResponse;
  }

  /** Adds a browser to the broadcast set. */
  attach(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
    this.slog.info('downstream attached', { attached: this.downstreams.size });
  }

  /** Removes a browser from the broadcast set, leaving the upstream running. */
  detach(handle: DownstreamHandle): void {
    this.downstreams.remove(handle);
    this.slog.info('downstream detached', { attached: this.downstreams.size });
  }

  /** This session's stored row. Throws once the session is gone. */
  private row(): SessionRow {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(this.sessionId) as SessionRow | undefined;
    if (!row) throw new Error(`Session ${this.sessionId} not found`);
    return row;
  }

  /** Marks the session as active now, which holds off the reaper. */
  private touch(): void {
    this.db
      .prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')
      .run(Date.now(), this.sessionId);
  }

  /** Records whether a prompt turn is running, and marks the session active. */
  private setTurnActive(active: boolean): void {
    this.db
      .prepare('UPDATE sessions SET turn_active = ?, last_active_at = ? WHERE id = ?')
      .run(active ? 1 : 0, Date.now(), this.sessionId);
  }

  /**
   * Brings up the container, the exec and the ACP session. Concurrent callers
   * share one attempt.
   *
   * The guard is the cached initialize response, not the connection: the
   * connection exists from the moment the exec stream is wired up, but its
   * handshake takes a few hundred milliseconds, and a browser arriving inside
   * that window has to wait for the handshake.
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

  /** Starts the container and spawns the adapter, retrying with a backoff. */
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

  /**
   * Spawns the adapter, performs the ACP handshake, and either replays the
   * stored thread or starts a fresh one.
   */
  private async spawnAndInitialize(row: SessionRow): Promise<void> {
    const cmd = JSON.parse(row.agent_cmd) as string[];
    const exec = await dk.spawnAdapterExec(row.container_id!, cmd, dk.WORKSPACE_DIR);
    this.exec = exec;

    // stderr is log-only: the adapter sends its console logging there to
    // keep stdout clean for protocol.
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

    // Empty capabilities: no fs, no terminal, no elicitation, which confines
    // client-bound traffic to the two methods handled above.
    this.initializeResponse = await conn.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    this.slog.info('adapter initialized', { workingDir: dk.WORKSPACE_DIR });

    const replayed = row.acp_session_id
      ? await this.loadSession(conn, row.acp_session_id)
      : false;
    if (!replayed) await this.newSession(conn);
  }

  /**
   * Replays a stored thread. Returns false when the adapter no longer holds
   * it, which tells the caller to start a fresh one.
   *
   * A missing thread is a legitimate state: the agent SDK writes a transcript
   * only once a prompt has run, so an id minted by session/new and never
   * prompted does not survive the container stopping. Any other error is
   * rethrown, which keeps a transient fault from discarding a live thread.
   */
  private async loadSession(conn: ClientConnection, acpSessionId: string): Promise<boolean> {
    try {
      await conn.agent.request('session/load', {
        sessionId: acpSessionId,
        cwd: dk.WORKSPACE_DIR,
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
  private async newSession(conn: ClientConnection): Promise<void> {
    const res = (await conn.agent.request('session/new', {
      cwd: dk.WORKSPACE_DIR,
      mcpServers: [],
    })) as {
      sessionId?: string;
      modes?: SessionModeState | null;
      configOptions?: SessionConfigOption[] | null;
    };
    if (!res?.sessionId) throw new Error('session/new returned no sessionId');
    this.db
      .prepare('UPDATE sessions SET acp_session_id = ? WHERE id = ?')
      .run(res.sessionId, this.sessionId);
    this.slog.info('acp session created', { acpSessionId: res.sessionId });
    await this.applyDefaultMode(conn, res.sessionId, res.modes ?? null);
    await this.applyDefaultModel(conn, res.sessionId, res.configOptions ?? null);
  }

  /**
   * Puts a fresh thread into the default mode.
   *
   * Only the thread the adapter has just minted goes through here: a mode is
   * the user's choice from then on, and a reconnect must not undo it.
   */
  private async applyDefaultMode(
    conn: ClientConnection,
    acpSessionId: string,
    modes: SessionModeState | null,
  ): Promise<void> {
    if (!modes?.availableModes?.some((mode) => mode.id === DEFAULT_MODE_ID)) return;
    if (modes.currentModeId === DEFAULT_MODE_ID) return;
    try {
      await conn.agent.request('session/set_mode', {
        sessionId: acpSessionId,
        modeId: DEFAULT_MODE_ID,
      });
      this.slog.info('new thread set to the default mode', { modeId: DEFAULT_MODE_ID });
    } catch (err) {
      // A thread in the adapter's own mode is still usable, so this never
      // fails the spawn.
      this.slog.warn('could not set the default mode', { error: (err as Error).message });
    }
  }

  /**
   * Puts a fresh thread on the default model.
   *
   * Only the thread the adapter has just minted goes through here: the model
   * is the user's choice from then on, and a reconnect must not undo it.
   */
  private async applyDefaultModel(
    conn: ClientConnection,
    acpSessionId: string,
    configOptions: SessionConfigOption[] | null,
  ): Promise<void> {
    const selector = configOptions?.find((option) => option.category === 'model');
    if (!selector?.options) return;
    const value = pickModel(selector.options, DEFAULT_MODEL_ID);
    if (!value || value === selector.currentValue) return;
    try {
      await conn.agent.request('session/set_config_option', {
        sessionId: acpSessionId,
        configId: selector.id,
        value,
      });
      this.slog.info('new thread set to the default model', { modelId: value });
    } catch (err) {
      // A thread on the adapter's own model is still usable, so this never
      // fails the spawn.
      this.slog.warn('could not set the default model', { error: (err as Error).message });
    }
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

  /** Taps an adapter update and delivers it to the browsers it is meant for. */
  private onSessionUpdate(params: unknown): void {
    this.touch();
    this.tap('up', 'session/update', params);
    this.downstreams.update(params);
  }

  /**
   * Puts a permission request to the most recently active browser, or queues
   * it when none is attached. The adapter blocks until the answer arrives, so
   * an unattended turn pauses instead of proceeding without consent.
   */
  private onPermissionRequest(params: unknown): Promise<unknown> {
    this.touch();
    this.tap('up', 'session/request_permission', params);

    const target = this.downstreams.byRecency[0];
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

  /** Holds a permission request for a browser to answer, and sends a notification. */
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
   * Applies PERMISSION_FALLBACK once PERMISSION_HOLD_MINUTES has passed. The
   * deny fallback answers with a reject option from the request's own list,
   * never an invented one, and cancels the request when none is offered.
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

  /** Posts an approval-waiting notification to NTFY_URL, when one is set. */
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

  /** Puts every queued permission request to a browser that just attached. */
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

  /**
   * Forwards a browser request to the adapter, tracking prompt turns.
   *
   * `from` is the browser that asked, which decides who a replay goes to and
   * lets a prompt be echoed to everyone watching.
   */
  async forwardRequest(
    method: string,
    params: unknown,
    from?: DownstreamHandle,
  ): Promise<unknown> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    this.tap('down', method, params);

    const isPrompt = method === 'session/prompt';
    const isLoad = method === 'session/load';

    if (isPrompt) {
      this.setTurnActive(true);
      this.downstreams.beginPrompt(params);
    }
    if (isLoad && from) this.downstreams.beginReplay(from);

    try {
      return await conn.agent.request(method, params);
    } finally {
      if (isPrompt) {
        this.setTurnActive(false);
        this.downstreams.endPrompt();
      }
      if (isLoad && from) this.downstreams.endReplay(from);
    }
  }

  /** Forwards a browser notification to the adapter. */
  async forwardNotification(method: string, params: unknown): Promise<void> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    this.tap('down', method, params);
    if (method === 'session/cancel') this.setTurnActive(false);
    await conn.agent.notify(method, params);
  }

  /** Records one message in the debug log. A failed write never breaks the flow. */
  private tap(direction: 'up' | 'down', method: string, params: unknown): void {
    try {
      appendAcpLog(this.db, this.sessionId, direction, JSON.stringify({ method, params }));
    } catch (err) {
      this.slog.debug('acp_log write failed', { error: (err as Error).message });
    }
  }

  /**
   * Drops the connection when the adapter exits on its own. The next forwarded
   * message calls ensureStarted, which re-spawns and re-issues session/load.
   */
  private handleExecExit(code: number | null): void {
    if (this.closed || this.stopping) return;
    this.slog.warn('adapter exec exited', { code });
    this.teardownConnection();
    this.setTurnActive(false);
  }

  /** Closes the connection and kills the exec, tolerating either being gone. */
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

  /** Stops the connection deliberately, which suppresses the reconnect. */
  stop(): void {
    this.stopping = true;
    this.teardownConnection();
    this.setTurnActive(false);
    this.pending.failSession(this.sessionId, 'Session stopped');
  }

  /** Stops the connection for good and forgets every attached browser. */
  close(): void {
    this.closed = true;
    this.stop();
    this.downstreams.clear();
  }

  /** Periodic housekeeping: keeps the debug log within its ring size. */
  maintenance(): void {
    try {
      pruneAcpLog(this.db, this.sessionId);
    } catch (err) {
      this.slog.debug('acp_log prune failed', { error: (err as Error).message });
    }
  }
}
