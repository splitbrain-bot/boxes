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
  LoadSessionResponse,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
} from './acp-types.ts';

/**
 * The browser's ACP connection to the gateway.
 *
 * Plain JSON-RPC 2.0 over a WebSocket, one message per text frame. The
 * gateway is client-agnostic — external ACP clients use the same endpoint —
 * so nothing here is a private arrangement with the orchestrator.
 *
 * There is no $/ping. Some ACP clients send one; it is not part of the
 * protocol, and the gateway drops it.
 */

/** What the header shows about the connection. */
export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed';

/** The part of a turn-state notification the store reads. */
export type ThreadTurnState = Pick<TurnStateParams, 'speaking' | 'background'>;

/** Everything the store hands the client to react to. */
export interface AcpClientHandlers {
  /** A session/update notification, live or from a replay. */
  onUpdate(params: SessionNotification): void;
  /**
   * The adapter asking permission. The promise resolves with the user's
   * answer, which is what unblocks the agent's turn.
   *
   * `signal` aborts when the gateway withdraws the question, which is what
   * happens when another browser on the thread answers it first. The card has
   * nothing left to answer then, and whatever it resolves with is discarded.
   */
  onPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  /** The handshake finished; a replay, if any, has been requested. */
  onReady(modes: SessionModeState | null, configOptions: SessionConfigOption[]): void;
  /** The connection state changed. */
  onState(state: ConnectionState): void;
  /**
   * The connection could not be brought up, and says why. A reconnect is
   * already on its way; this is the reason to put in front of the reader
   * while it runs.
   */
  onError(message: string): void;
  /**
   * The gateway said what this thread is doing: whether the agent is talking,
   * and what it has left running in the background. It says so once after
   * every replay and again on every transition, which is how a browser that
   * did not send the prompt knows there is one — and the only way any browser
   * learns about a monitor somebody started an hour ago.
   */
  onTurnState(state: ThreadTurnState): void;
  /**
   * Where a replay can be picked up from: the id of the last message the
   * store holds that a replay will name again, or null when it has nothing
   * to resume from and needs the thread whole.
   *
   * Asked once per handshake, before the load that carries the answer.
   */
  resumePoint(): string | null;
  /**
   * A replay is starting. `resumed` says the gateway is sending only what
   * follows the resume point, so what the store holds still stands. False
   * says the whole thread is coming and what the store holds is stale.
   *
   * It arrives before the first replayed update either way, which is what
   * lets the store decide once and fold everything after it the same way.
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
 * Not part of ACP itself but of the JSON-RPC layer under it, which is why it
 * is spelled here rather than with the ACP methods.
 */
const CANCEL_REQUEST_METHOD = '$/cancel_request';

/**
 * What a session/load asks for: the thread, the workspace it runs in, and
 * where a replay of it can start.
 *
 * `resumeFrom` names the last message the caller holds. It travels in
 * `_meta`, which ACP reserves for extensions, so the gateway reads it and the
 * adapter behind it ignores it. Left out, the load asks for the thread whole.
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

/** One box's connection, which reconnects on its own until closed. */
export class AcpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private attempt = 0;
  private retryTimer: number | null = null;
  private disposed = false;
  private acpSessionId: string | null = null;
  /**
   * Requests from the gateway that are still being answered, by their
   * JSON-RPC id, so one it withdraws can be aborted.
   */
  private readonly answering = new Map<number | string, AbortController>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: AcpClientHandlers,
  ) {}

  /** The ACP thread id this connection is talking about, once known. */
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

  private open(): void {
    if (this.disposed) return;
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    // The token travels as a subprotocol entry because a browser cannot set
    // an Authorization header on a WebSocket. The gateway selects the
    // subprotocol explicitly and reads the bearer entry as credentials.
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
      // onclose always follows, and carries the reason worth reporting.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending(new Error('connection closed'));
      this.scheduleReconnect();
    };
  }

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
   * initialize, then resume the thread this connection is pinned to.
   *
   * The gateway answers session/new with the bare `{ sessionId }`: which
   * thread a connection is on is decided outside ACP, so the answer names
   * that thread and says nothing else about it. The replay, the modes and the
   * config options all come from the session/load that follows.
   *
   * The load says how much of the thread the store already has, so a
   * reconnect is sent the tail rather than the whole conversation again. Only
   * when the thread is the one this connection was already on: an id that has
   * changed is a conversation that was re-minted under this connection, and
   * nothing the store holds belongs to it.
   */
  private async handshake(): Promise<void> {
    try {
      await this.request(ACP_METHOD.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const created = await this.request<NewSessionResponse>(ACP_METHOD.sessionNew, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const resumeFrom =
        created.sessionId === this.acpSessionId ? this.handlers.resumePoint() : null;
      this.acpSessionId = created.sessionId;

      // Nothing to resume from means the thread is coming whole whatever the
      // gateway answers, so the store is told now rather than waiting to be
      // told the only thing this can be. A load that does name a point waits:
      // only the gateway knows whether the point was there.
      if (!resumeFrom) this.handlers.onReplay(false);

      const loaded = await this.request<LoadSessionResponse>(
        ACP_METHOD.sessionLoad,
        loadParams(created.sessionId, resumeFrom),
      );

      this.attempt = 0;
      this.handlers.onState('ready');
      this.handlers.onReady(loaded?.modes ?? null, loaded?.configOptions ?? []);
    } catch (err) {
      // A failed handshake is a failed connection: report why, then close and
      // let the backoff bring up a fresh one rather than sitting half-open.
      // Without the reason the view is a reconnecting dot and nothing else.
      this.handlers.onError((err as Error).message);
      try {
        this.ws?.close(1011, 'handshake failed');
      } catch {
        // already closing
      }
    }
  }

  // --- messages ------------------------------------------------------------

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

    // A request from the agent side. Only one is expected, but an unknown
    // method must be answered rather than left blocking the adapter.
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
      this.handlers.onUpdate(msg.params as SessionNotification);
      return;
    }

    if (msg.method === REPLAY_METHOD) {
      const params = msg.params as Partial<ReplayParams> | undefined;
      // Anything but an explicit yes is read as the whole thread coming,
      // which is the answer that costs nothing to be wrong about.
      this.handlers.onReplay(params?.resumed === true);
      return;
    }

    if (msg.method === TURN_STATE_METHOD) {
      const params = msg.params as Partial<TurnStateParams> | undefined;
      // Read defensively: the notification is a message off the wire like any
      // other, and a field it omits is a field this thread knows nothing new
      // about.
      this.handlers.onTurnState({
        speaking: params?.speaking === true,
        background: Array.isArray(params?.background) ? params.background : [],
      });
    }
  }

  /** Answers a server-bound request, turning a rejection into a JSON-RPC error. */
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
