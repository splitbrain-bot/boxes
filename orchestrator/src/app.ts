import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AcpLogEntry,
  AcpLogPage,
  CreateSessionBody,
  ExecLogPage,
  ExecRequest,
  HealthResponse,
} from '../../shared/types.ts';
import type { config } from './config.ts';
import type { openDb } from './db.ts';
import { EgressManager } from './egress.ts';
import * as execs from './exec.ts';
import { log } from './log.ts';
import { HttpError, SessionManager } from './sessions.ts';

/**
 * The HTTP surface: the REST API, the exec endpoint and the static bundle.
 *
 * Separate from index.ts, which boots a process, so a test can drive these
 * routes over a real database without a Docker socket or an open port.
 */

/** Version reported by the health endpoint. */
const VERSION = '1.0.0';

const here = dirname(fileURLToPath(import.meta.url));

/** Dashboard bundle, copied into the image by the Dockerfile's build stage. */
const DASHBOARD_DIR = resolve(here, '../dashboard');

/** Everything one orchestrator process owns, wired together. */
export interface Orchestrator {
  app: ReturnType<typeof Fastify>;
  db: ReturnType<typeof openDb>;
  manager: SessionManager;
  cfg: ReturnType<typeof config>;
  /** Owns the egress policy and keeps the proxy holding it. */
  egress: EgressManager;
  /** Session ids whose network is missing the egress proxy. */
  setProxyWarnings(warnings: string[]): void;
}

/**
 * Builds the HTTP app and the objects behind it, without listening or
 * touching Docker.
 *
 * Boot lives in main(); this is separate so a test can drive the real routes
 * over a real database without a Docker socket or an open port.
 */
export function buildApp(
  cfg: ReturnType<typeof config>,
  db: ReturnType<typeof openDb>,
): Orchestrator {
const egress = new EgressManager(cfg);
const manager = new SessionManager(db, cfg, egress);

let proxyWarnings: string[] = [];

const app = Fastify({ logger: false });

// --- REST: unauthenticated here, the deployment puts auth in front ----------

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
  return {
    ok: true,
    version: VERSION,
    sessions: row.n,
    proxyWarnings,
    egress: egress.status(),
  };
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

/**
 * Runs a local command in the session container and streams its combined
 * output back as it arrives.
 *
 * The response is chunked text rather than JSON so the browser can render
 * the output growing; the last line is a trailer carrying the exit code and
 * whether either limit was hit. Both limits live in exec.ts: 120 seconds of
 * wall clock and 256 KiB of output, after which the exec is killed.
 *
 * The command runs inside the session's own isolation, as the non-root agent
 * user, and never reaches a command line on the host.
 */
app.post('/api/sessions/:id/exec', async (req, reply) => {
  const { id } = req.params as { id: string };
  const command = (req.body as ExecRequest | undefined)?.command?.trim();
  if (!command) throw new HttpError(400, 'command is required');
  if (command.length > 8000) throw new HttpError(400, 'command is too long');

  const target = await manager.execTarget(id);
  manager.touch(id);
  const startedAt = Date.now();

  reply.raw.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    // Nothing may buffer this: the point is that output appears as it is
    // produced.
    'X-Accel-Buffering': 'no',
  });

  const outcome = await execs.runCommand(target, command, (chunk) => {
    reply.raw.write(chunk);
  });
  reply.raw.end(execs.trailer(outcome));

  execs.record(db, id, command, outcome.output, outcome, startedAt);
  manager.touch(id);
  return reply;
});

/**
 * Every command already run in this session.
 *
 * The browser appends these after the adapter's replay: ACP replay carries no
 * timestamps, so where they belong in the transcript is not recoverable.
 */
app.get('/api/sessions/:id/exec', async (req): Promise<ExecLogPage> => {
  const { id } = req.params as { id: string };
  const row = manager.getRow(id);
  if (!row || row.status === 'deleted') throw new HttpError(404, 'Session not found');
  return { records: execs.history(db, id) };
});

// --- Static bundles with a single-page fallback -----------------------------

/** Content types served from the bundles, by file extension. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves one single-page bundle: a real file when the path names one, else the
 * bundle's index.html so client-side routes survive a reload.
 */
function sendBundle(
  reply: FastifyReply,
  dir: string,
  path: string,
  missing: string,
): FastifyReply {
  const candidate = resolve(dir, `.${normalize(path)}`);
  if (
    candidate.startsWith(dir) &&
    path !== '/' &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) {
    const ext = candidate.slice(candidate.lastIndexOf('.'));
    return reply
      .type(CONTENT_TYPES[ext] ?? 'application/octet-stream')
      .send(readFileSync(candidate));
  }
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return reply.code(404).send({ error: missing });
  return reply.type('text/html; charset=utf-8').send(readFileSync(index));
}

app.setNotFoundHandler((req, reply) => {
  if (req.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
  const url = req.url.split('?')[0] ?? '/';
  if (url.startsWith('/api') || url.startsWith('/ws')) {
    return reply.code(404).send({ error: 'Not found' });
  }
  return sendBundle(reply, DASHBOARD_DIR, url, 'Dashboard not built');
});

  return {
    app,
    db,
    manager,
    cfg,
    egress,
    setProxyWarnings: (warnings) => {
      proxyWarnings = warnings;
    },
  };
}
