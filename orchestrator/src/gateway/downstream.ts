import {
  agent as acpAgent,
  RequestError,
  type AgentConnection,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { WebSocket } from 'ws';
import { ACP_METHOD } from '../../../shared/acp.ts';
import { log } from '../log.ts';
import type { BoxManager } from '../boxes.ts';
import { threadOf } from './broadcast.ts';
import type { DownstreamHandle, UpstreamBox } from './upstream.ts';

/** Pass-through parser, leaving params and their _meta untouched. */
const raw = <T = unknown>(params: unknown): T => params as T;

/** Methods forwarded to the adapter verbatim, _meta intact. */
const FORWARDED_REQUESTS = [
  ACP_METHOD.sessionLoad,
  ACP_METHOD.sessionPrompt,
  ACP_METHOD.sessionList,
  ACP_METHOD.sessionSetMode,
  ACP_METHOD.sessionSetModel,
  ACP_METHOD.sessionSetConfigOption,
  ACP_METHOD.sessionFork,
  ACP_METHOD.sessionResume,
  ACP_METHOD.sessionClose,
  ACP_METHOD.sessionDelete,
  ACP_METHOD.sessionSelectProvider,
  ACP_METHOD.authenticate,
] as const;

/** Notifications forwarded to the adapter verbatim. */
const FORWARDED_NOTIFICATIONS = [ACP_METHOD.sessionCancel] as const;

/**
 * How many bytes one browser's socket may have waiting on it.
 *
 * Past this the socket is closed, so a browser that stopped reading cannot
 * grow the buffer without end. The browser reconnects and resumes from the
 * last message it holds.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Source of handle ids, unique within the process. */
let nextHandleId = 1;

/**
 * Validates a WebSocket upgrade against the token of the box it names.
 *
 * A browser cannot set an Authorization header on a WebSocket, so a client
 * offers the token as a `bearer.<token>` subprotocol next to the protocol it
 * speaks.
 *
 * @param protocolHeader The `Sec-WebSocket-Protocol` header of the upgrade.
 * @param boxToken The token of the box, or null when no such box exists.
 * @param subprotocol The protocol the endpoint speaks.
 * @returns Whether the upgrade may proceed, and the reason when it may not.
 */
export function checkUpgrade(
  protocolHeader: string | undefined,
  boxToken: string | null,
  subprotocol: string,
): { ok: true } | { ok: false; reason: string } {
  const offered = (protocolHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!offered.includes(subprotocol)) {
    return { ok: false, reason: `missing ${subprotocol} subprotocol` };
  }
  if (!boxToken) return { ok: false, reason: 'no such box' };
  const expected = `bearer.${boxToken}`;
  const presented = offered.find((p) => p.startsWith('bearer.'));
  if (!presented) return { ok: false, reason: 'missing bearer token subprotocol' };
  if (!timingSafeEqualStr(presented, expected)) {
    return { ok: false, reason: 'invalid bearer token' };
  }
  return { ok: true };
}

/** Constant-time compare that does not leak length via early return. */
function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** An ACP Stream over a WebSocket: one JSON-RPC message per text frame. */
export function wsStream(ws: WebSocket, boxId: string): Stream {
  const slog = log.box(boxId);

  const readable = new ReadableStream<unknown>({
    start(c) {
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          slog.warn('rejecting binary WS frame');
          return;
        }
        const text = data.toString('utf8');
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          slog.warn('rejecting non-JSON WS frame');
          return;
        }
        // Some ACP clients send a $/ping notification. Dropped here so the SDK
        // does not log it as an unknown method.
        if (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as { method?: string }).method === '$/ping' &&
          !('id' in (msg as object))
        ) {
          return;
        }
        try {
          c.enqueue(msg);
        } catch {
          // stream already closed
        }
      });
      const finish = (): void => {
        try {
          c.close();
        } catch {
          // already closed
        }
      };
      ws.on('close', finish);
      ws.on('error', finish);
    },
  });

  const writable = new WritableStream<unknown>({
    write(msg) {
      if (ws.readyState !== ws.OPEN) return;
      // Resolves when the send completes, so the writer waits for the socket.
      // A failed send resolves too; the read side notices the closed socket.
      return new Promise<void>((resolve) => {
        ws.send(JSON.stringify(msg), () => resolve());
        if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) return;
        slog.warn('closing a browser that cannot keep up', {
          buffered: ws.bufferedAmount,
        });
        // 1008 is "policy violation".
        ws.close(1008, 'too far behind');
      });
    },
    close() {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'gateway closed');
    },
  });

  return { readable, writable } as Stream;
}

/**
 * Wires one browser connection to the box's upstream, pinned to one of its
 * threads.
 *
 * Toward the browser the orchestrator speaks ACP as an agent and forwards
 * most requests to the adapter. Disconnecting only drops the handle from the
 * broadcast set.
 *
 * @param threadId The thread the URL named, or null to pin the box's most
 *   recently active thread.
 */
export function attachDownstream(
  ws: WebSocket,
  boxId: string,
  threadId: string | null,
  manager: BoxManager,
): void {
  const slog = log.box(boxId);
  const up: UpstreamBox = manager.upstream(boxId);
  // Declared before the handle, whose closures read it.
  let conn: AgentConnection | null = null;

  const handle: DownstreamHandle = {
    id: nextHandleId++,
    // Settled by the pin below, which has to wait for the adapter.
    acpThreadId: null,
    lastActiveAt: Date.now(),
    notify: (method, params) => {
      void conn?.client.notify(method, params).catch((err: Error) => {
        slog.debug('downstream notify failed', { error: err.message });
      });
    },
    request: (method, params, signal) => {
      if (!conn) return Promise.reject(new Error('downstream closed'));
      return conn.client.request(method, params, { cancellationSignal: signal });
    },
    // 1012 is "service restart". The browser reconnects, and the new
    // handshake pins the thread's current id.
    close: () => {
      try {
        ws.close(1012, 'thread reloaded');
      } catch {
        // already closing
      }
    },
  };

  // Attached before the pin, so the reaper counts the open socket at once.
  // Pinning starts the box, because it needs the adapter.
  up.attach(handle);
  const pinned = up.pin(handle, threadId);
  pinned.catch((err: Error) => {
    slog.error('could not pin the connection to a thread', { error: err.message });
    try {
      ws.close(1011, 'upstream unavailable');
    } catch {
      // already closing
    }
  });

  const app = acpAgent({ name: `boxes-downstream-${boxId}` })
    // Answered from the cached initialize response of the adapter that holds
    // the pinned thread, so its _meta extensions reach the browser intact.
    .onRequest(ACP_METHOD.initialize as string, raw, async () => {
      handle.lastActiveAt = Date.now();
      const acpThreadId = await pinned;
      const cached = up.initializeFor(acpThreadId);
      if (!cached) throw new Error('Upstream initialize unavailable');
      return cached;
    })
    // Answered with the pinned thread's id, so a reconnect does not start a
    // new conversation.
    .onRequest(ACP_METHOD.sessionNew as string, raw, async () => {
      handle.lastActiveAt = Date.now();
      const acpThreadId = await pinned;
      slog.info('session/new answered with the pinned thread', { acpThreadId });
      return { sessionId: acpThreadId };
    });

  for (const method of FORWARDED_REQUESTS) {
    app.onRequest(method as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      // Waits for the pin, so a client that loads a thread before
      // `initialize` is not served by a handle with no thread.
      const pin = await pinned;
      const asked = threadOf(params);
      // A request may name only the pinned thread, or no thread.
      if (asked !== undefined && asked !== pin) {
        throw RequestError.invalidParams(
          { sessionId: asked },
          'this connection is pinned to another thread',
        );
      }
      // The handle decides who gets a replay, and which adapter gets a
      // request that names no thread.
      const result = await up.forwardRequest(method, params, handle);
      // Queued permission requests go out after the replay, because a client
      // discards what it showed before the replay landed.
      if (method === ACP_METHOD.sessionLoad) up.flushPendingTo(handle);
      // A load returns its replay as notifications, so its result may be empty.
      return result ?? {};
    });
  }

  for (const method of FORWARDED_NOTIFICATIONS) {
    app.onNotification(method as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      await up.forwardNotification(method, params);
    });
  }

  conn = app.connect(wsStream(ws, boxId));
  const active = conn;

  const detach = (): void => {
    up.detach(handle);
    try {
      active.close();
    } catch {
      // already closed
    }
  };
  ws.on('close', detach);
  ws.on('error', detach);
}
