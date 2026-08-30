import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ExecRecord, SessionDetail, SessionSummary } from '../../shared/types.ts';
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

/** A session the stub reports, with the detail fields filled in. */
export function stubSession(over: Partial<SessionDetail> = {}): SessionDetail {
  const id = over.id ?? 'a1b2c3d4';
  return {
    id,
    name: 'refactor auth',
    profile: 'DEFAULT',
    repoUrl: 'https://github.com/owner/repo',
    status: 'running',
    dockerState: 'running',
    turnActive: false,
    pendingCount: 0,
    attachedCount: 0,
    wsToken: 'stub-token-0123456789abcdef',
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
  const state: StubState = { sessions: initial };
  const execCalls: StubOrchestrator['execCalls'] = [];
  const execLog: ExecRecord[] = [];
  let execOutput: StubOrchestrator['execOutput'] = (command) => ({
    output: `${command}\n`,
    exitCode: 0,
  });

  const summary = (s: SessionDetail): SessionSummary => s;

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    if (url === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, state.sessions.map(summary));
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (detail && req.method === 'GET') {
      const found = state.sessions.find((s) => s.id === detail[1]);
      return found ? json(res, 200, found) : json(res, 404, { error: 'Not found' });
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
  const gateway = attachStubGateway(server, {
    token: initial[0]?.wsToken ?? 'stub-token',
    modes: null,
    prompts: [],
    permissions: [],
    queuedPermission: null,
    ...gatewayScript,
  });

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
