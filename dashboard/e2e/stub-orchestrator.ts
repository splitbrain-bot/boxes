import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  CreateThreadBody,
  ExecRecord,
  HealthResponse,
  ReviewAnnotation,
  ReviewAnnotationBody,
  ReviewFileResponse,
  ReviewStatusResponse,
  ReviewTreeResponse,
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
    wsVolume: '',
    workspaceDir: `/data/workspaces/${id}`,
    homeVolume: `home-${id}`,
    acpSessionId: 'acp-thread-1',
    proxyAttached: true,
    ...over,
  };
}

/**
 * A session's review, as the stub keeps it.
 *
 * Enough of a model to answer all seven endpoints consistently — a comment
 * written through the API comes back in the next tree and file fetch, and moves
 * the poll fingerprint — without duplicating the orchestrator's own store,
 * whose byte-level behaviour is proven against the desktop tool's fixtures in
 * the orchestrator's tests.
 */
export interface StubReview {
  /** Files, by path, with their content. The tree is built from these. */
  files: Record<string, string>;
  statuses: ReviewTreeResponse['statuses'];
  /** Diff markers per file path. Absent means no change. */
  diffs: Record<string, ReviewFileResponse['diff']>;
  /** Comments per file path, by line. */
  annotations: Record<string, Record<number, ReviewAnnotation>>;
  root: string;
  hasGit: boolean;
  base: ReviewTreeResponse['base'];
  /** True once a comment has been written, as REVIEW.md existing. */
  hasReview: boolean;
  started: string;
  headCommit: string;
  truncated: boolean;
  /** A status to answer every review request with instead, for the error path. */
  fail: { status: number; error: string } | null;
}

/** A review with a small project in it, which is what the tests browse. */
export function stubReview(over: Partial<StubReview> = {}): StubReview {
  return {
    files: {
      'src/app.ts': 'import { boot } from "./boot";\n\nboot();\n',
      'src/boot.ts':
        'export function boot(): void {\n  // TODO: wire the router\n  console.log("up");\n}\n',
      'README.md': '# demo\n\nA project the agent cloned.\n',
      'notes.txt': 'plain text, no grammar\n',
    },
    statuses: { 'src/boot.ts': 'modified', 'notes.txt': 'untracked' },
    diffs: {
      'src/boot.ts': {
        lines: { 2: 'added', 3: 'modified' },
        hunks: [
          {
            startLine: 1,
            endLine: 4,
            diff: ' export function boot(): void {\n+  // TODO: wire the router\n-  console.log("boot");\n+  console.log("up");\n }\n',
          },
        ],
        deletions: [{ afterLine: 1, hunkIndex: 0 }],
      },
    },
    annotations: {},
    root: 'project',
    hasGit: true,
    base: { rev: '', commit: '' },
    hasReview: false,
    started: '2026-08-31',
    headCommit: 'a'.repeat(40),
    truncated: false,
    fail: null,
    ...over,
  };
}

/** What the stub answers with, mutable between navigations. */
export interface StubState {
  sessions: SessionDetail[];
  /** What the health probe reports about the deployment's Claude token. */
  claudeTokenConfigured: boolean;
  /** Review data per session id. A session without one has no review at all. */
  reviews: Record<string, StubReview>;
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
  /** Every review mutation the browser made, in order. */
  reviewCalls: Array<{ method: string; sessionId: string; body: unknown }>;
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
  const state: StubState = {
    sessions: initial,
    claudeTokenConfigured: true,
    reviews: Object.fromEntries(initial.map((s) => [s.id, stubReview()])),
  };
  const reviewCalls: StubOrchestrator['reviewCalls'] = [];
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

    const review = /^\/api\/sessions\/([^/]+)\/review(?:\/(tree|file|status|annotations|base))?$/.exec(
      url,
    );
    if (review) {
      return answerReview(req, res, state, reviewCalls, review[1]!, review[2] ?? '');
    }

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
    reviewCalls,
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

// --- the review endpoints ---------------------------------------------------

/**
 * Answers the seven review routes from the stub's in-memory review.
 *
 * The point of keeping real state rather than canned bodies: a comment written
 * through the API has to come back in the next tree and file fetch and move the
 * poll fingerprint, because that loop is what the browser tests are about.
 */
function answerReview(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  state: StubState,
  calls: Array<{ method: string; sessionId: string; body: unknown }>,
  sessionId: string,
  endpoint: string,
): void {
  const review = state.reviews[sessionId];
  if (!review) return json(res, 404, { error: 'Session not found' });
  if (review.fail) return json(res, review.fail.status, { error: review.fail.error });

  const query = new URL(req.url ?? '/', 'http://stub').searchParams;

  /** One file's comments, in line order, as the API reports them. */
  const annotationsOf = (path: string): ReviewAnnotation[] =>
    Object.values(review.annotations[path] ?? {}).sort((a, b) => a.line - b.line);

  /** Reads a JSON body and hands it over. */
  const withBody = (fn: (body: unknown) => void): void => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => fn(JSON.parse(raw || '{}')));
  };

  if (endpoint === 'tree' && req.method === 'GET') {
    const body: ReviewTreeResponse = {
      root: review.root,
      hasGit: review.hasGit,
      entries: buildStubTree(Object.keys(review.files)),
      truncated: review.truncated,
      statuses: review.statuses,
      counts: Object.fromEntries(
        Object.entries(review.annotations)
          .map(([path, lines]) => [path, Object.keys(lines).length] as const)
          .filter(([, count]) => count > 0),
      ),
      base: review.base,
      hasReview: review.hasReview,
      started: review.hasReview ? review.started : '',
    };
    return json(res, 200, body);
  }

  if (endpoint === 'file' && req.method === 'GET') {
    const path = query.get('path') ?? '';
    const content = review.files[path];
    if (content === undefined) return json(res, 404, { error: 'File not found' });
    const body: ReviewFileResponse = {
      path,
      content,
      truncated: false,
      binary: false,
      size: content.length,
      lines: content.split('\n').filter((_, i, all) => i < all.length - 1 || all[i] !== '').length,
      language: languageOf(path),
      status: review.statuses[path] ?? null,
      diff: review.diffs[path] ?? { lines: {}, hunks: [], deletions: [] },
      annotations: annotationsOf(path),
    };
    return json(res, 200, body);
  }

  if (endpoint === 'status' && req.method === 'GET') {
    const body: ReviewStatusResponse = {
      // Derived from the state so a mutation moves it, the way three real
      // hashes would.
      reviewHash: review.hasReview ? JSON.stringify(review.annotations).length.toString(16) : '',
      headCommit: review.hasGit ? review.headCommit : '',
      statusHash: review.hasGit ? JSON.stringify(review.statuses).length.toString(16) : '',
    };
    return json(res, 200, body);
  }

  if (endpoint === 'annotations' && req.method === 'PUT') {
    return withBody((body) => {
      calls.push({ method: 'PUT', sessionId, body });
      const { path, line, comment } = body as ReviewAnnotationBody;
      if (!review.files[path]) return json(res, 404, { error: 'File not found' });
      review.annotations[path] = {
        ...review.annotations[path],
        [line]: { line, comment: comment.trim(), outdated: false },
      };
      review.hasReview = true;
      return json(res, 200, { path, annotations: annotationsOf(path) });
    });
  }

  if (endpoint === 'annotations' && req.method === 'DELETE') {
    const path = query.get('path') ?? '';
    const line = Number(query.get('line'));
    calls.push({ method: 'DELETE', sessionId, body: { path, line } });
    const lines = { ...review.annotations[path] };
    delete lines[line];
    if (Object.keys(lines).length > 0) review.annotations[path] = lines;
    else delete review.annotations[path];
    return json(res, 200, { path, annotations: annotationsOf(path) });
  }

  if (endpoint === 'base' && req.method === 'PUT') {
    return withBody((body) => {
      calls.push({ method: 'PUT base', sessionId, body });
      const { rev } = body as { rev: string | null };
      if (rev === null || rev.trim() === '') review.base = { rev: '', commit: '' };
      else if (rev === 'nope') return json(res, 400, { error: `unknown revision: ${rev}` });
      else review.base = { rev: rev.trim(), commit: 'b'.repeat(40) };
      return json(res, 200, review.base);
    });
  }

  if (endpoint === '' && req.method === 'DELETE') {
    calls.push({ method: 'DELETE review', sessionId, body: null });
    review.annotations = {};
    review.hasReview = false;
    res.writeHead(204);
    res.end();
    return;
  }

  return json(res, 404, { error: 'Not found' });
}

/** The same shape the orchestrator's tree builder produces, from a path list. */
function buildStubTree(paths: string[]): ReviewTreeResponse['entries'] {
  type Node = { entry: ReviewTreeResponse['entries'][number]; children: Map<string, Node> };
  const root: Node = { entry: { name: '', path: '', isDir: true }, children: new Map() };

  for (const path of paths.toSorted()) {
    const parts = path.split('/');
    let current = root;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      let next = current.children.get(part);
      if (!next) {
        next = {
          entry: {
            name: part,
            path: isLeaf ? path : parts.slice(0, i + 1).join('/'),
            isDir: !isLeaf,
          },
          children: new Map(),
        };
        current.children.set(part, next);
      }
      current = next;
    });
  }

  const collect = (node: Node): ReviewTreeResponse['entries'] =>
    [...node.children.values()]
      .map((child) => {
        if (!child.entry.isDir) return child.entry;
        return { ...child.entry, children: collect(child) };
      })
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));

  return collect(root);
}

/** The language the real API would report, for the handful the stub serves. */
function languageOf(path: string): string {
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.md')) return 'markdown';
  return '';
}
