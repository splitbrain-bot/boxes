import { agent as acpAgent, type AgentConnection, type Stream } from '@agentclientprotocol/sdk';
import type { WebSocket } from 'ws';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import type { SessionManager } from '../sessions.ts';
import type { DownstreamHandle, UpstreamSession } from './upstream.ts';

/**
 * The browser-facing half of the gateway (plan §8.3). Toward browsers the
 * orchestrator speaks ACP as an agent; it is a near-transparent proxy.
 *
 * The gateway terminates JSON-RPC on both sides, so id remapping is inherent:
 * each connection runs its own id space and the SDK correlates
 * request/response within it. Nothing from one browser's id space ever
 * reaches the adapter's.
 */

const raw = <T = unknown>(params: unknown): T => params as T;

/** The subprotocol the server negotiates; the rest of the offer is credentials. */
export const ACP_SUBPROTOCOL = 'acp.v1';

/** Methods forwarded verbatim to the adapter, `_meta` intact (plan §8.3). */
const FORWARDED_REQUESTS = [
  'session/load',
  'session/prompt',
  'session/list',
  'session/set_mode',
  'session/set_model',
  'session/set_config_option',
  'session/fork',
  'session/resume',
  'session/close',
  'session/delete',
  'session/select_provider',
  'authenticate',
] as const;

const FORWARDED_NOTIFICATIONS = ['session/cancel'] as const;

let nextHandleId = 1;

/**
 * Validates the WS upgrade and returns the subprotocol to select.
 *
 * Browsers cannot set an Authorization header on a WebSocket, so acp-ui
 * offers the token as a `bearer.<token>` subprotocol entry alongside
 * `acp.v1` (verified §2). We validate the token here because Traefik
 * basicauth cannot cover this route (plan §2, §12.6).
 */
export function checkUpgrade(
  protocolHeader: string | undefined,
  cfg: Config,
): { ok: true; select: string } | { ok: false; reason: string } {
  const offered = (protocolHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!offered.includes(ACP_SUBPROTOCOL)) {
    return { ok: false, reason: 'missing acp.v1 subprotocol' };
  }
  const expected = `bearer.${cfg.WS_AUTH_TOKEN}`;
  const presented = offered.find((p) => p.startsWith('bearer.'));
  if (!presented) return { ok: false, reason: 'missing bearer token subprotocol' };
  if (!timingSafeEqualStr(presented, expected)) {
    return { ok: false, reason: 'invalid bearer token' };
  }
  return { ok: true, select: ACP_SUBPROTOCOL };
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

/** ACP Stream over a WebSocket: one JSON-RPC message per text frame (§2). */
function wsStream(ws: WebSocket, sessionId: string): Stream {
  const slog = log.session(sessionId);
  let controller: ReadableStreamDefaultController<unknown> | null = null;

  const readable = new ReadableStream<unknown>({
    start(c) {
      controller = c;
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
        // acp-ui sends a `$/ping` JSON-RPC *notification* every 25s. Per
        // JSON-RPC we must not reply; swallow it before the SDK sees it
        // and logs an unknown method (plan §2).
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
    cancel() {
      controller = null;
    },
  });

  const writable = new WritableStream<unknown>({
    write(msg) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(msg));
    },
    close() {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'gateway closed');
    },
  });

  return { readable, writable } as Stream;
}

/**
 * Wires one browser connection to the session's persistent upstream.
 * Disconnecting drops the handle from the broadcast set and touches nothing
 * else — that property is the point of the gateway (plan §8.3).
 */
export function attachDownstream(
  ws: WebSocket,
  sessionId: string,
  manager: SessionManager,
): void {
  const slog = log.session(sessionId);
  const up: UpstreamSession = manager.upstream(sessionId);
  // Declared before the handle so the closures below never touch it in its
  // temporal dead zone; assigned once the app is built.
  let conn: AgentConnection | null = null;

  const handle: DownstreamHandle = {
    id: nextHandleId++,
    lastActiveAt: Date.now(),
    notify: (method, params) => {
      void conn?.client.notify(method, params).catch((err: Error) => {
        slog.debug('downstream notify failed', { error: err.message });
      });
    },
    request: (method, params) => {
      if (!conn) return Promise.reject(new Error('downstream closed'));
      return conn.client.request(method, params);
    },
  };

  const app = acpAgent({ name: `boxes-downstream-${sessionId}` })
    // Answered locally from the cached upstream response so `_meta`
    // extensions (steering, promptQueueing) reach the browser intact (§8.3).
    .onRequest('initialize' as string, raw, async () => {
      handle.lastActiveAt = Date.now();
      await up.ensureStarted();
      const cached = up.cachedInitialize;
      if (!cached) throw new Error('Upstream initialize unavailable');
      return cached;
    })
    // One thread per Boxes session: if we already have an ACP session, hand
    // back its id rather than starting a second one (plan §8.3).
    .onRequest('session/new' as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      await up.ensureStarted();
      const existing = manager.getRow(sessionId)?.acp_session_id;
      if (existing) {
        slog.info('session/new answered with existing acp session', { existing });
        return { sessionId: existing };
      }
      return up.forwardRequest('session/new', params);
    });

  for (const method of FORWARDED_REQUESTS) {
    app.onRequest(method as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      const result = await up.forwardRequest(method, params);
      // acp-ui clears its messages and calls session/load, expecting replay
      // to arrive as session/update notifications from the adapter (§2).
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

  up.attach(handle);
  // Anything queued while nobody was watching goes to this browser now.
  up.flushPendingTo(handle);

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

  // Lazy start: attaching is enough to bring the session back up (§8.6).
  void up.ensureStarted().catch((err: Error) => {
    slog.error('upstream start failed on attach', { error: err.message });
    try {
      ws.close(1011, 'upstream unavailable');
    } catch {
      // already closing
    }
  });
}
