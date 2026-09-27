import { ACP_METHOD, ACP_SUBPROTOCOL } from '../../../../shared/acp.ts';
import {
  BOXES_META,
  REPLAY_METHOD,
  TURN_STATE_METHOD,
  type LoadMeta,
  type ReplayParams,
  type TurnStateParams,
} from '../../../../shared/types.ts';
import type {
  LoadThreadResponse,
  NewThreadResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ThreadConfigOption,
  ThreadModeState,
  ThreadNotification,
} from './acp-types.ts';

/**
 * The browser's ACP connection to the gateway: JSON-RPC 2.0 over a
 * WebSocket, one message per text frame.
 */

/** What the header shows about the connection. */
export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed';

/** The part of a turn-state notification the store reads. */
export type ThreadTurnState = Pick<TurnStateParams, 'speaking' | 'background'>;

/** Everything the store hands the client to react to. */
export interface AcpClientHandlers {
  /** A session/update notification, live or from a replay. */
  onUpdate(params: ThreadNotification): void;
  /**
   * The adapter asking permission. The promise resolves with the user's
   * answer, which unblocks the agent's turn.
   *
   * `signal` aborts when the gateway withdraws the question, for example
   * because another browser on the thread answered it first.
   */
  onPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  /** The handshake finished; a replay, if any, has been requested. */
  onReady(modes: ThreadModeState | null, configOptions: ThreadConfigOption[]): void;
  /** The connection state changed. */
  onState(state: ConnectionState): void;
  /**
   * The handshake failed, with the reason. A reconnect follows, and the view
   * can show the reason meanwhile.
   */
  onError(message: string): void;
  /**
   * The gateway said what this thread is doing: whether the agent is talking,
   * and what it has left running in the background. The gateway sends it
   * after every replay and on every change, so a browser that did not send
   * the prompt learns about the turn too.
   */
  onTurnState(state: ThreadTurnState): void;
  /**
   * Where a replay can be picked up from: the id of the last message the
   * store holds that a replay will name again. Null asks for the whole
   * thread.
   *
   * The client asks once per handshake, before the load that carries the
   * answer.
   */
  resumePoint(): string | null;
  /**
   * A replay is starting. True for `resumed` means the gateway sends only
   * what follows the resume point, so the store keeps what it holds. False
   * means the whole thread follows, and what the store holds is stale.
   *
   * It arrives before the first replayed update.
   */
  onReplay(resumed: boolean): void;
}

/** A JSON-RPC message, in either direction. */
interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Waits between reconnect attempts, in milliseconds, then holds at the last. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000];

/**
 * The JSON-RPC notification a peer sends to withdraw a request it is still
 * waiting on. Its params name the request by id.
 *
 * It belongs to the JSON-RPC layer under ACP, so it is not among the ACP
 * methods.
 */
const CANCEL_REQUEST_METHOD = '$/cancel_request';

/**
 * The params of a session/load: the thread, the workspace it runs in, and
 * where a replay of it can start.
 *
 * `resumeFrom` names the last message the caller holds. It travels in
 * `_meta`, which ACP reserves for extensions, so the gateway reads it and the
 * adapter ignores it. Without it, the load asks for the whole thread.
 */
export function loadParams(
  sessionId: string,
  resumeFrom?: string | null,
): {
  sessionId: string;
  cwd: string;
  mcpServers: never[];
  _meta?: Record<string, LoadMeta>;
} {
  return {
    sessionId,
    cwd: '/workspace',
    mcpServers: [],
    ...(resumeFrom ? { _meta: { [BOXES_META]: { resumeFrom } } } : {}),
  };
}

/** An error carrying a JSON-RPC error payload. */
class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** One thread's connection, which reconnects on its own until disposed. */
export class AcpClient {
  /** The open socket, or null between attempts. */
  private ws: WebSocket | null = null;
  /** The id for the next request this client sends. */
  private nextId = 1;
  /** The requests this client sent that wait for an answer, by id. */
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** The number of failed attempts since the last successful handshake. */
  private attempt = 0;
  /** The timer of the next reconnect, or null. */
  private retryTimer: number | null = null;
  /** True once `dispose` has run. */
  private disposed = false;
  /** The ACP thread id from the last session/new, or null. */
  private acpSessionId: string | null = null;
  /**
   * Requests from the gateway that are still being answered, by their
   * JSON-RPC id, so one it withdraws can be aborted.
   */
  private readonly answering = new Map<number | string, AbortController>();

  /**
   * @param url The WebSocket URL of the thread.
   * @param token The box token the gateway checks.
   * @param handlers The callbacks the client reports to.
   */
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: AcpClientHandlers,
  ) {}

  /** The ACP thread id of this connection, once known. */
  get sessionId(): string | null {
    return this.acpSessionId;
  }

  /** Opens the connection and runs the handshake. Safe to call once. */
  start(): void {
    this.open();
  }

  /** Closes for good: no further reconnect, and every pending call rejects. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failPending(new Error('client disposed'));
    try {
      this.ws?.close(1000, 'client disposed');
    } catch {
      // already closing
    }
    this.ws = null;
    this.handlers.onState('closed');
  }

  /** Sends a request and resolves with its result. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`not connected (${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Sends a notification, which expects no answer. */
  notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  // --- connection ----------------------------------------------------------

  /** Opens a socket and starts the handshake once it is up. */
  private open(): void {
    if (this.disposed) return;
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    // A browser cannot set an Authorization header on a WebSocket, so the
    // token travels as a subprotocol entry.
    const ws = new WebSocket(this.url, [ACP_SUBPROTOCOL, `bearer.${this.token}`]);
    this.ws = ws;

    ws.onopen = () => {
      void this.handshake();
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      this.receive(event.data);
    };
    ws.onerror = () => {
      // onclose always follows and handles the failure.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending(new Error('connection closed'));
      this.scheduleReconnect();
    };
  }

  /** Opens a new socket after the backoff for the current attempt. */
  private scheduleReconnect(): void {
    if (this.disposed) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.handlers.onState('reconnecting');
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, wait);
  }

  /**
   * Runs initialize, then loads the thread this connection is pinned to.
   *
   * The URL decides the thread, so the gateway answers session/new with only
   * its id. The replay, the modes and the config options come from the
   * session/load that follows.
   *
   * The load names a resume point, so a reconnect receives only the tail. It
   * does so only when the thread id is unchanged. A new id is a new
   * conversation, and nothing the store holds belongs to it.
   */
  private async handshake(): Promise<void> {
    try {
      await this.request(ACP_METHOD.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const created = await this.request<NewThreadResponse>(ACP_METHOD.sessionNew, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const resumeFrom =
        created.sessionId === this.acpSessionId ? this.handlers.resumePoint() : null;
      this.acpSessionId = created.sessionId;

      // Without a resume point the whole thread follows, so the store hears
      // it now. With one, the gateway's replay notice decides.
      if (!resumeFrom) this.handlers.onReplay(false);

      const loaded = await this.request<LoadThreadResponse>(
        ACP_METHOD.sessionLoad,
        loadParams(created.sessionId, resumeFrom),
      );

      this.attempt = 0;
      this.handlers.onState('ready');
      this.handlers.onReady(loaded?.modes ?? null, loaded?.configOptions ?? []);
    } catch (err) {
      // Reports why, then closes so the backoff opens a fresh connection.
      this.handlers.onError((err as Error).message);
      try {
        this.ws?.close(1011, 'handshake failed');
      } catch {
        // already closing
      }
    }
  }

  // --- messages ------------------------------------------------------------

  /** Dispatches one incoming frame. */
  private receive(text: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(text) as RpcMessage;
    } catch {
      return;
    }

    // A response to a request this client sent.
    if (msg.id !== undefined && msg.method === undefined) {
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        waiting.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      } else {
        waiting.resolve(msg.result);
      }
      return;
    }

    // A request from the agent side. An unknown method still gets an answer,
    // so the adapter does not block on it.
    if (msg.id !== undefined && msg.method) {
      void this.answer(msg);
      return;
    }

    if (msg.method === CANCEL_REQUEST_METHOD) {
      const requestId = (msg.params as { requestId?: number | string } | undefined)?.requestId;
      if (requestId !== undefined) this.answering.get(requestId)?.abort();
      return;
    }

    if (msg.method === ACP_METHOD.sessionUpdate) {
      this.handlers.onUpdate(msg.params as ThreadNotification);
      return;
    }

    if (msg.method === REPLAY_METHOD) {
      const params = msg.params as Partial<ReplayParams> | undefined;
      // Anything but an explicit yes counts as a full replay, the safe reading.
      this.handlers.onReplay(params?.resumed === true);
      return;
    }

    if (msg.method === TURN_STATE_METHOD) {
      const params = msg.params as Partial<TurnStateParams> | undefined;
      this.handlers.onTurnState({
        speaking: params?.speaking === true,
        background: Array.isArray(params?.background) ? params.background : [],
      });
    }
  }

  /** Answers a request from the gateway, turning a rejection into a JSON-RPC error. */
  private async answer(msg: RpcMessage): Promise<void> {
    const reply = (body: Partial<RpcMessage>): void => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
    };

    if (msg.method !== ACP_METHOD.sessionRequestPermission) {
      reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }

    const id = msg.id!;
    const withdrawn = new AbortController();
    this.answering.set(id, withdrawn);
    try {
      const result = await this.handlers.onPermission(
        msg.params as RequestPermissionRequest,
        withdrawn.signal,
      );
      reply({ result });
    } catch (err) {
      reply({ error: { code: -32603, message: (err as Error).message } });
    } finally {
      this.answering.delete(id);
    }
  }

  /** Rejects everything in flight, because the connection carrying it is gone. */
  private failPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
