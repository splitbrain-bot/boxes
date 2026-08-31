import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  CreateThreadBody,
  ExecRecord,
  HealthResponse,
  SessionDetail,
  SessionSummary,
  ThreadSummary,
} from '../../shared/types.ts';
import { attachStubGateway, type GatewayScript, type StubGateway } from './stub-gateway.ts';

/**
 * A stand-in orchestrator for the browser tests: it serves the built
 * dashboard exactly as the real one does — real file or index.html fallback,
 * 404 under /api and /ws — and answers the REST calls from canned data.
 *
 * Serving the real bundle is the point. A test that ran against the dev
 * server would not prove the shipped output works.
 */

/** Content types served from the bundle, by file extension. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/** A thread the stub reports, matching the stub gateway's own first thread. */
export function stubThread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'th1',
    acpSessionId: 'acp-thread-1',
    title: null,
    ordinal: 1,
    turnActive: false,
    pendingCount: 0,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    lastActiveAt: Date.parse('2026-08-30T09:30:00Z'),
    ...over,
  };
}

/** A session the stub reports, with the detail fields filled in. */
export function stubSession(over: Partial<SessionDetail> = {}): SessionDetail {
  const id = over.id ?? 'a1b2c3d4';
  return {
    id,
    name: 'refactor auth',
    profile: 'DEFAULT',
    status: 'running',
    dockerState: 'running',
    turnActive: false,
    pendingCount: 0,
    attachedCount: 0,
    wsToken: 'stub-token-0123456789abcdef',
    threads: [stubThread()],
    currentThreadId: 'th1',
    canFork: true,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    lastActiveAt: Date.parse('2026-08-30T09:30:00Z'),
    image: 'boxes-session:latest',
    containerId: 'c0ffee1234567890',
    networkName: `sn-${id}`,
    subnet: '10.200.0.0/24',
    wsVolume: `ws-${id}`,
    homeVolume: `home-${id}`,
    acpSessionId: 'acp-thread-1',
    proxyAttached: true,
    ...over,
  };
}

/** What the stub answers with, mutable between navigations. */
export interface StubState {
  sessions: SessionDetail[];
  /** What the health probe reports about the deployment's Claude token. */
  claudeTokenConfigured: boolean;
}

/** A running stub, with the base URL to point a browser at. */
export interface StubOrchestrator {
  url: string;
  state: StubState;
  /** The ACP gateway attached to the same server, on the same origin. */
  gateway: StubGateway;
  /** Bodies posted to the exec endpoint, in order. */
  execCalls: Array<{ sessionId: string; command: string }>;
  /** Combined output the exec endpoint streams back, by command. */
  execOutput: (command: string) => { output: string; exitCode: number };
  /** What GET /exec reports, as if from a previous session. */
  execLog: ExecRecord[];
  server: Server;
  close(): Promise<void>;
}

/** Starts the stub on an ephemeral port, serving distDir as the dashboard. */
export async function startStubOrchestrator(
  distDir: string,
  initial: SessionDetail[] = [stubSession()],
  gatewayScript?: Partial<GatewayScript>,
): Promise<StubOrchestrator> {
  const dir = resolve(distDir);
  const state: StubState = { sessions: initial, claudeTokenConfigured: true };
  const execCalls: StubOrchestrator['execCalls'] = [];
  const execLog: ExecRecord[] = [];
  let execOutput: StubOrchestrator['execOutput'] = (command) => ({
    output: `${command}\n`,
    exitCode: 0,
  });

  const summary = (s: SessionDetail): SessionSummary => s;

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    if (url === '/healthz' && req.method === 'GET') {
      const health: HealthResponse = {
        ok: true,
        version: 'stub',
        sessions: state.sessions.length,
        proxyWarnings: [],
        egress: null,
        claudeTokenConfigured: state.claudeTokenConfigured,
      };
      return json(res, 200, health);
    }
    if (url === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, state.sessions.map(summary));
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (detail && req.method === 'GET') {
      const found = state.sessions.find((s) => s.id === detail[1]);
      return found ? json(res, 200, found) : json(res, 404, { error: 'Not found' });
    }
    const threads = /^\/api\/sessions\/([^/]+)\/threads$/.exec(url);
    if (threads) {
      const found = state.sessions.find((s) => s.id === threads[1]);
      if (!found) return json(res, 404, { error: 'Not found' });
      if (req.method === 'GET') return json(res, 200, found.threads);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString('utf8')));
        req.on('end', () => {
          const from = (JSON.parse(body || '{}') as CreateThreadBody).from;
          // The orchestrator mints upstream and records what came back, so
          // the stub does the same rather than inventing an id of its own.
          const source = from ? found.threads.find((t) => t.id === from) : undefined;
          if (from && !source) return json(res, 404, { error: 'Thread not found' });
          const acpSessionId = source?.acpSessionId
            ? gateway.forkThread(source.acpSessionId)
            : gateway.newThread();
          const created = stubThread({
            id: `th${found.threads.length + 1}`,
            acpSessionId,
            ordinal: found.threads.length + 1,
          });
          found.threads = [...found.threads, created];
          found.currentThreadId = created.id;
          found.acpSessionId = acpSessionId;
          return json(res, 201, created);
        });
        return undefined;
      }
    }
    const select = /^\/api\/sessions\/([^/]+)\/threads\/([^/]+)\/select$/.exec(url);
    if (select && req.method === 'POST') {
      const found = state.sessions.find((s) => s.id === select[1]);
      const thread = found?.threads.find((t) => t.id === select[2]);
      if (!found || !thread) return json(res, 404, { error: 'Not found' });
      found.currentThreadId = thread.id;
      found.acpSessionId = thread.acpSessionId;
      if (thread.acpSessionId) gateway.select(thread.acpSessionId);
      return json(res, 200, thread);
    }
    const exec = /^\/api\/sessions\/([^/]+)\/exec$/.exec(url);
    if (exec && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const command = (JSON.parse(body || '{}') as { command?: string }).command ?? '';
        execCalls.push({ sessionId: exec[1]!, command });
        const { output, exitCode } = execOutput(command);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.write(output);
        res.end(`\n[exit ${exitCode}]\n`);
      });
      return undefined;
    }
    if (exec && req.method === 'GET') return json(res, 200, { records: execLog });

    if (url.startsWith('/api') || url.startsWith('/ws')) {
      return json(res, 404, { error: 'Not found' });
    }
    return sendBundle(res, dir, url);
  });

  // Same origin as the dashboard, which is how the deployment serves it and
  // why the browser can derive the WebSocket URL from its own location.
  const gateway = attachStubGateway(
    server,
    {
      token: initial[0]?.wsToken ?? 'stub-token',
      modes: null,
      configOptions: [],
      prompts: [],
      permissions: [],
      queuedPermission: null,
      ...gatewayScript,
    },
    // The mapping the real gateway does out of the threads table: the path
    // carries a Boxes thread id, the adapter knows its own.
    (sessionId, threadId) => {
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return null;
      const wanted = threadId ?? session.currentThreadId;
      return session.threads.find((t) => t.id === wanted)?.acpSessionId ?? null;
    },
  );

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    gateway,
    execCalls,
    execLog,
    get execOutput() {
      return execOutput;
    },
    set execOutput(fn: StubOrchestrator['execOutput']) {
      execOutput = fn;
    },
    server,
    close: () =>
      new Promise<void>((ok) => {
        gateway.close();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** A real file when the path names one, else index.html, as the orchestrator does. */
function sendBundle(res: import('node:http').ServerResponse, dir: string, path: string): void {
  const candidate = resolve(dir, `.${normalize(path)}`);
  if (candidate.startsWith(dir) && path !== '/' && existsSync(candidate) && statSync(candidate).isFile()) {
    const ext = candidate.slice(candidate.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(candidate));
    return;
  }
  const index = join(dir, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Dashboard not built' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(index));
}
