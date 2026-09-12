import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  AgentItem,
  AgentSetDetail,
  CreateSessionBody,
  CreateThreadBody,
  CredentialId,
  CredentialMethod,
  CredentialSummary,
  DeploymentImages,
  ExecRecord,
  HarnessHealth,
  HarnessInfo,
  HealthResponse,
  LoginState,
  ReviewAnnotation,
  ReviewAnnotationBody,
  ReviewFileResponse,
  ReviewRepo,
  ReviewTreeResponse,
  SessionDetail,
  SessionSummary,
  Settings,
  StartLoginResponse,
  StoredAttachment,
  ThreadDoneBody,
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
  // The install: the manifest and the icons it names, with the types the
  // orchestrator gives them (app.ts, CONTENT_TYPES).
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** A thread the stub reports, matching the stub gateway's own first thread. */
export function stubThread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'th1',
    // Which agent runs it, and what it is configured with beyond its mode.
    // Both are the thread's rather than the box's: one checkout may carry a
    // conversation of each harness.
    harness: 'claude',
    modeId: null,
    config: { model: 'opus' },
    // Whether this thread's own adapter advertised the fork capability.
    canFork: true,
    acpSessionId: 'acp-thread-1',
    title: null,
    ordinal: 1,
    turnActive: false,
    speaking: false,
    backgroundBusy: false,
    pendingCount: 0,
    done: false,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    // Relative to now, unlike everything else here: the row shows how long ago
    // this was as a rough age, so a fixed date would make the list's screenshot
    // read "40d" one month and "70d" the next. A test that cares which unit it
    // lands in says so itself.
    lastActiveAt: Date.now() - 3 * 60_000,
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
    speaking: false,
    backgroundBusy: false,
    pendingCount: 0,
    attachedCount: 0,
    wsToken: 'stub-token-0123456789abcdef',
    threads: [stubThread()],
    currentThreadId: 'th1',
    agentSetId: null,
    agentSetName: null,
    diskBytes: 348 * 1024 * 1024,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    lastActiveAt: Date.parse('2026-08-30T09:30:00Z'),
    image: 'boxes-session:latest',
    containerId: 'c0ffee1234567890',
    networkName: `sn-${id}`,
    subnet: '10.200.0.0/24',
    wsVolume: '',
    workspaceDir: `/data/workspaces/${id}`,
    homeVolume: '',
    homeDir: `/data/homes/${id}`,
    acpSessionId: 'acp-thread-1',
    proxyAttached: true,
    ...over,
  };
}

/**
 * A session's review, as the stub keeps it.
 *
 * Enough of a model to answer all six endpoints consistently — a comment
 * written through the API comes back in the next tree and file fetch — without
 * duplicating the orchestrator's own store, whose byte-level behaviour is
 * proven against the desktop tool's fixtures in the orchestrator's tests.
 *
 * The review is over the *workspace*, so `files` is keyed by
 * workspace-relative path and `repos` says which repository each path belongs
 * to. The default fixture holds two of them side by side plus a loose
 * directory no repository claims, because that is the shape the single-root
 * design could not show at all.
 */
export interface StubReview {
  /** Files, by workspace-relative path, with their content. */
  files: Record<string, string>;
  statuses: ReviewTreeResponse['statuses'];
  /** Diff markers per file path. Absent means no change. */
  diffs: Record<string, ReviewFileResponse['diff']>;
  /** Comments per file path, by line. */
  annotations: Record<string, Record<number, ReviewAnnotation>>;
  /** The repositories the workspace holds, sorted by path. */
  repos: ReviewRepo[];
  base: ReviewTreeResponse['base'];
  /** True once a comment has been written, as REVIEW.md existing. */
  hasReview: boolean;
  started: string;
  truncated: boolean;
  /** A status to answer every review request with instead, for the error path. */
  fail: { status: number; error: string } | null;
}

/**
 * A review with two small projects in it and a loose note beside them, which
 * is what the tests browse.
 */
export function stubReview(over: Partial<StubReview> = {}): StubReview {
  return {
    files: {
      'app/src/app.ts': 'import { boot } from "./boot";\n\nboot();\n',
      'app/src/boot.ts':
        'export function boot(): void {\n  // TODO: wire the router\n  console.log("up");\n}\n',
      'app/README.md': '# demo\n\nA project the agent cloned.\n',
      'lib/index.ts': 'export const version = "1.0.0";\n',
      // Outside every repository: no .gitignore has said what is noise here,
      // so it shows, and it has no status and no diff.
      'notes/todo.txt': 'plain text, no grammar\n',
    },
    statuses: { 'app/src/boot.ts': 'modified', 'lib/index.ts': 'untracked' },
    diffs: {
      'app/src/boot.ts': {
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
    repos: [
      { path: 'app', name: 'app', head: 'a'.repeat(40), baseCommit: '' },
      { path: 'lib', name: 'lib', head: 'b'.repeat(40), baseCommit: '' },
    ],
    base: { rev: '' },
    hasReview: false,
    started: '2026-08-31',
    truncated: false,
    fail: null,
    ...over,
  };
}

/**
 * An agent set the stub reports. Defaults to the global one, which every
 * deployment has from its first boot.
 */
export function stubAgentSet(over: Partial<AgentSetDetail> = {}): AgentSetDetail {
  const items = over.items ?? [];
  return {
    id: 'global',
    name: 'Global',
    global: true,
    agentsMd: '',
    items,
    hasAgentsMd: (over.agentsMd ?? '').trim() !== '',
    skillCount: items.filter((i) => i.kind === 'skill').length,
    commandCount: items.filter((i) => i.kind === 'command').length,
    sessionCount: 0,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    updatedAt: Date.parse('2026-08-01T10:00:00Z'),
    ...over,
  };
}

/** A credential the stub holds, shown the way the real API shows one. */
export function stubCredential(over: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id: 'claude',
    method: 'token',
    account: '1234',
    status: 'ok',
    lastError: null,
    expiresAt: null,
    refreshedAt: null,
    updatedAt: Date.parse('2026-09-01T10:00:00Z'),
    ...over,
  };
}

/**
 * How a login goes when the page starts one.
 *
 * The real flow is a CLI in a throwaway container, and what the page can see
 * of it is a state per poll. So that is what the stub is: a list of states,
 * one served per poll, the last repeating until the test pushes another with
 * `pushLoginState` — which is what keeps the interesting ones on screen long
 * enough to be asserted about rather than gone by the next tick.
 */
export interface StubLoginScript {
  /** Served in order, one per poll; the last one repeats. */
  steps: LoginState[];
  /**
   * Served instead, from the start, once a code has been posted. Claude's
   * flow is the one that has one: its CLI blocks until the code arrives.
   */
  afterCode?: LoginState[];
}

/** The two flows as the adapters run them, which is what the tests drive. */
export function stubLoginScripts(): Record<string, StubLoginScript> {
  return {
    // Claude: a URL, then a prompt the page has to answer.
    claude: {
      steps: [{ state: 'starting' }, { state: 'awaiting_code', url: 'https://claude.ai/oauth/code' }],
      afterCode: [{ state: 'done' }],
    },
    // Codex: a URL and a one-time code, and the CLI polls for itself.
    openai: {
      steps: [
        { state: 'starting' },
        {
          state: 'awaiting_browser',
          url: 'https://auth.openai.com/codex/device',
          code: 'WDJB-MJHT',
        },
      ],
    },
  };
}

/**
 * A harness the health probe reports. Runnable by default and carrying the
 * credential that makes it so, which is the state a working deployment is in.
 */
export function stubHarness(over: Partial<HarnessHealth> = {}): HarnessHealth {
  return {
    id: 'claude',
    label: 'Claude Code',
    credential: stubCredential(),
    runnable: true,
    ...over,
  };
}

/**
 * One harness as the dialogs see it: the registry's answer, what an adapter
 * last advertised, and whether it can run. The catalogue is what a deployment
 * that has run Claude once has cached.
 *
 * The modes and options are shaped like the adapter's own answers — a name
 * saying what each mode does, a model list, an effort level — because that is
 * what the dialogs render, and a catalogue of bare ids would prove nothing
 * about a picker whose whole job is to say what a mode means.
 */
export function stubHarnessInfo(over: Partial<HarnessInfo> = {}): HarnessInfo {
  return {
    ...stubHarness(),
    defaultModeId: 'auto',
    forkModeId: 'plan',
    defaultConfig: { model: 'opus' },
    catalog: {
      modes: {
        currentModeId: 'auto',
        availableModes: [
          { id: 'auto', name: 'Auto', description: 'Decides for itself when to ask.' },
          { id: 'plan', name: 'Plan', description: 'Reads and plans; changes nothing.' },
        ],
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'opus',
          options: [
            { value: 'opus', name: 'Opus' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
        {
          id: 'effort',
          name: 'Thinking',
          category: 'thought_level',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
      seenAt: Date.parse('2026-09-01T10:00:00Z'),
    },
    ...over,
  };
}

/**
 * The second harness, for the tests that are about there being two.
 *
 * Its modes are the ones Appendix A of the plan records, names and all: two of
 * them run every command under a sandbox a hardened container is likely to
 * refuse, which is why the picker has something to say about them that no
 * adapter can say about itself.
 */
export function stubCodexHarness(over: Partial<HarnessHealth> = {}): HarnessHealth {
  return {
    id: 'codex',
    label: 'Codex',
    credential: stubCredential({ id: 'openai', method: 'api_key', account: 'abcd' }),
    runnable: true,
    ...over,
  };
}

/** The same harness as the dialogs see it, catalogue and all. */
export function stubCodexHarnessInfo(over: Partial<HarnessInfo> = {}): HarnessInfo {
  return {
    ...stubCodexHarness(),
    defaultModeId: 'agent-full-access',
    forkModeId: 'read-only',
    defaultConfig: {},
    catalog: {
      modes: {
        currentModeId: 'agent-full-access',
        availableModes: [
          {
            id: 'read-only',
            name: 'Ask for approval',
            description: 'Every command waits for a human.',
          },
          { id: 'agent', name: 'Approve for me', description: 'Codex approves its own work.' },
          {
            id: 'agent-full-access',
            name: 'Full access',
            description: 'No sandbox: the container is the boundary.',
          },
        ],
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'gpt-5.6-codex',
          options: [
            { value: 'gpt-5.6-codex', name: 'GPT-5.6 Codex' },
            { value: 'gpt-5.6', name: 'GPT-5.6' },
          ],
        },
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
      seenAt: Date.parse('2026-09-01T10:00:00Z'),
    },
    ...over,
  };
}

/**
 * The three images the stub says are running: two pulled from a registry and
 * one built on the host, which is the mix a deployment following `latest`
 * with a session image of its own actually has.
 */
export function stubImages(): DeploymentImages {
  return {
    orchestrator: {
      digest: 'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
      builtAt: Date.parse('2026-08-30T09:15:00Z'),
      sizeBytes: 440_401_920,
    },
    proxy: {
      digest: 'sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
      builtAt: Date.parse('2026-08-30T09:15:00Z'),
      sizeBytes: 188_743_680,
    },
    session: {
      digest: 'sha256:0011223344556677889900aabbccddeeff00112233445566778899aabbccddee',
      builtAt: Date.parse('2026-08-12T22:40:00Z'),
      // Gigabytes, because the session image is: a language toolchain apiece
      // and a browser. Which is the reason the footer says so at all.
      sizeBytes: 4_509_715_661,
    },
  };
}

/** What the stub answers with, mutable between navigations. */
export interface StubState {
  sessions: SessionDetail[];
  /**
   * The agent sets, global first, exactly as the orchestrator would answer.
   * Held whole rather than summarized so the stub can serve the list, the
   * detail and the merge from one place.
   */
  agentSets: AgentSetDetail[];
  /**
   * What the health probe reports about each harness. The dashboard warns
   * about every one that cannot run, so a test makes a harness unrunnable by
   * taking its credential away here.
   */
  harnesses: HarnessHealth[];
  /**
   * What GET /api/harnesses answers: the same harnesses with the registry's
   * defaults and whatever an adapter last advertised, which is what the
   * dialogs are built from.
   */
  harnessInfo: HarnessInfo[];
  /**
   * The credentials the deployment holds, as the settings page sees them:
   * an account and a status, never a secret. Written by PUT and read by GET,
   * so a pasted token round-trips the way the real one does.
   */
  credentials: CredentialSummary[];
  /** The deployment's plain settings, which the settings page round-trips. */
  settings: Settings;
  /**
   * How a login for each credential goes, by credential id. A test that wants
   * a different flow — a failure, a longer wait — replaces the script before
   * the page starts one.
   */
  loginScripts: Record<string, StubLoginScript>;
  /** Which build of each image the health probe says is running. */
  images: DeploymentImages;
  /**
   * The cookie an authenticating reverse proxy in front of this deployment
   * would be checking, or null for the loopback default that has none.
   *
   * Boxes has no auth of its own, so anything past a single-user machine is
   * behind one (README, "Behind a reverse proxy"). Named here because that
   * changes what the browser sees: a request the proxy does not recognize is
   * bounced to a login page rather than answered, and not every request the
   * page makes carries credentials.
   */
  requireCookie: string | null;
  /** Review data per session id. A session without one has no review at all. */
  reviews: Record<string, StubReview>;
}

/** A running stub, with the base URL to point a browser at. */
export interface StubOrchestrator {
  url: string;
  state: StubState;
  /** The ACP gateway attached to the same server, on the same origin. */
  gateway: StubGateway;
  /** Files uploaded to the attachments endpoint, in order. */
  attachmentUploads: Array<{ sessionId: string; name: string; bytes: Buffer }>;
  /**
   * Bodies posted to the exec endpoint, in order.
   *
   * `threadId` is null where the browser used the path that names no thread,
   * which means whichever one the session has current.
   */
  execCalls: Array<{ sessionId: string; threadId: string | null; command: string }>;
  /**
   * Every stop of background work the browser asked for, in order.
   *
   * `processId` is absent where the reader asked for all of a thread's work
   * rather than one command of it.
   */
  backgroundStops: Array<{ sessionId: string; threadId: string; processId?: string }>;
  /**
   * Every box-wide kill the browser asked for, in order, by session.
   *
   * The one the card offers when the box is busy and no conversation in it
   * claims the work. It names no thread and no process, which is the whole
   * difference: the orchestrator reads the box and signals what it finds.
   */
  boxStops: string[];
  /** Combined output the exec endpoint streams back, by command. */
  execOutput: (command: string) => { output: string; exitCode: number };
  /** What GET /exec reports, as if from a previous session. */
  execLog: ExecRecord[];
  /** Every review mutation the browser made, in order. */
  reviewCalls: Array<{ method: string; sessionId: string; body: unknown }>;
  /**
   * Every create-a-box request, as the browser sent it.
   *
   * Held whole because the body is the assertion: the dialog's answer — which
   * agent, which mode, which model — travels in it, and a box created with
   * the wrong one is a box somebody has to delete.
   */
  sessionCalls: CreateSessionBody[];
  /** Every add-a-thread request, with the session it was made against. */
  threadCalls: Array<{ sessionId: string; body: CreateThreadBody }>;
  /**
   * Every login the page started, in order, with what happened to it: the
   * codes pasted back into it, and whether it was cancelled.
   */
  logins: Array<{ id: CredentialId; loginId: string; codes: string[]; cancelled: boolean }>;
  /**
   * Moves the login running for one credential on to `next`, which every poll
   * from then on answers with.
   *
   * What makes a flow assertable: the stub sits on the last state it was
   * given, so a test can read the URL and the code off the page and then say
   * when the CLI finished. Applies to the script instead when no login is
   * running yet.
   */
  pushLoginState: (id: CredentialId, next: LoginState) => void;
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
    harnesses: [stubHarness()],
    harnessInfo: [stubHarnessInfo()],
    credentials: [stubCredential()],
    settings: {
      gitName: 'boxes-bot',
      gitEmail: 'boxes-bot@users.noreply.github.com',
      dialogs: {},
    },
    loginScripts: stubLoginScripts(),
    images: stubImages(),
    reviews: Object.fromEntries(initial.map((s) => [s.id, stubReview()])),
    agentSets: [stubAgentSet()],
    requireCookie: null,
  };
  const reviewCalls: StubOrchestrator['reviewCalls'] = [];
  const sessionCalls: StubOrchestrator['sessionCalls'] = [];
  const threadCalls: StubOrchestrator['threadCalls'] = [];
  const logins: StubOrchestrator['logins'] = [];
  /** The logins the stub is still answering for, by the id it handed out. */
  const running = new Map<string, RunningLogin>();
  const attachmentUploads: StubOrchestrator['attachmentUploads'] = [];
  const execCalls: StubOrchestrator['execCalls'] = [];
  const backgroundStops: StubOrchestrator['backgroundStops'] = [];
  const boxStops: StubOrchestrator['boxStops'] = [];
  const execLog: ExecRecord[] = [];
  let execOutput: StubOrchestrator['execOutput'] = (command) => ({
    output: `${command}\n`,
    exitCode: 0,
  });

  const summary = (s: SessionDetail): SessionSummary => s;

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    // The proxy, when the test asked for one: anything without the cookie is
    // redirected to a login page that answers 200, which is what
    // oauth2-proxy, Authelia and a Caddy forward_auth all do.
    if (state.requireCookie && !(req.headers.cookie ?? '').includes(`${state.requireCookie}=`)) {
      if (url === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sign in</title>');
        return;
      }
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    if (url === '/healthz' && req.method === 'GET') {
      const health: HealthResponse = {
        ok: true,
        version: 'stub',
        sessions: state.sessions.length,
        proxyWarnings: [],
        egress: null,
        harnesses: state.harnesses,
        credentials: state.credentials,
        pushSubscriptions: 0,
        images: state.images,
      };
      return json(res, 200, health);
    }
    if (url === '/api/harnesses' && req.method === 'GET') {
      // Kept in step with the health probe, the way the orchestrator's own two
      // answers are: both are built from the same registry and store.
      return json(
        res,
        200,
        state.harnessInfo.map((info) => ({
          ...info,
          ...(state.harnesses.find((h) => h.id === info.id) ?? {}),
        })),
      );
    }
    if (url === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, state.sessions.map(summary));
    }
    // Creating a box creates its first conversation in the same request, on
    // whatever the form's agent block chose, so the stub does both here.
    if (url === '/api/sessions' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as CreateSessionBody;
        sessionCalls.push(parsed);
        const id = `new${state.sessions.length}`;
        const created = stubSession({
          id,
          name: parsed.name,
          agentSetId: parsed.agentSet ?? null,
          networkName: `sn-${id}`,
          workspaceDir: `/data/workspaces/${id}`,
          homeDir: `/data/homes/${id}`,
          threads: [
            stubThread({
              acpSessionId: gateway.newThread(),
              harness: parsed.thread?.harness ?? 'claude',
              modeId: parsed.thread?.modeId ?? null,
              config: parsed.thread?.config ?? {},
            }),
          ],
        });
        state.sessions = [...state.sessions, created];
        state.reviews[id] = stubReview();
        json(res, 201, created);
      });
      return undefined;
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (detail && req.method === 'GET') {
      const found = state.sessions.find((s) => s.id === detail[1]);
      return found ? json(res, 200, found) : json(res, 404, { error: 'Not found' });
    }
    // Removed from the list for real, so what the browser does next — the
    // list it lands on, and the entry it must not be able to go back to — is
    // answered by a deployment that no longer has the session.
    if (detail && req.method === 'DELETE') {
      const at = state.sessions.findIndex((s) => s.id === detail[1]);
      if (at === -1) return json(res, 404, { error: 'Not found' });
      state.sessions.splice(at, 1);
      res.writeHead(204);
      res.end();
      return undefined;
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
          const parsed = JSON.parse(body || '{}') as CreateThreadBody;
          threadCalls.push({ sessionId: found.id, body: parsed });
          const from = parsed.from;
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
            // A fork stays on its source's harness and keeps its settings;
            // anything else runs what the request asked for.
            harness: source?.harness ?? parsed.options?.harness ?? 'claude',
            ...(source
              ? { config: source.config, canFork: source.canFork }
              : parsed.options?.config
                ? { config: parsed.options.config }
                : {}),
            ...(parsed.options?.modeId && !source ? { modeId: parsed.options.modeId } : {}),
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
    const markDone = /^\/api\/sessions\/([^/]+)\/threads\/([^/]+)\/done$/.exec(url);
    if (markDone && req.method === 'POST') {
      const found = state.sessions.find((s) => s.id === markDone[1]);
      const thread = found?.threads.find((t) => t.id === markDone[2]);
      if (!found || !thread) return json(res, 404, { error: 'Not found' });
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const { done } = JSON.parse(body || '{}') as ThreadDoneBody;
        // Stored on the stub's own session, so the next list read draws the
        // row struck through exactly as the orchestrator's would.
        const marked = { ...thread, done };
        found.threads = found.threads.map((t) => (t.id === marked.id ? marked : t));
        json(res, 200, marked);
      });
      return undefined;
    }
    const stopBackground = /^\/api\/sessions\/([^/]+)\/threads\/([^/]+)\/background\/stop$/.exec(
      url,
    );
    if (stopBackground && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const asked = (JSON.parse(body || '{}') as { processId?: string }).processId;
        backgroundStops.push({
          sessionId: stopBackground[1] ?? '',
          threadId: stopBackground[2] ?? '',
          ...(asked === undefined ? {} : { processId: asked }),
        });
        // The real one kills processes and says how many it signalled. What
        // the browser does with the answer is nothing: the bar is redrawn
        // from the gateway's next reading, which is the stub's `finishTasks`.
        json(res, 200, { stopped: 1 });
      });
      return undefined;
    }
    const stopBox = /^\/api\/sessions\/([^/]+)\/background\/stop$/.exec(url);
    if (stopBox && req.method === 'POST') {
      const sessionId = stopBox[1] ?? '';
      boxStops.push(sessionId);
      // The real one TERMs what its reading of the box calls work and answers
      // with how many pids it signalled; a reading a moment later is what
      // takes the box out of its busy state, so the stub does that here.
      const found = state.sessions.find((se) => se.id === sessionId);
      if (found) found.backgroundBusy = false;
      return json(res, 200, { stopped: 2 });
    }
    const attach = /^\/api\/sessions\/([^/]+)\/attachments$/.exec(url);
    if (attach && req.method === 'POST') {
      // `url` above has had its query cut off; the name is in the raw one.
      const name = new URL(req.url ?? '/', 'http://stub').searchParams.get('name') ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const bytes = Buffer.concat(chunks);
        attachmentUploads.push({ sessionId: attach[1]!, name, bytes });
        // The real endpoint sanitises the name and reports where it landed;
        // the paths a test reads are the ones the prompt will carry.
        const stored: StoredAttachment = {
          name,
          path: `.boxes/attachments/${name}`,
          size: bytes.byteLength,
        };
        json(res, 200, stored);
      });
      return undefined;
    }

    const attached = /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/.exec(url);
    if (attached && req.method === 'GET') {
      const name = decodeURIComponent(attached[2]!);
      const found = attachmentUploads.find(
        (a) => a.sessionId === attached[1] && a.name === name,
      );
      if (!found) return json(res, 404, { error: 'Not found' });
      // The real endpoint serves images as themselves and everything else as
      // a download; the thread only ever asks for the former, which is the
      // part a test is checking. The CSP goes with it, because it is what
      // makes serving an SVG as an SVG safe there.
      const types: Record<string, string> = {
        png: 'image/png',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
      };
      res.writeHead(200, {
        'Content-Type': types[name.split('.').pop() ?? ''] ?? 'application/octet-stream',
        'Content-Length': String(found.bytes.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.end(found.bytes);
      return undefined;
    }

    const exec = /^\/api\/sessions\/([^/]+)(?:\/threads\/([^/]+))?\/exec$/.exec(url);
    if (exec && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const command = (JSON.parse(body || '{}') as { command?: string }).command ?? '';
        execCalls.push({ sessionId: exec[1]!, threadId: exec[2] ?? null, command });
        const { output, exitCode } = execOutput(command);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.write(output);
        res.end(`\n[exit ${exitCode}]\n`);
      });
      return undefined;
    }
    if (exec && req.method === 'GET') return json(res, 200, { records: execLog });

    const review = /^\/api\/sessions\/([^/]+)\/review(?:\/(tree|file|annotations|base))?$/.exec(
      url,
    );
    if (review) {
      return answerReview(req, res, state, reviewCalls, review[1]!, review[2] ?? '');
    }

    const agentSets = /^\/api\/agent-sets(?:\/([^/]+))?(?:\/(items|preview))?$/.exec(url);
    if (agentSets) {
      return answerAgentSets(req, res, state, agentSets[1], agentSets[2] ?? '');
    }

    // Before the credential routes below, which would otherwise take the id
    // and leave the rest of the path unread.
    const login = /^\/api\/credentials\/([^/]+)\/login(?:\/([^/]+))?(?:\/(code))?$/.exec(url);
    if (login) {
      return answerLogin(req, res, state, logins, running, {
        id: login[1] as CredentialId,
        loginId: login[2],
        tail: login[3],
      });
    }

    const credentials = /^\/api\/credentials(?:\/([^/]+))?$/.exec(url);
    if (credentials) {
      return answerCredentials(req, res, state, credentials[1]);
    }

    if (url === '/api/settings') {
      if (req.method === 'GET') return json(res, 200, state.settings);
      if (req.method === 'PATCH') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString('utf8')));
        req.on('end', () => {
          const patch = JSON.parse(body || '{}') as Partial<Settings>;
          // The dialogs are merged one harness at a time, the way
          // orchestrator/src/settings.ts merges them: two browsers
          // configuring two agents must not overwrite each other.
          state.settings = {
            ...state.settings,
            ...patch,
            dialogs: { ...state.settings.dialogs, ...patch.dialogs },
          };
          json(res, 200, state.settings);
        });
        return undefined;
      }
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
    attachmentUploads,
    execCalls,
    backgroundStops,
    boxStops,
    execLog,
    reviewCalls,
    sessionCalls,
    threadCalls,
    logins,
    pushLoginState: (id, next) => {
      const live = [...running.values()].find((l) => l.id === id);
      if (live) {
        live.steps.push(next);
        return;
      }
      const script = state.loginScripts[id] ?? { steps: [] };
      state.loginScripts[id] = { ...script, steps: [...script.steps, next] };
    },
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
 * Answers the six review routes from the stub's in-memory review.
 *
 * The point of keeping real state rather than canned bodies: a comment written
 * through the API has to come back in the next tree and file fetch, because
 * that loop is what the browser tests are about.
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

  /** The repository a workspace-relative path belongs to, longest prefix first. */
  const repoFor = (path: string): ReviewRepo | null =>
    review.repos
      .filter((repo) => repo.path === '' || path.startsWith(`${repo.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null;

  if (endpoint === 'tree' && req.method === 'GET') {
    const body: ReviewTreeResponse = {
      repos: review.repos,
      hasGit: review.repos.length > 0,
      // Files, plus the ones a status reports as deleted — they are on no
      // disk, and the real service puts them back the same way.
      entries: markStubRepos(
        buildStubTree([
          ...Object.keys(review.files),
          ...Object.entries(review.statuses)
            .filter(([path, status]) => status === 'deleted' && !review.files[path])
            .map(([path]) => path),
        ]),
        review.repos,
      ),
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
    // A file the change deleted is listed by its status and has no content:
    // the real service answers for it rather than 404ing, so the stub does.
    if (content === undefined && review.statuses[path] === 'deleted') {
      return json(res, 200, {
        path,
        repo: repoFor(path)?.path ?? null,
        content: '',
        truncated: false,
        binary: false,
        deleted: true,
        size: 0,
        lines: 0,
        language: languageOf(path),
        status: 'deleted',
        diff: { lines: {}, hunks: [], deletions: [] },
        annotations: [],
      } satisfies ReviewFileResponse);
    }
    if (content === undefined) return json(res, 404, { error: 'File not found' });
    const body: ReviewFileResponse = {
      path,
      repo: repoFor(path)?.path ?? null,
      content,
      truncated: false,
      binary: false,
      deleted: false,
      size: content.length,
      lines: content.split('\n').filter((_, i, all) => i < all.length - 1 || all[i] !== '').length,
      language: languageOf(path),
      status: review.statuses[path] ?? null,
      diff: review.diffs[path] ?? { lines: {}, hunks: [], deletions: [] },
      annotations: annotationsOf(path),
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
      if (rev === 'nope') return json(res, 400, { error: `unknown revision: ${rev}` });
      const wanted = rev === null ? '' : rev.trim();
      review.base = { rev: wanted };
      // One expression, resolved separately in each repository: `only-app`
      // names a branch in the first and nothing in the second, which is the
      // soft failure the picker has to report rather than refuse.
      review.repos = review.repos.map((repo, index) => ({
        ...repo,
        baseCommit:
          wanted === '' || (wanted === 'only-app' && index > 0)
            ? ''
            : `${index}`.repeat(8) + 'c'.repeat(32),
      }));
      return json(res, 200, { rev: wanted, repos: review.repos });
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

/** Marks the directories the repositories are rooted at, the way the API does. */
function markStubRepos(
  entries: ReviewTreeResponse['entries'],
  repos: ReviewRepo[],
): ReviewTreeResponse['entries'] {
  const roots = new Set(repos.map((repo) => repo.path));
  const mark = (level: ReviewTreeResponse['entries']): ReviewTreeResponse['entries'] =>
    level.map((entry) =>
      entry.isDir
        ? {
            ...entry,
            ...(roots.has(entry.path) ? { repo: true } : {}),
            children: mark(entry.children ?? []),
          }
        : entry,
    );
  return mark(entries);
}

/** The language the real API would report, for the handful the stub serves. */
function languageOf(path: string): string {
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.md')) return 'markdown';
  return '';
}

/**
 * The agent-set endpoints, over an in-memory list.
 *
 * Enough of a model for the editor to be exercised end to end: a written item
 * comes back in the next read, and the preview merges the global set with the
 * one asked for, which is the behaviour the view actually renders.
 */
function answerAgentSets(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  state: StubState,
  setId: string | undefined,
  endpoint: string,
): void {
  const summarize = (set: AgentSetDetail): AgentSetDetail => ({
    ...set,
    hasAgentsMd: set.agentsMd.trim() !== '',
    skillCount: set.items.filter((i) => i.kind === 'skill').length,
    commandCount: set.items.filter((i) => i.kind === 'command').length,
  });

  const withBody = (fn: (body: Record<string, unknown>) => void): void => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => fn(JSON.parse(raw || '{}') as Record<string, unknown>));
  };

  if (setId === undefined) {
    if (req.method === 'GET') return json(res, 200, state.agentSets.map(summarize));
    if (req.method === 'POST') {
      return withBody((body) => {
        const created = stubAgentSet({
          id: `as${state.agentSets.length}`,
          name: String(body['name'] ?? ''),
          global: false,
          items: [],
        });
        state.agentSets.push(created);
        return json(res, 201, summarize(created));
      });
    }
  }

  const set = state.agentSets.find((s) => s.id === setId);
  if (!set) return json(res, 404, { error: 'Agent set not found' });

  if (endpoint === '' && req.method === 'GET') return json(res, 200, summarize(set));
  if (endpoint === '' && req.method === 'PATCH') {
    return withBody((body) => {
      if (typeof body['name'] === 'string') set.name = body['name'];
      if (typeof body['agentsMd'] === 'string') set.agentsMd = body['agentsMd'];
      return json(res, 200, summarize(set));
    });
  }
  if (endpoint === '' && req.method === 'DELETE') {
    state.agentSets = state.agentSets.filter((s) => s.id !== setId);
    res.writeHead(204).end();
    return undefined;
  }
  if (endpoint === 'items' && req.method === 'PUT') {
    return withBody((body) => {
      const kind = body['kind'] as AgentItem['kind'];
      const name = String(body['name'] ?? '').toLowerCase();
      const content = String(body['content'] ?? '');
      set.items = [
        ...set.items.filter((i) => !(i.kind === kind && i.name === name)),
        { kind, name, content, updatedAt: Date.now() },
      ].sort((a, b) => b.kind.localeCompare(a.kind) || a.name.localeCompare(b.name));
      return json(res, 200, summarize(set));
    });
  }
  if (endpoint === 'items' && req.method === 'DELETE') {
    const query = new URL(req.url ?? '', 'http://stub').searchParams;
    set.items = set.items.filter(
      (i) => !(i.kind === query.get('kind') && i.name === query.get('name')),
    );
    return json(res, 200, summarize(set));
  }
  if (endpoint === 'preview' && req.method === 'GET') {
    const global = state.agentSets.find((s) => s.global);
    const byKey = new Map<string, AgentItem>();
    for (const item of global?.items ?? []) byKey.set(`${item.kind}/${item.name}`, item);
    const overrides: Array<{ kind: AgentItem['kind']; name: string }> = [];
    if (!set.global) {
      for (const item of set.items) {
        const key = `${item.kind}/${item.name}`;
        if (byKey.has(key)) overrides.push({ kind: item.kind, name: item.name });
        byKey.set(key, item);
      }
    }
    return json(res, 200, {
      agentsMd: [global?.agentsMd ?? '', set.global ? '' : set.agentsMd]
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .join('\n\n'),
      items: [...byKey.values()],
      overrides,
    });
  }
  return json(res, 404, { error: 'Not found' });
}

// --- the credential endpoints -------------------------------------------------

/**
 * Answers the three credential routes from the stub's own list.
 *
 * Real state rather than canned bodies, and the same one-way rule as the API:
 * a PUT carries a secret, and nothing this returns ever does. The account is
 * derived here the way the store derives it, so what the page shows after a
 * paste is what it would show against the real thing.
 */
function answerCredentials(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  state: StubState,
  id: string | undefined,
): void {
  if (id === undefined) {
    if (req.method === 'GET') return json(res, 200, state.credentials);
    return json(res, 404, { error: 'Not found' });
  }

  if (req.method === 'PUT') {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const { method = 'token', secret = '' } = JSON.parse(body || '{}') as {
        method?: CredentialMethod;
        secret?: string;
      };
      if (secret.trim() === '') return json(res, 400, { error: 'secret is required' });
      const stored = stubCredential({
        id: id as CredentialId,
        method,
        account: secret.length > 4 ? secret.slice(-4) : null,
        updatedAt: Date.now(),
      });
      remember(state, stored);
      return json(res, 200, stored);
    });
    return undefined;
  }

  if (req.method === 'DELETE') {
    state.credentials = state.credentials.filter((c) => c.id !== id);
    state.harnesses = state.harnesses.map((h) =>
      h.id === id ? { ...h, credential: null, runnable: false } : h,
    );
    res.writeHead(204);
    res.end();
    return undefined;
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/**
 * Stores one credential and lets the harness that runs on it run again, which
 * is what takes the warning off the session list.
 */
function remember(state: StubState, stored: CredentialSummary): void {
  state.credentials = [...state.credentials.filter((c) => c.id !== stored.id), stored];
  state.harnesses = state.harnesses.map((h) =>
    h.id === stored.id ? { ...h, credential: stored, runnable: true } : h,
  );
}

// --- the login endpoints ------------------------------------------------------

/** One login the stub is answering for. */
interface RunningLogin {
  id: CredentialId;
  /** What is left to serve; the last entry repeats. */
  steps: LoginState[];
  /** How far the polls have got through them. */
  at: number;
  afterCode: LoginState[];
  record: StubOrchestrator['logins'][number];
  /** Whether reaching `done` has already written the credential. */
  stored: boolean;
}

/**
 * Answers the four login routes by walking a script.
 *
 * The real flow runs a CLI in a container and the page only ever sees a state
 * per poll, so a scripted walk is the whole of what there is to stand in for.
 * What the stub keeps that a canned answer could not is the consequence: a
 * login that reaches `done` writes the credential, so the page's refetch
 * finds the row the real one would have written.
 */
function answerLogin(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  state: StubState,
  logins: StubOrchestrator['logins'],
  running: Map<string, RunningLogin>,
  path: { id: CredentialId; loginId: string | undefined; tail: string | undefined },
): void {
  const { id, loginId, tail } = path;

  if (loginId === undefined) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    // One at a time per credential: starting a second ends the first, as the
    // orchestrator's own store does.
    for (const [open, live] of running) {
      if (live.id !== id) continue;
      live.record.cancelled = true;
      running.delete(open);
    }
    const script = state.loginScripts[id] ?? { steps: [{ state: 'starting' } as LoginState] };
    const started = `lg${logins.length + 1}`;
    const record = { id, loginId: started, codes: [] as string[], cancelled: false };
    logins.push(record);
    running.set(started, {
      id,
      steps: [...script.steps],
      at: 0,
      afterCode: [...(script.afterCode ?? [{ state: 'done' }])],
      record,
      stored: false,
    });
    return json(res, 200, { loginId: started } satisfies StartLoginResponse);
  }

  const live = running.get(loginId);
  if (!live) return json(res, 404, { error: 'No such login' });

  if (tail === 'code') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const { code = '' } = JSON.parse(body || '{}') as { code?: string };
      live.record.codes.push(code);
      // What the CLI does with it: the prompt it was blocked on is answered,
      // and the flow carries on from there.
      live.steps = [...live.afterCode];
      live.at = 0;
      res.writeHead(204);
      res.end();
    });
    return undefined;
  }

  if (req.method === 'DELETE') {
    live.record.cancelled = true;
    running.delete(loginId);
    res.writeHead(204);
    res.end();
    return undefined;
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const current = live.steps[live.at] ?? ({ state: 'starting' } as LoginState);
  live.at = Math.min(live.at + 1, live.steps.length - 1);
  if (current.state === 'done' && !live.stored) {
    live.stored = true;
    // The CLI wrote something: a login to an account for Codex, whose id
    // token names the account, and a one-year token for Claude, which names
    // nobody and is known by its last four characters like any other paste.
    remember(
      state,
      stubCredential(
        id === 'openai'
          ? {
              id,
              method: 'oauth',
              account: 'agent@example.com',
              refreshedAt: Date.now(),
              expiresAt: Date.now() + 21 * 86_400_000,
              updatedAt: Date.now(),
            }
          : {
              id,
              method: 'token',
              account: '9f2c',
              expiresAt: Date.now() + 365 * 86_400_000,
              updatedAt: Date.now(),
            },
      ),
    );
  }
  // A finished login is kept rather than dropped: a poll already in flight
  // when it finished has to be answered with the same ending, not a 404.
  return json(res, 200, current);
}
