import Fastify from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type {
  AcpLogEntry,
  AcpLogPage,
  CreateSessionBody,
  HealthResponse,
} from '../../shared/types.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { checkUpgrade, attachDownstream } from './gateway/downstream.ts';
import { log } from './log.ts';
import { startProxyReconciler, startReaper } from './reaper.ts';
import { HttpError, SessionManager } from './sessions.ts';

const VERSION = '1.0.0';
const here = dirname(fileURLToPath(import.meta.url));
/** Dashboard bundle, copied into the image by the Dockerfile's build stage. */
const DASHBOARD_DIR = resolve(here, '../dashboard');

const cfg = config();
const db = openDb(cfg.DATA_DIR);
const manager = new SessionManager(db, cfg);

let proxyWarnings: string[] = [];

const app = Fastify({ logger: false });

// --- REST (behind Traefik basicauth; plan §8.5) -----------------------------

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  log.error('unhandled request error', { error: (err as Error).message });
  return reply.code(500).send({ error: 'Internal error' });
});

app.get('/healthz', async (): Promise<HealthResponse> => {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE status != 'deleted'")
    .get() as { n: number };
  return { ok: true, version: VERSION, sessions: row.n, proxyWarnings };
});

app.get('/api/sessions', async () => manager.list());

app.post('/api/sessions', async (req, reply) => {
  const created = await manager.create(req.body as CreateSessionBody);
  return reply.code(201).send(created);
});

app.get('/api/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  return manager.detail(id);
});

app.post('/api/sessions/:id/start', async (req) => {
  const { id } = req.params as { id: string };
  return manager.start(id);
});

app.post('/api/sessions/:id/stop', async (req) => {
  const { id } = req.params as { id: string };
  return manager.stop(id);
});

app.delete('/api/sessions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { purge } = req.query as { purge?: string };
  await manager.remove(id, purge === 'true' || purge === '1');
  return reply.code(204).send();
});

app.get('/api/sessions/:id/log', async (req): Promise<AcpLogPage> => {
  const { id } = req.params as { id: string };
  const { after, limit } = req.query as { after?: string; limit?: string };
  const afterId = Number(after ?? 0) || 0;
  const max = Math.min(Math.max(Number(limit ?? 200) || 200, 1), 1000);
  const entries = db
    .prepare(
      `SELECT id, direction, ts, payload FROM acp_log
       WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(id, afterId, max) as AcpLogEntry[];
  return { entries, cursor: entries.at(-1)?.id ?? afterId };
});

// --- Dashboard static files + SPA fallback (plan §8.5) ----------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

app.setNotFoundHandler((req, reply) => {
  if (req.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
  const url = req.url.split('?')[0] ?? '/';
  if (url.startsWith('/api') || url.startsWith('/ws')) {
    return reply.code(404).send({ error: 'Not found' });
  }

  // Serve a real asset when the path names one, else the SPA shell.
  const candidate = resolve(DASHBOARD_DIR, `.${normalize(url)}`);
  if (candidate.startsWith(DASHBOARD_DIR) && url !== '/' && existsSync(candidate)) {
    const ext = candidate.slice(candidate.lastIndexOf('.'));
    return reply
      .type(CONTENT_TYPES[ext] ?? 'application/octet-stream')
      .send(readFileSync(candidate));
  }
  const index = join(DASHBOARD_DIR, 'index.html');
  if (!existsSync(index)) return reply.code(404).send({ error: 'Dashboard not built' });
  return reply.type('text/html; charset=utf-8').send(readFileSync(index));
});

// --- WebSocket gateway (token-authed; bypasses basicauth, plan §2) ----------

const wss = new WebSocketServer({ noServer: true });
const WS_PATH = /^\/ws\/sessions\/([A-Za-z0-9_-]{1,64})\/acp$/;

app.server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  const match = WS_PATH.exec(url.split('?')[0] ?? '');
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const sessionId = match[1]!;

  const check = checkUpgrade(req.headers['sec-websocket-protocol'], cfg);
  if (!check.ok) {
    log.warn('rejected WS upgrade', { sessionId, reason: check.reason });
    // 4401 is the app-level "unauthorized" the plan specifies; the handshake
    // itself must fail with an HTTP status, so use 401 here.
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const row = manager.getRow(sessionId);
  if (!row || row.status === 'deleted') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    attachDownstream(ws, sessionId, manager);
  });
});

// --- boot -------------------------------------------------------------------

async function main(): Promise<void> {
  await manager.reconcile();
  startReaper(db, cfg, manager);
  startProxyReconciler(manager, (w) => {
    proxyWarnings = w;
  });

  await app.listen({ host: '0.0.0.0', port: cfg.PORT });
  log.info('orchestrator listening', { port: cfg.PORT, baseDomain: cfg.BASE_DOMAIN });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    manager.closeAll();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

main().catch((err: Error) => {
  log.error('fatal boot error', { error: err.message });
  process.exit(1);
});
