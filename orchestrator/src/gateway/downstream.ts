import {
  agent as acpAgent,
  RequestError,
  type AgentConnection,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { WebSocket } from 'ws';
import { ACP_METHOD } from '../../../shared/acp.ts';
import { log } from '../log.ts';
import type { SessionManager } from '../sessions.ts';
import { threadOf } from './broadcast.ts';
import type { DownstreamHandle, UpstreamSession } from './upstream.ts';

/**
 * The browser-facing half of the gateway. Toward browsers the orchestrator
 * speaks ACP as an agent and forwards nearly everything on.
 *
 * JSON-RPC terminates on both sides, so each connection runs its own id space
 * and the SDK correlates request and response within it.
 */

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
 * A send the socket cannot take is buffered in this process, so a browser
 * that has stopped reading — a phone asleep with the tab open — would grow
 * that buffer for as long as its session keeps talking. Past this it is
 * closed instead, which costs it nothing it cannot get back: it reconnects
 * and resumes from the message it holds.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Source of handle ids, unique within the process. */
let nextHandleId = 1;

/**
 * Validates a WebSocket upgrade against the token of the session it names,
 * saying why when it refuses.
 *
 * A browser cannot set an Authorization header on a WebSocket, so a client
 * offers the token as a bearer.<token> subprotocol entry alongside the name
 * of the protocol it speaks. The gateway checks both here, on the upgrade
 * itself. Which subprotocol is negotiated is decided by the server's own
 * `handleProtocols`.
 *
 * `subprotocol` is the name the endpoint being connected to answers to, and
 * the caller names it because every endpoint checks its upgrades here while
 * each speaks a protocol of its own.
 *
 * `sessionToken` is the token of the session being connected to, so a token
 * reaches that session alone. An id no live session holds has none, which is
 * null here and refuses every offer: an upgrade never says which sessions
 * exist.
 */
export function checkUpgrade(
  protocolHeader: string | undefined,
  sessionToken: string | null,
  subprotocol: string,
): { ok: true } | { ok: false; reason: string } {
  const offered = (protocolHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!offered.includes(subprotocol)) {
    return { ok: false, reason: `missing ${subprotocol} subprotocol` };
  }
  if (!sessionToken) return { ok: false, reason: 'no such session' };
  const expected = `bearer.${sessionToken}`;
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

/**
 * An ACP Stream over a WebSocket: one JSON-RPC message per text frame.
 *
 * Exported so the tests can drive the write side directly.
 */
export function wsStream(ws: WebSocket, sessionId: string): Stream {
  const slog = log.session(sessionId);

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
        // Some ACP clients send a $/ping notification every 25s. JSON-RPC
        // forbids a reply to a notification, so drop it before the SDK logs
        // an unknown method. The dashboard sends none.
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
      // Settled by the send itself, so the writer waits for the socket
      // instead of handing it everything a session says at once. A send that
      // failed settles too: a socket that has gone is the read side's to
      // notice, and it closes the stream.
      return new Promise<void>((resolve) => {
        ws.send(JSON.stringify(msg), () => resolve());
        if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) return;
        slog.warn('closing a browser that cannot keep up', {
          buffered: ws.bufferedAmount,
        });
        // 1008 is "policy violation": this connection broke a rule of the
        // gateway rather than hitting a fault in it.
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
 * Wires one browser connection to the session's persistent upstream, pinned
 * to one of its threads.
 *
 * `threadId` is the thread the URL named, or null when it named none, as an
 * external ACP client does, which pins to the session's current thread
 * instead. Either way the pinning happens here rather than in the browser,
 * and the ACP contract stays a `session/new` that hands back an id the client
 * did not choose.
 *
 * Disconnecting drops the handle from the broadcast set and touches nothing
 * else.
 */
export function attachDownstream(
  ws: WebSocket,
  sessionId: string,
  threadId: string | null,
  manager: SessionManager,
): void {
  const slog = log.session(sessionId);
  const up: UpstreamSession = manager.upstream(sessionId);
  // Declared before the handle, so the closures below never read it in its
  // temporal dead zone.
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
    // 1012 is "service restart": the browser's own backoff brings it back,
    // and its fresh handshake pins whatever its thread is now. The only
    // caller is a respawn that could not bring this thread back under the id
    // the connection holds.
    close: () => {
      try {
        ws.close(1012, 'thread reloaded');
      } catch {
        // already closing
      }
    },
  };

  // Attached before the thread is settled: the socket is open and holding the
  // session up, which is what the reaper counts, and nothing is routed to a
  // handle that has no thread yet. Attaching is also what brings a stopped
  // session back up, because pinning needs the adapter to answer for the
  // thread.
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

  const app = acpAgent({ name: `boxes-downstream-${sessionId}` })
    // Answered from the cached upstream response, so its _meta extensions
    // reach the browser intact.
    .onRequest(ACP_METHOD.initialize as string, raw, async () => {
      handle.lastActiveAt = Date.now();
      await up.ensureStarted();
      const cached = up.cachedInitialize;
      if (!cached) throw new Error('Upstream initialize unavailable');
      return cached;
    })
    // This connection is about one thread of the session — the one the URL
    // named, or the session's current one — so hand back that thread's ACP
    // id rather than starting a second conversation on every reconnect.
    // Which thread that is, is decided outside ACP, so the contract a client
    // speaks does not change.
    .onRequest(ACP_METHOD.sessionNew as string, raw, async () => {
      handle.lastActiveAt = Date.now();
      const acpThreadId = await pinned;
      slog.info('session/new answered with the pinned thread', { acpThreadId });
      return { sessionId: acpThreadId };
    });

  for (const method of FORWARDED_REQUESTS) {
    app.onRequest(method as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      // Every forwarded request waits for the pin. A client that knows a
      // thread id and loads it before saying hello would otherwise be
      // answered by a handle with no thread: its replay goes nowhere, and
      // the questions waiting on that thread are not flushed to it.
      const pin = await pinned;
      const asked = threadOf(params);
      // And it asks about the thread this connection is pinned to, or about
      // no thread at all. Another thread's id would route that thread's
      // replay here alone, and echo this connection's prompt where nobody is
      // watching.
      if (asked !== undefined && asked !== pin) {
        throw RequestError.invalidParams(
          { sessionId: asked },
          'this connection is pinned to another thread',
        );
      }
      // The handle goes with the request: a replay belongs to the browser
      // that asked for it, and a prompt is echoed on that browser's behalf.
      const result = await up.forwardRequest(method, params, handle);
      // Queued permission requests wait for the replay rather than going out
      // the moment the socket opens. A client rebuilds its whole thread from
      // the replay, so a question delivered before it lands is thrown away
      // with everything else that was on screen, and it is sent only once.
      if (method === ACP_METHOD.sessionLoad) up.flushPendingTo(handle);
      // An empty answer is not an error: session/load delivers the replay as
      // session/update notifications rather than as its result.
      return result ?? {};
    });
  }

  for (const method of FORWARDED_NOTIFICATIONS) {
    app.onNotification(method as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      await up.forwardNotification(method, params);
    });
  }

  conn = app.connect(wsStream(ws, sessionId));
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
