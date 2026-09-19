import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  AgentSetDetail,
  ReviewAnnotation,
  ReviewFileResponse,
  SessionSummary,
} from '../../shared/types.ts';
import { buildApp, type Orchestrator } from '../../orchestrator/src/app.ts';
import { loadConfig, setConfigForTests, type Config } from '../../orchestrator/src/config.ts';
import {
  currentThread,
  getThread,
  listThreads,
  openDb,
  type Db,
  type SessionRow,
  type ThreadRow,
} from '../../orchestrator/src/db.ts';
import { attachTerminal } from '../../orchestrator/src/gateway/terminal.ts';
import { setLogLevel } from '../../orchestrator/src/log.ts';
import type { SessionManager } from '../../orchestrator/src/sessions.ts';
import * as ws from '../../orchestrator/src/workspaces.ts';
import { TERMINAL_SUBPROTOCOL } from '../../shared/terminal.ts';
import { FAKE_SELF_CONTAINER, installFakeDocker, type FakeDocker } from './fake-docker.ts';
import { attachStubGateway, type GatewayScript, type StubGateway } from './stub-gateway.ts';
import {
  buildWorkspace,
  installLocalGit,
  removeLocalGit,
  reviewWorkspace,
  type WorkspaceSpec,
} from './workspace.ts';

/**
 * The real orchestrator, driven in a browser over a fake Docker.
 *
 * Everything the dashboard talks to here is the shipped code: the real routes
 * over a real SQLite database, the real session, review and agent-set
 * services, and the real static handler serving the production bundle. What
 * is not real is what cannot be: the Docker daemon, git inside a container,
 * and the agent itself.
 *
 * The agent stays stubbed because there is nothing to talk to. A browser's
 * WebSocket reaches the stub gateway of stub-gateway.ts, which speaks the
 * agent half of ACP from canned scripts, and the REST routes that need an
 * adapter — minting a thread, killing background work — reach the stand-in
 * below instead of a spawned process.
 */

/** The bearer every session's WebSocket upgrade carries in this suite. */
const WS_TOKEN = 'e2e-ws-token-0123456789abcdef';

/** The Claude token this deployment is configured with, as far as it knows. */
const CLAUDE_TOKEN = 'a-token-for-the-tests';

/** Marks a request this harness made, so setup is not recorded as a test's. */
const SETUP_HEADER = 'x-boxes-e2e-setup';

/** The session a test gets unless it asks for another. */
export const DEFAULT_SESSION = {
  id: 'a1b2c3d4',
  name: 'refactor auth',
  threadId: 'th1',
} as const;

/** One conversation of a fixture session. */
export interface ThreadSpec {
  /** Named rather than generated, so a test can link straight at it. */
  id?: string;
  title?: string | null;
  done?: boolean;
  /** Whether a prompt is open on this thread, as the database records it. */
  turnActive?: boolean;
  /** Whether the agent is talking on this thread. */
  speaking?: boolean;
  /** Whether this thread has left something running in the box. */
  backgroundBusy?: boolean;
  /** Permission requests waiting on this thread. */
  pendingCount?: number;
  lastActiveAt?: number;
}

/** A session as a test wants to find it. */
export interface SessionSpec {
  id?: string;
  name?: string;
  status?: SessionRow['status'];
  /** Whether the fake daemon has its container running. */
  containerRunning?: boolean;
  threads?: ThreadSpec[];
  /** How many browsers the gateway has on this session. */
  attachedCount?: number;
  /** Whether the adapter advertises forking, which the list offers. */
  canFork?: boolean;
  /** How big the workspace is made, as a sparse file nothing reads. */
  diskBytes?: number;
  /**
   * A session still backed by a workspace volume, which this process cannot
   * read and the review refuses with an explanation.
   */
  legacy?: boolean;
}

/** What the deployment answers about itself, which a test may change. */
export interface DeploymentState {
  /** Whether the health probe says a Claude token is configured. */
  claudeTokenConfigured: boolean;
  /**
   * The cookie an authenticating reverse proxy in front of this deployment
   * would be checking, or null for the loopback default that has none.
   *
   * Boxes has no auth of its own, so anything past a single-user machine is
   * behind one (ARCHITECTURE.md, "One origin, one port"). Named here because
   * that changes what the browser sees: a request the proxy does not
   * recognize is bounced to a login page rather than answered, and not every
   * request the page makes carries credentials.
   */
  requireCookie: string | null;
}

/**
 * The half of a Fastify request the hooks below read.
 *
 * Spelled out rather than imported: Fastify's own types are the
 * orchestrator's dependency, and a hook handler's parameters are not
 * inferrable from the instance alone.
 */
interface HookRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
  body: unknown;
}

/** The half of a Fastify reply the hooks below use. */
interface HookReply {
  code(status: number): HookReply;
  header(name: string, value: string): HookReply;
  type(value: string): HookReply;
  send(payload?: unknown): HookReply;
}

/** One review mutation the browser made, as the tests read them back. */
export interface ReviewCall {
  method: string;
  sessionId: string;
  body: unknown;
}

/** An agent set a test wants to find, beside the global one. */
export interface AgentSetSpec {
  /** Named rather than generated, so a test can link straight at it. */
  id: string;
  name: string;
  agentsMd?: string;
  items?: Array<{ kind: 'skill' | 'command'; name: string; content: string }>;
}

/** A running orchestrator, with the handles a test drives it by. */
export interface TestOrchestrator {
  url: string;
  /** The ACP gateway attached to the same server, on the same origin. */
  gateway: StubGateway;
  state: DeploymentState;
  /** Files uploaded to the attachments endpoint, in order. */
  attachmentUploads: Array<{ sessionId: string; name: string; bytes: Buffer }>;
  /**
   * Every stop of background work the browser asked for, in order.
   *
   * `processId` is absent where the reader asked for all of a thread's work
   * rather than one command of it.
   */
  backgroundStops: Array<{ sessionId: string; threadId: string; processId?: string }>;
  /** Every review mutation the browser made, in order. */
  reviewCalls: ReviewCall[];
  /** Adds a session, its directories, its threads and its container. */
  createSession(spec?: SessionSpec): void;
  /** Forgets every session, for a test that wants the deployment back. */
  resetSessions(): void;
  /** Rebuilds a session's workspace from a fixture. */
  review(sessionId: string, spec?: WorkspaceSpec): void;
  /** Writes one file of a workspace, as the agent working in it would. */
  write(sessionId: string, path: string, content: string): void;
  /** Reads one file of a workspace back. */
  read(sessionId: string, path: string): string;
  /** Whether the session has a REVIEW.md, which is what a review is. */
  hasReview(sessionId: string): boolean;
  /** Writes one comment through the real API, as a previous visit would have. */
  comment(sessionId: string, path: string, line: number, text: string): Promise<void>;
  /** The comments on one file, as the API reports them. */
  comments(sessionId: string, path: string): Promise<ReviewAnnotation[]>;
  /** What a terminal in a box answers a typed line with. */
  terminalAnswer: (line: string) => string;
  /** How many terminals the orchestrator counts as open on one session. */
  terminalsOpen(sessionId: string): number;
  /** Replaces the named agent sets, and fills in the global one. */
  agentSets(global: Omit<AgentSetSpec, 'id' | 'name'>, named: AgentSetSpec[]): Promise<void>;
  /** One agent set as the API reports it, for what a test wrote through the UI. */
  agentSet(setId: string): Promise<AgentSetDetail>;
  close(): Promise<void>;
}

/**
 * The adapter side of a session, which no test has a real agent for.
 *
 * The routes that mint a thread, switch one or kill what a thread left
 * running all go through the session's upstream connection, and a real one
 * spawns an ACP adapter inside the container. This stands in for it: thread
 * ids are minted on the stub gateway, so the conversation a browser opens
 * afterwards is the one the gateway holds and a fork carries what its source
 * had said.
 *
 * The rest is what a session list reads off a live gateway — who is talking,
 * what is still running, how many browsers are attached — which lives in
 * memory beside the adapter and nowhere else.
 */
class TestUpstream {
  /** Browsers the gateway has on this session, as the list reports it. */
  attachedCount = 0;
  /** Whether the adapter advertises forking, which the list offers. */
  canFork = true;
  /** Whether anything is running in the box, or null before it was read. */
  backgroundActive: boolean | null = false;
  /** The adapter's ids for the threads the agent is talking on. */
  speakingThreads: string[] = [];
  /** The adapter's ids for the threads with work still running. */
  workingThreads: string[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly db: Db,
    private readonly gateway: StubGateway,
  ) {}

  /** Nothing is held, so the housekeeping sweep may forget this. */
  get holdsNothing(): boolean {
    return true;
  }

  /** Mints an empty conversation and makes it current. */
  async newThread(): Promise<ThreadRow> {
    return this.mint(this.gateway.newThread(), null);
  }

  /** Mints a conversation carrying another's history, and makes it current. */
  async forkThread(sourceThreadId: string): Promise<ThreadRow> {
    const source = getThread(this.db, sourceThreadId);
    if (!source?.acp_session_id) throw new Error('Thread not found');
    return this.mint(this.gateway.forkThread(source.acp_session_id), source.id);
  }

  /** Makes one of the session's threads current. Nobody is dropped. */
  switchThread(threadId: string): ThreadRow {
    const row = getThread(this.db, threadId);
    if (!row) throw new Error('Thread not found');
    this.db
      .prepare('UPDATE sessions SET current_thread_id = ? WHERE id = ?')
      .run(threadId, this.sessionId);
    if (row.acp_session_id) this.gateway.select(row.acp_session_id);
    return row;
  }

  /** Mints this session's first conversation and reports the adapter's id. */
  mintFirstThread(): string {
    return this.mint(this.gateway.newThread(), null).acp_session_id ?? '';
  }

  /** Reports one process signalled, which is what the browser is told. */
  async stopBackgroundWork(): Promise<number> {
    return 1;
  }

  /** Ends the connection. Nothing is spawned here, so nothing is torn down. */
  stop(): void {
    return undefined;
  }

  /** Forgets the session, on the same terms as {@link stop}. */
  close(): void {
    return undefined;
  }

  /** Stores a minted conversation and makes it the session's current one. */
  private mint(acpSessionId: string, inheritsFrom: string | null): ThreadRow {
    const ordinal = listThreads(this.db, this.sessionId).length + 1;
    return insertThread(this.db, this.sessionId, {
      id: threadName(this.sessionId, ordinal),
      acpSessionId,
      ordinal,
      inheritsFrom,
    });
  }
}

/**
 * The manager's own map of upstream connections.
 *
 * Reached into rather than replaced: the manager creates one on first use and
 * reads what a browser sees off the entry it holds, so a stand-in has to be
 * the entry rather than something handed to a caller.
 */
function upstreamsOf(manager: SessionManager): Map<string, unknown> {
  return (manager as unknown as { upstreams: Map<string, unknown> }).upstreams;
}

/**
 * What a fixture conversation is called.
 *
 * Short on the session the suite drives, so a route naming a thread can be
 * written out in a test; carrying the session on every other one, because a
 * thread id is unique across the deployment rather than within a session.
 */
function threadName(sessionId: string, ordinal: number): string {
  return sessionId === DEFAULT_SESSION.id ? `th${ordinal}` : `${sessionId}-th${ordinal}`;
}

/** Inserts one conversation and makes it the session's current one. */
function insertThread(
  db: Db,
  sessionId: string,
  thread: {
    id: string;
    acpSessionId: string;
    ordinal: number;
    title?: string | null;
    done?: boolean;
    turnActive?: boolean;
    lastActiveAt?: number;
    inheritsFrom?: string | null;
  },
): ThreadRow {
  const now = Date.now();
  const row: ThreadRow = {
    id: thread.id,
    session_id: sessionId,
    acp_session_id: thread.acpSessionId,
    title: thread.title ?? null,
    ordinal: thread.ordinal,
    turn_active: thread.turnActive ? 1 : 0,
    inherits_from: thread.inheritsFrom ?? null,
    mode_id: null,
    model_id: null,
    done: thread.done ? 1 : 0,
    created_at: now,
    last_active_at: thread.lastActiveAt ?? now,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
         turn_active, inherits_from, mode_id, model_id, done, created_at,
         last_active_at)
       VALUES (@id, @session_id, @acp_session_id, @title, @ordinal,
         @turn_active, @inherits_from, @mode_id, @model_id, @done, @created_at,
         @last_active_at)`,
    ).run(row);
    db.prepare('UPDATE sessions SET current_thread_id = ? WHERE id = ?').run(row.id, sessionId);
  })();
  return row;
}

/** The stored session behind an id, or nothing where the deployment has none. */
function sessionRow(db: Db, sessionId: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | SessionRow
    | undefined;
}

/** A file of the given apparent size, which costs no disk to make. */
function sparseFile(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  ftruncateSync(fd, Math.round(bytes));
  closeSync(fd);
}

/** Writes a file of a workspace, creating the directories above it. */
function writeFile(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Adds one session: its row, its directories, its conversations, its
 * container, and the stand-in adapter the routes reach through.
 */
function createSession(
  app: Orchestrator,
  db: Db,
  docker: FakeDocker,
  upstreamFor: (sessionId: string) => TestUpstream,
  spec: SessionSpec,
): void {
  const cfg: Config = app.cfg;
  const id = spec.id ?? DEFAULT_SESSION.id;
  const now = Date.now();
  const legacy = spec.legacy === true;
  const containerId = `session-${id}`;
  const index = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
       review_base_rev, status, agent_set_id, current_thread_id, ws_token,
       created_at, last_active_at)
     VALUES (?, ?, 'DEFAULT', ?, '["claude-agent-acp"]', ?, ?, ?, ?, '', ?, ?,
       NULL, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    spec.name ?? DEFAULT_SESSION.name,
    cfg.SESSION_IMAGE,
    containerId,
    `sn-${id}`,
    `10.200.${index}.0/24`,
    legacy ? `ws-${id}` : '',
    legacy ? null : ws.workspacePath(cfg.DATA_DIR, id),
    ws.homePath(cfg.DATA_DIR, id),
    spec.status ?? 'running',
    WS_TOKEN,
    now,
    now,
  );

  if (!legacy) ws.createWorkspace(cfg.DATA_DIR, id);
  ws.createHome(cfg.DATA_DIR, id);
  docker.addContainer(containerId, spec.containerRunning ?? spec.status !== 'stopped');

  const upstream = upstreamFor(id);
  upstream.canFork = spec.canFork ?? true;
  const threads = spec.threads ?? [{}];
  threads.forEach((thread, at) => {
    // The stub gateway's own first conversation is acp-thread-1 and it mints
    // the rest in order, so a fixture thread carries the id it would have.
    const acpSessionId = `acp-thread-${at + 1}`;
    insertThread(db, id, {
      id: thread.id ?? threadName(id, at + 1),
      acpSessionId,
      ordinal: at + 1,
      title: thread.title ?? null,
      done: thread.done ?? false,
      turnActive: thread.turnActive ?? false,
      ...(thread.lastActiveAt === undefined ? {} : { lastActiveAt: thread.lastActiveAt }),
    });
    if (thread.backgroundBusy) upstream.workingThreads.push(acpSessionId);
    if (thread.speaking) upstream.speakingThreads.push(acpSessionId);
    for (let i = 0; i < (thread.pendingCount ?? 0); i++) {
      db.prepare(
        `INSERT INTO pending_requests (session_id, acp_session_id, method, params, created_at)
         VALUES (?, ?, 'session/request_permission', '{}', ?)`,
      ).run(id, acpSessionId, now);
    }
  });
  upstream.backgroundActive = upstream.workingThreads.length > 0;
  upstream.attachedCount = spec.attachedCount ?? 0;
  // The first conversation is the one a connection naming none gets, which is
  // where a session that has been worked in is left.
  db.prepare('UPDATE sessions SET current_thread_id = ? WHERE id = ?').run(
    threads[0]?.id ?? threadName(id, 1),
    id,
  );

  if (spec.diskBytes !== undefined && !legacy) {
    sparseFile(join(ws.workspacePath(cfg.DATA_DIR, id), 'checkout.bin'), spec.diskBytes);
  }
}

/**
 * Lists sessions until every one that asked for a size reports one.
 *
 * A workspace is measured off the request path on purpose — a list must never
 * wait for a disk walk — so the first answer carries no size at all. Asking
 * here rather than in the browser keeps the first thing a test sees complete.
 */
async function measureSessions(app: Orchestrator, specs: SessionSpec[]): Promise<void> {
  const wanted = specs.filter((spec) => spec.diskBytes !== undefined).length;
  if (wanted === 0) return;
  for (let attempt = 0; attempt < 200; attempt++) {
    const res = await app.app.inject({ url: '/api/sessions' });
    const listed = res.json() as SessionSummary[];
    if (listed.filter((s) => s.diskBytes !== null).length >= wanted) return;
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The review mutation a request is, as the tests name them. */
function reviewCallOf(method: string, endpoint: string): string | null {
  if (endpoint === 'annotations' && method === 'PUT') return 'PUT';
  if (endpoint === 'annotations' && method === 'DELETE') return 'DELETE';
  if (endpoint === 'file' && method === 'PUT') return 'PUT file';
  if (endpoint === 'base' && method === 'PUT') return 'PUT base';
  if (endpoint === '' && method === 'DELETE') return 'DELETE review';
  return null;
}

/**
 * Wires the two things a deployment has that the orchestrator does not: the
 * authenticating proxy the README puts in front of it, and a record of what
 * the browser asked for.
 *
 * Both are hooks rather than routes, so every request still reaches the real
 * handler and nothing about the API is answered here.
 */
/**
 * Wires the real terminal endpoint onto the harness's server.
 *
 * The same upgrade check index.ts makes: the path names a box, and the token
 * offered as a subprotocol entry is that box's own. Everything past the
 * handshake is the orchestrator's own code, over the fake daemon's pty.
 */
function attachTerminalEndpoint(app: Orchestrator, db: Db): void {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(TERMINAL_SUBPROTOCOL) ? TERMINAL_SUBPROTOCOL : false,
  });
  app.app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const path = /^\/ws\/sessions\/([^/]+)\/terminal$/.exec(url);
    if (!path) return;
    const sessionId = path[1]!;
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((entry) => entry.trim());
    const token = sessionRow(db, sessionId)?.ws_token ?? null;
    if (!offered.includes(TERMINAL_SUBPROTOCOL) || !token || !offered.includes(`bearer.${token}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, sessionId, app.manager));
  });
}

function installHooks(
  app: Orchestrator,
  state: DeploymentState,
  calls: Pick<
    TestOrchestrator,
    'attachmentUploads' | 'backgroundStops' | 'reviewCalls'
  >,
): void {
  app.app.addHook('onRequest', async (req: HookRequest, reply: HookReply) => {
    if (!state.requireCookie) return;
    if ((req.headers.cookie ?? '').includes(`${state.requireCookie}=`)) return;
    // What oauth2-proxy, Authelia and a Caddy forward_auth all do: anything
    // without the cookie is redirected to a login page that answers 200.
    if ((req.url.split('?')[0] ?? '') === '/login') {
      return reply.type('text/html; charset=utf-8').send('<!doctype html><title>Sign in</title>');
    }
    return reply.code(302).header('Location', '/login').send();
  });

  app.app.addHook('preHandler', async (req: HookRequest) => {
    if (req.headers[SETUP_HEADER] !== undefined) return;
    const path = req.url.split('?')[0] ?? '';
    const body = req.body as Record<string, unknown> | Buffer | undefined;

    const attachment = /^\/api\/sessions\/([^/]+)\/attachments$/.exec(path);
    if (attachment && req.method === 'POST' && Buffer.isBuffer(body)) {
      calls.attachmentUploads.push({
        sessionId: attachment[1]!,
        name: String((req.query as { name?: string }).name ?? ''),
        bytes: body,
      });
      return;
    }

    const stop = /^\/api\/sessions\/([^/]+)\/threads\/([^/]+)\/background\/stop$/.exec(path);
    if (stop && req.method === 'POST') {
      const asked = (body as Record<string, unknown> | undefined)?.['processId'];
      calls.backgroundStops.push({
        sessionId: stop[1]!,
        threadId: stop[2]!,
        ...(asked === undefined ? {} : { processId: String(asked) }),
      });
      return;
    }

    const review = /^\/api\/sessions\/([^/]+)\/review(?:\/(dir|file|annotations|base))?$/.exec(
      path,
    );
    const named = review ? reviewCallOf(req.method, review[2] ?? '') : null;
    if (review && named) {
      // A delete carries its subject in the query rather than in a body,
      // which is the shape the tests read back.
      calls.reviewCalls.push({
        method: named,
        sessionId: review[1]!,
        body: req.method === 'DELETE' ? deleteSubject(req.query) : (body ?? null),
      });
    }
  });
}

/** What a review delete names, taken off the query it travels in. */
function deleteSubject(query: unknown): unknown {
  const { path, line } = query as { path?: string; line?: string };
  if (path === undefined) return null;
  return { path, line: Number(line) };
}

/**
 * Starts the orchestrator on an ephemeral port, with the sessions given.
 *
 * `gatewayScript` is the agent's half: what the stub gateway answers prompts
 * with, which modes it advertises, and what it asks permission for.
 */
export async function startOrchestrator(
  sessions: SessionSpec[] = [{}],
  gatewayScript: Partial<GatewayScript> = {},
): Promise<TestOrchestrator> {
  const dataDir = mkdtempSync(join(tmpdir(), 'boxes-e2e-'));
  // Every response is logged at info, which would bury a test run; what goes
  // wrong in the orchestrator is still reported.
  setLogLevel('error');
  const cfg = loadConfig({
    ...process.env,
    DATA_DIR: dataDir,
    // The uid this process already is, so nothing it writes has to be given
    // away and every chown is a no-op.
    SESSION_UID: String(process.getuid?.() ?? 1020),
    SESSION_GID: String(process.getgid?.() ?? 1020),
    PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
  });
  setConfigForTests(cfg);

  // The fake daemon stands the process in a container too, so the
  // orchestrator's own image is read the way a deployment reads it.
  const docker = installFakeDocker(cfg.SESSION_IMAGE, FAKE_SELF_CONTAINER);
  const db = openDb(dataDir);
  // The bundle this run just built, rather than the copy a built image holds.
  const app = buildApp(cfg, db, { bundleDir: resolve(import.meta.dirname, '../dist') });
  installLocalGit((sessionId) => ws.workspacePath(dataDir, sessionId));

  /**
   * The stand-in adapter for a session, made on first use.
   *
   * The manager creates a real one the same way, so this is put in its map
   * rather than handed out: what the session list reports about a live
   * gateway is read off the entry it holds.
   */
  const upstreamFor = (sessionId: string): TestUpstream => {
    const held = upstreamsOf(app.manager).get(sessionId);
    if (held) return held as TestUpstream;
    const made = new TestUpstream(sessionId, db, gateway);
    upstreamsOf(app.manager).set(sessionId, made);
    return made;
  };

  const state: DeploymentState = {
    get claudeTokenConfigured() {
      return cfg.PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN !== '';
    },
    set claudeTokenConfigured(configured: boolean) {
      // Written through, because the configuration is read-only to the
      // orchestrator: it parses it once at boot, and a test changing this is
      // the deployment having been configured differently.
      const writable = cfg as { PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: string };
      writable.PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN = configured ? CLAUDE_TOKEN : '';
    },
    requireCookie: null,
  };
  const calls = {
    attachmentUploads: [] as TestOrchestrator['attachmentUploads'],
    backgroundStops: [] as TestOrchestrator['backgroundStops'],
    reviewCalls: [] as ReviewCall[],
  };

  // Same origin as the dashboard, which is how the deployment serves it and
  // why the browser can derive the WebSocket URL from its own location. The
  // real gateway is wired onto this same server in index.ts, and this takes
  // that place.
  const gateway = attachStubGateway(
    app.app.server,
    {
      modes: null,
      configOptions: [],
      prompts: [],
      permissions: [],
      queuedPermission: null,
      ...gatewayScript,
    },
    {
      token: (sessionId) => sessionRow(db, sessionId)?.ws_token ?? null,
      thread: (sessionId, threadId) => {
        const row = threadId ? getThread(db, threadId) : currentThread(db, sessionId);
        if (row) return row.session_id === sessionId ? row.acp_session_id : null;
        if (threadId !== null) return null;
        // A box nobody has opened has no conversation yet. The real gateway
        // mints one as a browser pins to it, which is what makes a session
        // just created usable, so the stand-in adapter does the same.
        if (!sessionRow(db, sessionId)) return null;
        return upstreamFor(sessionId).mintFirstThread();
      },
    },
  );

  // The terminal is not stood in for: it is real orchestrator code down to
  // the pty, and the fake daemon already answers with one. Only the upgrade
  // has to be wired here, because index.ts is what does that in a deployment
  // and this harness takes its place.
  attachTerminalEndpoint(app, db);

  installHooks(app, state, calls);

  // As boot does, and for the same reason: a session's environment is built
  // from the egress policy, so creating one before it exists fails.
  await app.egress.prepare();

  await app.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.app.server.address() as AddressInfo;

  /** A request this harness makes, which is never recorded as a test's. */
  const setup = (
    method: 'GET' | 'PUT' | 'PATCH',
    path: string,
    payload?: unknown,
  ): ReturnType<typeof app.app.inject> =>
    app.app.inject({
      method,
      url: path,
      headers: { [SETUP_HEADER]: '1' },
      ...(payload === undefined ? {} : { payload }),
    });

  const workspaceOf = (sessionId: string): string => ws.workspacePath(dataDir, sessionId);

  const harness: TestOrchestrator = {
    url: `http://127.0.0.1:${port}`,
    gateway,
    state,
    ...calls,
    terminalsOpen: (sessionId) => app.manager.terminalCount(sessionId),
    get terminalAnswer() {
      return docker.terminalAnswer;
    },
    set terminalAnswer(fn: TestOrchestrator['terminalAnswer']) {
      docker.terminalAnswer = fn;
    },
    createSession: (spec = {}) => createSession(app, db, docker, upstreamFor, spec),
    resetSessions: () => {
      const rows = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
      for (const row of rows) {
        ws.removeWorkspace(dataDir, row.id);
        ws.removeHome(dataDir, row.id);
        upstreamsOf(app.manager).delete(row.id);
      }
      db.prepare('DELETE FROM threads').run();
      db.prepare('DELETE FROM pending_requests').run();
      db.prepare('DELETE FROM sessions').run();
    },
    review: (sessionId, spec = reviewWorkspace()) => buildWorkspace(workspaceOf(sessionId), spec),
    write: (sessionId, path, content) => writeFile(workspaceOf(sessionId), path, content),
    read: (sessionId, path) => readFileSync(join(workspaceOf(sessionId), path), 'utf8'),
    hasReview: (sessionId) => existsSync(join(workspaceOf(sessionId), 'REVIEW.md')),
    comment: async (sessionId, path, line, text) => {
      await setup('PUT', `/api/sessions/${sessionId}/review/annotations`, {
        path,
        line,
        comment: text,
      });
    },
    comments: async (sessionId, path) => {
      const res = await setup(
        'GET',
        `/api/sessions/${sessionId}/review/file?path=${encodeURIComponent(path)}`,
      );
      return (res.json() as ReviewFileResponse).annotations;
    },
    agentSet: async (setId) => {
      const res = await setup('GET', `/api/agent-sets/${setId}`);
      return res.json() as AgentSetDetail;
    },
    agentSets: async (global, named) => {
      db.prepare('DELETE FROM agent_items').run();
      db.prepare("DELETE FROM agent_sets WHERE id <> 'global'").run();
      for (const set of named) {
        db.prepare(
          `INSERT INTO agent_sets (id, name, agents_md, created_at, updated_at)
           VALUES (?, ?, '', ?, ?)`,
        ).run(set.id, set.name, Date.now(), Date.now());
      }
      for (const set of [{ id: 'global', ...global }, ...named]) {
        await setup('PATCH', `/api/agent-sets/${set.id}`, { agentsMd: set.agentsMd ?? '' });
        for (const item of set.items ?? []) {
          await setup('PUT', `/api/agent-sets/${set.id}/items`, item);
        }
      }
    },
    close: async () => {
      gateway.close();
      await app.app.close();
      db.close();
      docker.close();
      removeLocalGit();
      setConfigForTests(null as never);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  for (const spec of sessions) harness.createSession(spec);
  await measureSessions(app, sessions);
  return harness;
}
