/**
 * The ACP connection of the browser to the gateway. It uses JSON-RPC 2.0 over
 * a WebSocket, with one message per text frame.
 */

import { ACP_METHOD, ACP_SUBPROTOCOL } from '../../../../shared/acp.ts';
import {
  BOXES_META,
  type LoadMeta,
  REPLAY_METHOD,
  type ReplayParams,
  TURN_STATE_METHOD,
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

/** The connection state that the header shows. */
export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed';

/** The part of a turn-state notification that the store reads. */
export type ThreadTurnState = Pick<TurnStateParams, 'speaking' | 'background'>;

/** The callbacks that the store gives the client. */
export interface AcpClientHandlers {
  /**
   * Receives a session/update notification, live or from a replay.
   *
   * @param params The notification params.
   */
  onUpdate(params: ThreadNotification): void;
  /**
   * Called when the adapter asks for permission.
   *
   * @param params The permission request.
   * @param signal Aborts when the gateway withdraws the question, for example
   *   because another browser on the thread answered it first.
   * @returns The answer of the user, which unblocks the turn of the agent.
   */
  onPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  /**
   * Called when the handshake finished. The client already requested a replay, if there is one.
   *
   * @param modes The modes of the adapter, or null when it has none.
   * @param configOptions The config options of the thread.
   */
  onReady(modes: ThreadModeState | null, configOptions: ThreadConfigOption[]): void;
  /**
   * Receives each new connection state.
   *
   * @param state The new state.
   */
  onState(state: ConnectionState): void;
  /**
   * Receives the reason of a failed handshake. A reconnect follows, and the
   * view can show the reason meanwhile.
   *
   * @param message The reason.
   */
  onError(message: string): void;
  /**
   * Called when the gateway reports the turn state of the thread. The state
   * says whether the agent speaks, and which tasks it left running in the
   * background. The gateway sends it after every replay and on every change,
   * so a browser that did not send the prompt also learns about the turn.
   *
   * @param state The turn state.
   */
  onTurnState(state: ThreadTurnState): void;
  /**
   * Gives the point where a replay can continue. The point is the id of the
   * last message that the store holds and that a replay will name again.
   *
   * The client asks once per handshake, before the load that carries the
   * answer.
   *
   * @returns The resume point, or null to ask for the whole thread.
   */
  resumePoint(): string | null;
  /**
   * Called when a replay starts, before the first replayed update.
   *
   * @param resumed True when the gateway sends only what follows the resume
   *   point, so the store keeps what it holds. False when the whole thread
   *   follows, and what the store holds is stale.
   * @param truncated True when the gateway does not hold the oldest messages
   *   of the thread, so the replay lacks them.
   */
  onReplay(resumed: boolean, truncated: boolean): void;
}

/** A JSON-RPC message, in either direction. */
interface RpcMessage {
  /** The protocol version. */
  jsonrpc: '2.0';
  /** The id of a request, which its response repeats. A notification has none. */
  id?: number | string;
  /** The method of a request or a notification. */
  method?: string;
  /** The params of a request or a notification. */
  params?: unknown;
  /** The result of a successful response. */
  result?: unknown;
  /** The error of a failed response. */
  error?: { code: number; message: string; data?: unknown };
}

/** The waits between reconnect attempts, in milliseconds. After the list, the client waits {@link MAX_BACKOFF_MS}. */
const BACKOFF_MS = [500, 1000, 2000, 5000];
/** The wait once the list is used up, in milliseconds. */
const MAX_BACKOFF_MS = 10_000;

/**
 * The JSON-RPC notification a peer sends to withdraw a request it is still
 * waiting on. Its params name the request by id.
 *
 * It belongs to the JSON-RPC layer under ACP, so it is not among the ACP
 * methods.
 */
const CANCEL_REQUEST_METHOD = '$/cancel_request';

/**
 * Builds the params of a session/load, with the thread, the workspace that it
 * runs in, and the start point of a replay.
 *
 * `resumeFrom` and `full` travel in `_meta`, which ACP reserves for
 * extensions, so the gateway reads them and the adapter ignores them. Without
 * either, the load asks for the whole thread as the gateway holds it.
 *
 * @param sessionId The id of the ACP thread.
 * @param resumeFrom The last message the caller holds.
 * @param full True to ask for the full history, replayed by the adapter again.
 * @returns The params of the session/load request.
 */
export function loadParams(
  sessionId: string,
  resumeFrom?: string | null,
  full = false,
): {
  sessionId: string;
  cwd: string;
  mcpServers: never[];
  _meta?: Record<string, LoadMeta>;
} {
  const meta: LoadMeta = {
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(full ? { full } : {}),
  };
  return {
    sessionId,
    cwd: '/workspace',
    mcpServers: [],
    ...(Object.keys(meta).length > 0 ? { _meta: { [BOXES_META]: meta } } : {}),
  };
}

/** An error with a JSON-RPC error payload. */
class RpcError extends Error {
  /**
   * @param message The error message.
   * @param code The JSON-RPC error code.
   * @param data The optional error data.
   */
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** The connection of one thread. It reconnects automatically until `dispose` runs. */
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
   * The requests from the gateway that still wait for an answer, by JSON-RPC
   * id. The client aborts a request that the gateway withdraws.
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

  /** Opens the connection and runs the handshake. Call it only once. */
  start(): void {
    this.open();
  }

  /** Closes the connection permanently. The client stops reconnecting, and every pending call rejects. */
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

  /**
   * Sends a request.
   *
   * @param method The JSON-RPC method.
   * @param params The params of the request.
   * @returns The result of the request.
   * @throws {Error} When the socket is not open, when the connection closes or when the peer answers with an error.
   */
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

  /**
   * Sends a notification, which expects no answer.
   *
   * @param method The JSON-RPC method.
   * @param params The params of the notification.
   */
  notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

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
    const wait = BACKOFF_MS[this.attempt] ?? MAX_BACKOFF_MS;
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
   * The URL selects the thread, so the gateway answers session/new with only
   * its id. The replay, the modes and the config options come from the
   * session/load that follows.
   *
   * The load names a resume point, so a reconnect receives only the tail. The
   * load does so only when the thread id is unchanged. A new id is a new
   * conversation, and nothing that the store holds belongs to it.
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

      // Without a resume point, the whole thread follows, so the store learns
      // it now. With a resume point, the replay notice of the gateway decides.
      if (!resumeFrom) this.handlers.onReplay(false, false);

      const loaded = await this.request<LoadThreadResponse>(
        ACP_METHOD.sessionLoad,
        loadParams(created.sessionId, resumeFrom),
      );

      this.attempt = 0;
      this.handlers.onState('ready');
      this.handlers.onReady(loaded?.modes ?? null, loaded?.configOptions ?? []);
    } catch (err) {
      // Reports the reason, then closes the socket, so the backoff opens a new connection.
      this.handlers.onError((err as Error).message);
      try {
        this.ws?.close(1011, 'handshake failed');
      } catch {
        // already closing
      }
    }
  }

  /**
   * Dispatches one incoming frame.
   *
   * @param text The text of the frame.
   */
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
      void this.answer(msg, msg.id);
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
      this.handlers.onReplay(params?.resumed === true, params?.truncated === true);
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

  /**
   * Answers a request from the gateway, turning a rejection into a JSON-RPC error.
   *
   * @param msg The request.
   * @param id Its id, which the answer repeats.
   */
  private async answer(msg: RpcMessage, id: number | string): Promise<void> {
    const reply = (body: Partial<RpcMessage>): void => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
    };

    if (msg.method !== ACP_METHOD.sessionRequestPermission) {
      reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }

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

  /**
   * Rejects everything in flight, because the connection carrying it is gone.
   *
   * @param err The error that each pending call rejects with.
   */
  private failPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
