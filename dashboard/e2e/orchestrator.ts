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
import { PassThrough } from 'node:stream';
import type {
  AgentSetDetail,
  CredentialId,
  CredentialStatus,
  CredentialSummary,
  HarnessId,
  ReviewAnnotation,
  ReviewFileResponse,
  BoxWork,
  BoxSummary,
  BoxTunnel,
  Settings,
  ThreadOptions,
} from '../../shared/types.ts';
import { buildApp, type Orchestrator } from '../../orchestrator/src/app.ts';
import { loadConfig, setConfigForTests, type Config } from '../../orchestrator/src/config.ts';
import {
  getThread,
  latestThread,
  listThreads,
  openDb,
  setThreadAcpId,
  upsertHarnessCatalog,
  type Db,
  type BoxRow,
  type ThreadRow,
} from '../../orchestrator/src/db.ts';
import { checkUpgrade } from '../../orchestrator/src/gateway/downstream.ts';
import { attachTerminal } from '../../orchestrator/src/gateway/terminal.ts';
import { setLogLevel } from '../../orchestrator/src/log.ts';
import type { LoginExecSpec } from '../../orchestrator/src/login.ts';
import type { BoxManager } from '../../orchestrator/src/boxes.ts';
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

/** The bearer every box's WebSocket upgrade carries in this suite. */
const WS_TOKEN = 'e2e-ws-token-0123456789abcdef';

/** The Claude token the deployment holds, as the settings page would have stored it. */
const CLAUDE_TOKEN = 'sk-ant-oat01-a-token-for-the-tests-1234';

/** The OpenAI key the deployment holds when a test gives it one. */
const OPENAI_KEY = 'sk-proj-a-key-for-the-tests-abcd';

/**
 * The auth.json a finished Codex login is read back from: an id token naming
 * the account, and an access token that has not expired.
 */
const LOGIN_DOCUMENT = "{\"tokens\": {\"access_token\": \"eyJhbGciOiAibm9uZSJ9.eyJleHAiOiA0MTAyNDQ0ODAwfQ.\", \"id_token\": \"eyJhbGciOiAibm9uZSJ9.eyJlbWFpbCI6ICJhZ2VudEBleGFtcGxlLmNvbSIsICJodHRwczovL2FwaS5vcGVuYWkuY29tL3Byb2ZpbGUiOiB7ImVtYWlsIjogImFnZW50QGV4YW1wbGUuY29tIn19.\", \"refresh_token\": \"r\"}, \"last_refresh\": \"2026-09-12T10:00:00Z\"}";

/**
 * The modes and settings each adapter advertises, as the harness catalogue
 * stores them. The dialogs read these without asking an adapter.
 */
const CATALOG: Record<
  HarnessId,
  {
    modes: Parameters<typeof upsertHarnessCatalog>[2];
    configOptions: Parameters<typeof upsertHarnessCatalog>[3];
  }
> = {
  claude: {
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
  },
  codex: {
    modes: {
      currentModeId: 'agent-full-access',
      availableModes: [
        { id: 'read-only', name: 'Ask for approval', description: 'Every command waits for a human.' },
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
  },
};

/** Marks a request this harness made, so the recorded calls leave it out. */
const SETUP_HEADER = 'x-boxes-e2e-setup';

/** The box a test gets unless it asks for another. */
export const DEFAULT_BOX = {
  id: 'a1b2c3d4',
  name: 'refactor auth',
  threadId: 'th1',
} as const;

/** One conversation of a fixture box. */
export interface ThreadSpec {
  /** Named rather than generated, so a test can link straight at it. */
  id?: string;
  /** Which agent runs it. Claude unless a test says otherwise. */
  harness?: HarnessId;
  /** The thread's title, or null for an untitled one. */
  title?: string | null;
  /** Whether the thread is marked as done. */
  done?: boolean;
  /** Whether a prompt is open on this thread, as the database records it. */
  turnActive?: boolean;
  /** Whether the agent is talking on this thread. */
  speaking?: boolean;
  /** Whether this thread has left something running in the box. */
  backgroundBusy?: boolean;
  /** Permission requests waiting on this thread. */
  pendingCount?: number;
  /** When the thread was last active, in epoch milliseconds. */
  lastActiveAt?: number;
}

/** A box as a test wants to find it. */
export interface BoxSpec {
  /** The box id. Defaults to the id of {@link DEFAULT_BOX}. */
  id?: string;
  /** The box name. Defaults to the name of {@link DEFAULT_BOX}. */
  name?: string;
  /** The stored status. Defaults to running. */
  status?: BoxRow['status'];
  /** Whether the fake daemon has its container running. */
  containerRunning?: boolean;
  /** The box's threads. Defaults to one thread with no options set. */
  threads?: ThreadSpec[];
  /**
   * Whether the box is busy with work that no thread claims, as after an
   * adapter restart over a running build. Without it, the box is busy exactly
   * when one of its threads is.
   */
  backgroundBusy?: boolean;
  /**
   * What a reading of the box finds running in it, as the detail reports it.
   * The badge reads `backgroundBusy` instead. The two differ when a task an
   * adapter announced is not a process of its own.
   */
  boxWork?: BoxWork[];
  /** The dev tunnel ports the box hosts, as the tunnel reconciler reports them. */
  tunnels?: BoxTunnel[];
  /** How many browsers the gateway has on this box. */
  attachedCount?: number;
  /** Whether the adapter advertises forking, which the list offers. */
  canFork?: boolean;
  /** The size of a sparse file put into the workspace, which nothing reads. */
  diskBytes?: number;
}

/** What the deployment answers about itself, which a test may change. */
export interface DeploymentState {
  /**
   * The Claude credential this deployment holds, by the status the settings
   * page would show for it, or null where nobody has entered one.
   *
   * With anything but `ok`, the health probe reports Claude as unable to run,
   * and the dashboard shows a warning.
   */
  claudeCredential: CredentialStatus | null;
  /** The OpenAI key, on the same terms. None unless a test gives it one. */
  openaiCredential: CredentialStatus | null;
  /**
   * The harnesses that have a catalogue for the dialogs to read. For a harness
   * without one, the dialogs offer only the choice of agent.
   */
  catalogued: HarnessId[];
  /**
   * The cookie an authenticating reverse proxy in front of the deployment
   * checks, or null for no proxy.
   *
   * A request without the cookie is redirected to a login page. Not every
   * request the page makes carries credentials.
   */
  requireCookie: string | null;
}

/** The part of a Fastify request that the hooks below read. */
interface HookRequest {
  /** The HTTP method. */
  method: string;
  /** The request URL, with its query string. */
  url: string;
  /** The request headers, by lower-case name. */
  headers: Record<string, string | string[] | undefined>;
  /** The parsed query string. */
  query: unknown;
  /** The parsed body, or a buffer for a raw upload. */
  body: unknown;
}

/** The part of a Fastify reply that the hooks below use. */
interface HookReply {
  /** Sets the status code. */
  code(status: number): HookReply;
  /** Sets one response header. */
  header(name: string, value: string): HookReply;
  /** Sets the content type. */
  type(value: string): HookReply;
  /** Sends the reply. */
  send(payload?: unknown): HookReply;
}

/** One review mutation the browser made, as the tests read them back. */
export interface ReviewCall {
  /** The mutation, such as `PUT` or `DELETE review`. */
  method: string;
  /** The box the mutation was for. */
  boxId: string;
  /** The request body, or the subject of a delete. */
  body: unknown;
}

/** An agent set a test wants to find, beside the global one. */
export interface AgentSetSpec {
  /** Named rather than generated, so a test can link straight at it. */
  id: string;
  /** The set's display name. */
  name: string;
  /** The set's AGENTS.md. Empty when absent. */
  agentsMd?: string;
  /** The skills and slash commands the set holds. */
  items?: Array<{ kind: 'skill' | 'command'; name: string; content: string }>;
}

/** A running orchestrator, with the handles a test drives it by. */
export interface TestOrchestrator {
  /** The base URL the orchestrator listens on. */
  url: string;
  /** The ACP gateway attached to the same server, on the same origin. */
  gateway: StubGateway;
  /** What the deployment reports about itself. Setting a field changes it. */
  state: DeploymentState;
  /** Files uploaded to the attachments endpoint, in order. */
  attachmentUploads: Array<{ boxId: string; name: string; bytes: Buffer }>;
  /** Every thread the browser asked for, with the body it sent. */
  threadCalls: Array<{ boxId: string; body: unknown }>;
  /** Every box the browser asked for, as the body it sent. */
  boxCalls: unknown[];
  /**
   * Every login the browser started, in order, over a runtime that runs no
   * container: what the CLI is scripted to print goes in through `print`,
   * and what the browser pasted back comes out in `input`.
   */
  logins: TestLogin[];
  /**
   * Every stop of background work the browser asked for, in order.
   *
   * `processId` is absent where the reader asked for all of a thread's work
   * rather than one command of it.
   */
  backgroundStops: Array<{ boxId: string; threadId: string; processId?: string }>;
  /** Every box-wide stop the browser asked for, by box, in order. */
  boxStops: string[];
  /** Every review mutation the browser made, in order. */
  reviewCalls: ReviewCall[];
  /** Adds a box, its directories, its threads and its container. */
  createBox(spec?: BoxSpec): void;
  /** Forgets every box, for a test that wants the deployment back. */
  resetBoxes(): void;
  /** Rebuilds a box's workspace from a fixture. */
  review(boxId: string, spec?: WorkspaceSpec): void;
  /** Writes one file of a workspace, as the agent working in it would. */
  write(boxId: string, path: string, content: string): void;
  /** Reads one file of a workspace back. */
  read(boxId: string, path: string): string;
  /** Whether the box's workspace has a REVIEW.md. */
  hasReview(boxId: string): boolean;
  /** Writes one comment through the real API, as a previous visit would have. */
  comment(boxId: string, path: string, line: number, text: string): Promise<void>;
  /** The comments on one file, as the API reports them. */
  comments(boxId: string, path: string): Promise<ReviewAnnotation[]>;
  /** What a terminal in a box answers a typed line with. */
  terminalAnswer: (line: string) => string;
  /** How many terminals the orchestrator counts as open on one box. */
  terminalsOpen(boxId: string): number;
  /** Replaces the named agent sets, and fills in the global one. */
  agentSets(global: Omit<AgentSetSpec, 'id' | 'name'>, named: AgentSetSpec[]): Promise<void>;
  /** One agent set as the API reports it, for what a test wrote through the UI. */
  agentSet(setId: string): Promise<AgentSetDetail>;
  /** The credentials the deployment holds, as the settings page sees them. */
  credentials(): Promise<CredentialSummary[]>;
  /** The deployment's plain settings, as the API reports them. */
  settings(): Promise<Settings>;
  /** Stops the server and removes everything the harness installed or created. */
  close(): Promise<void>;
}

/**
 * One login the browser started, over the stand-in runtime.
 *
 * The real runtime runs the harness's CLI in a throwaway container; this one
 * gives the test the CLI's streams instead, so a test says what the CLI
 * printed and reads what was typed into it.
 */
export interface TestLogin {
  /** The credential the login is for. */
  id: CredentialId;
  /** What the flow asked to run, which says which CLI it is driving. */
  spec: LoginExecSpec;
  /** Everything pasted back into the CLI, as the login manager wrote it. */
  input: string;
  /** Whether the flow's container was removed: a cancel, or a finished flow. */
  cancelled: boolean;
  /** Writes what the CLI printed. */
  print(text: string): void;
  /** Ends the CLI with a status, or with none where it was killed. */
  exit(code: number | null): void;
}

/**
 * A stand-in for a box's upstream connection, which in a deployment spawns an
 * ACP adapter inside the container.
 *
 * It mints thread ids on the stub gateway, so the thread a browser opens next
 * is the one the gateway holds. Its fields hold what the box list reads off a
 * live gateway.
 */
class TestUpstream {
  /** Browsers the gateway has on this box, as the list reports it. */
  attachedCount = 0;
  /** Whether the adapters advertise forking, which the list offers. */
  canFork = true;
  /** Whether anything is running in the box, or null before it was read. */
  backgroundActive: boolean | null = false;
  /** How many pieces of work are running in it, which the badge counts. */
  backgroundCount = 0;
  /** What a reading of the box found running in it, which the detail carries. */
  boxWork: BoxWork[] = [];
  /** The adapter's ids for the threads the agent is talking on. */
  speakingThreads: string[] = [];
  /** The adapter's ids for the threads with work still running. */
  workingThreads: string[] = [];

  constructor(
    private readonly boxId: string,
    private readonly db: Db,
    private readonly gateway: StubGateway,
  ) {}

  /** Nothing is held, so the housekeeping sweep may forget this. */
  get holdsNothing(): boolean {
    return true;
  }

  /** Every harness whose adapter advertised forking: both, or neither. */
  get forkableHarnesses(): Set<HarnessId> {
    return new Set<HarnessId>(this.canFork ? ['claude', 'codex'] : []);
  }

  /** Mints an empty conversation on the agent asked for. */
  async newThread(options?: ThreadOptions): Promise<ThreadRow> {
    return this.mint(this.gateway.newThread(), null, {
      harness: options?.harness ?? 'claude',
      modeId: options?.modeId ?? null,
      config: options?.config ?? {},
    });
  }

  /** Mints a conversation carrying another's history. */
  async forkThread(sourceThreadId: string): Promise<ThreadRow> {
    const source = getThread(this.db, sourceThreadId);
    if (!source?.acp_session_id) throw new Error('Thread not found');
    return this.mint(this.gateway.forkThread(source.acp_session_id), source.id, {
      harness: source.harness,
      modeId: source.mode_id,
      config: JSON.parse(source.config) as Record<string, string>,
    });
  }

  /** Nothing to spawn: the stand-in is up from the moment it exists. */
  async ensureStarted(): Promise<void> {
    return undefined;
  }

  /** Gives a thread that has a row and no conversation one, and reports its id. */
  adoptThread(row: ThreadRow): string {
    const acpSessionId = this.gateway.newThread();
    setThreadAcpId(this.db, row.id, acpSessionId);
    return acpSessionId;
  }

  /** Mints this box's first conversation and reports the adapter's id. */
  mintFirstThread(): string {
    return (
      this.mint(this.gateway.newThread(), null, { harness: 'claude', modeId: null, config: {} })
        .acp_session_id ?? ''
    );
  }

  /** Reports one process signalled, which is what the browser is told. */
  async stopBackgroundWork(): Promise<number> {
    return 1;
  }

  /** Reports one process signalled, and clears what the box has running. */
  async stopBoxWork(): Promise<number> {
    this.backgroundActive = false;
    this.boxWork = [];
    return 1;
  }

  /** Does nothing, because the stand-in spawns nothing. */
  stop(): void {
    return undefined;
  }

  /** Does nothing, like {@link stop}. */
  close(): void {
    return undefined;
  }

  /** Stores a minted conversation. */
  private mint(
    acpSessionId: string,
    inheritsFrom: string | null,
    on: { harness: HarnessId; modeId: string | null; config: Record<string, string> },
  ): ThreadRow {
    const ordinal = listThreads(this.db, this.boxId).length + 1;
    return insertThread(this.db, this.boxId, {
      id: threadName(this.boxId, ordinal),
      acpSessionId,
      ordinal,
      inheritsFrom,
      ...on,
    });
  }
}

/**
 * The manager's private map of upstream connections.
 *
 * The manager reads what a browser sees off the entry in this map, so a
 * stand-in has to be put there.
 */
function upstreamsOf(manager: BoxManager): Map<string, unknown> {
  return (manager as unknown as { upstreams: Map<string, unknown> }).upstreams;
}

/**
 * The id of a fixture thread.
 *
 * On {@link DEFAULT_BOX} it is short, so a test can write out a route to it.
 * On any other box it carries the box id, because thread ids are unique
 * across the deployment.
 */
function threadName(boxId: string, ordinal: number): string {
  return boxId === DEFAULT_BOX.id ? `th${ordinal}` : `${boxId}-th${ordinal}`;
}

/** Inserts one thread row and returns it. */
function insertThread(
  db: Db,
  boxId: string,
  thread: {
    id: string;
    acpSessionId: string;
    ordinal: number;
    harness?: HarnessId;
    modeId?: string | null;
    config?: Record<string, string>;
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
    box_id: boxId,
    harness: thread.harness ?? 'claude',
    acp_session_id: thread.acpSessionId,
    title: thread.title ?? null,
    ordinal: thread.ordinal,
    turn_active: thread.turnActive ? 1 : 0,
    inherits_from: thread.inheritsFrom ?? null,
    mode_id: thread.modeId ?? null,
    config: JSON.stringify(thread.config ?? {}),
    done: thread.done ? 1 : 0,
    created_at: now,
    last_active_at: thread.lastActiveAt ?? now,
  };
  db.prepare(
    `INSERT INTO threads (id, box_id, harness, acp_session_id, title, ordinal,
       turn_active, inherits_from, mode_id, config, done, created_at,
       last_active_at)
     VALUES (@id, @box_id, @harness, @acp_session_id, @title, @ordinal,
       @turn_active, @inherits_from, @mode_id, @config, @done, @created_at,
       @last_active_at)`,
  ).run(row);
  return row;
}

/** The stored box behind an id, or nothing where the deployment has none. */
function boxRow(db: Db, boxId: string): BoxRow | undefined {
  return db.prepare('SELECT * FROM boxes WHERE id = ?').get(boxId) as
    | BoxRow
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

/** Adds one box with its row, directories, threads, container and stand-in adapter. */
function createBox(
  app: Orchestrator,
  db: Db,
  docker: FakeDocker,
  upstreamFor: (boxId: string) => TestUpstream,
  spec: BoxSpec,
): void {
  const cfg: Config = app.cfg;
  const id = spec.id ?? DEFAULT_BOX.id;
  const now = Date.now();
  const containerId = `box-${id}`;
  const index = (db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number }).n;
  db.prepare(
    `INSERT INTO boxes (id, name, profile, image, container_id,
       network_name, subnet, review_base_rev, status, agent_set_id, ws_token,
       created_at, last_active_at)
     VALUES (?, ?, 'DEFAULT', ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    spec.name ?? DEFAULT_BOX.name,
    cfg.BOX_IMAGE,
    containerId,
    `bn-${id}`,
    `10.200.${index}.0/24`,
    spec.status ?? 'running',
    WS_TOKEN,
    now,
    now,
  );

  ws.createWorkspace(cfg.DATA_DIR, id);
  ws.createHome(cfg.DATA_DIR, id);
  ws.createNix(cfg.DATA_DIR, id);
  docker.addContainer(containerId, spec.containerRunning ?? spec.status !== 'stopped');

  const upstream = upstreamFor(id);
  upstream.canFork = spec.canFork ?? true;
  const threads = spec.threads ?? [{}];
  threads.forEach((thread, at) => {
    // The stub gateway starts with acp-thread-1 and mints the rest in order.
    const acpSessionId = `acp-thread-${at + 1}`;
    insertThread(db, id, {
      id: thread.id ?? threadName(id, at + 1),
      acpSessionId,
      ordinal: at + 1,
      harness: thread.harness ?? 'claude',
      title: thread.title ?? null,
      done: thread.done ?? false,
      turnActive: thread.turnActive ?? false,
      ...(thread.lastActiveAt === undefined ? {} : { lastActiveAt: thread.lastActiveAt }),
    });
    if (thread.backgroundBusy) upstream.workingThreads.push(acpSessionId);
    if (thread.speaking) upstream.speakingThreads.push(acpSessionId);
    for (let i = 0; i < (thread.pendingCount ?? 0); i++) {
      db.prepare(
        `INSERT INTO pending_requests (box_id, acp_session_id, method, params, created_at)
         VALUES (?, ?, 'session/request_permission', '{}', ?)`,
      ).run(id, acpSessionId, now);
    }
  });
  upstream.backgroundActive = spec.backgroundBusy ?? upstream.workingThreads.length > 0;
  upstream.boxWork = spec.boxWork ?? [];
  // A thread with work running counts as one task, as an adapter would
  // announce it. Work no thread claims is counted from the box reading.
  upstream.backgroundCount = upstream.workingThreads.length || upstream.boxWork.length;
  upstream.attachedCount = spec.attachedCount ?? 0;
  app.tunnels.setServedForTests(id, spec.tunnels ?? []);

  if (spec.diskBytes !== undefined) {
    sparseFile(join(ws.workspacePath(cfg.DATA_DIR, id), 'checkout.bin'), spec.diskBytes);
  }
}

/**
 * Lists boxes until every one that asked for a size reports one.
 *
 * The orchestrator measures disks in the background, so the first list has no
 * sizes. Waiting here means the first page a test opens shows them.
 */
async function measureBoxes(app: Orchestrator, specs: BoxSpec[]): Promise<void> {
  const wanted = specs.filter((spec) => spec.diskBytes !== undefined).length;
  if (wanted === 0) return;
  for (let attempt = 0; attempt < 200; attempt++) {
    const res = await app.app.inject({ url: '/api/boxes' });
    const listed = res.json() as BoxSummary[];
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
 * Wires the real terminal endpoint onto the harness's server.
 *
 * It runs the orchestrator's own handshake check and terminal session, over
 * the fake daemon's pty.
 */
function attachTerminalEndpoint(app: Orchestrator, db: Db): void {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(TERMINAL_SUBPROTOCOL) ? TERMINAL_SUBPROTOCOL : false,
  });
  app.app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const path = /^\/ws\/boxes\/([^/]+)\/terminal$/.exec(url);
    if (!path) return;
    const boxId = path[1]!;
    const token = boxRow(db, boxId)?.ws_token ?? null;
    if (!checkUpgrade(req.headers['sec-websocket-protocol'], token, TERMINAL_SUBPROTOCOL).ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, boxId, app.manager));
  });
}

/**
 * Adds hooks that stand in for an authenticating proxy and record what the
 * browser asked for.
 *
 * Every request the proxy lets through still reaches the real handler.
 */
function installHooks(
  app: Orchestrator,
  state: DeploymentState,
  calls: Pick<
    TestOrchestrator,
    | 'attachmentUploads'
    | 'backgroundStops'
    | 'boxStops'
    | 'reviewCalls'
    | 'threadCalls'
    | 'boxCalls'
  >,
): void {
  app.app.addHook('onRequest', async (req: HookRequest, reply: HookReply) => {
    if (!state.requireCookie) return;
    if ((req.headers.cookie ?? '').includes(`${state.requireCookie}=`)) return;
    // As oauth2-proxy, Authelia and Caddy forward_auth do: redirect to a login
    // page that answers 200.
    if ((req.url.split('?')[0] ?? '') === '/login') {
      return reply.type('text/html; charset=utf-8').send('<!doctype html><title>Sign in</title>');
    }
    return reply.code(302).header('Location', '/login').send();
  });

  app.app.addHook('preHandler', async (req: HookRequest) => {
    if (req.headers[SETUP_HEADER] !== undefined) return;
    const path = req.url.split('?')[0] ?? '';
    const body = req.body as Record<string, unknown> | Buffer | undefined;

    if (path === '/api/boxes' && req.method === 'POST') {
      calls.boxCalls.push(body ?? null);
      return;
    }
    const thread = /^\/api\/boxes\/([^/]+)\/threads$/.exec(path);
    if (thread && req.method === 'POST') {
      calls.threadCalls.push({ boxId: thread[1]!, body: body ?? null });
      return;
    }

    const attachment = /^\/api\/boxes\/([^/]+)\/attachments$/.exec(path);
    if (attachment && req.method === 'POST' && Buffer.isBuffer(body)) {
      calls.attachmentUploads.push({
        boxId: attachment[1]!,
        name: String((req.query as { name?: string }).name ?? ''),
        bytes: body,
      });
      return;
    }

    const boxStop = /^\/api\/boxes\/([^/]+)\/background\/stop$/.exec(path);
    if (boxStop && req.method === 'POST') {
      calls.boxStops.push(boxStop[1]!);
      return;
    }

    const stop = /^\/api\/boxes\/([^/]+)\/threads\/([^/]+)\/background\/stop$/.exec(path);
    if (stop && req.method === 'POST') {
      const asked = (body as Record<string, unknown> | undefined)?.['processId'];
      calls.backgroundStops.push({
        boxId: stop[1]!,
        threadId: stop[2]!,
        ...(asked === undefined ? {} : { processId: String(asked) }),
      });
      return;
    }

    const review = /^\/api\/boxes\/([^/]+)\/review(?:\/(dir|file|annotations|base))?$/.exec(
      path,
    );
    const named = review ? reviewCallOf(req.method, review[2] ?? '') : null;
    if (review && named) {
      // A delete carries its subject in the query.
      calls.reviewCalls.push({
        method: named,
        boxId: review[1]!,
        body: req.method === 'DELETE' ? deleteSubject(req.query) : (body ?? null),
      });
    }
  });
}

/**
 * Stands in for the containers a login runs in, and returns the logins started.
 *
 * Each start adds one entry. The test prints the CLI's output through it and
 * ends it with a status. A `cat` of the file Codex wrote answers with
 * {@link LOGIN_DOCUMENT}, so a finished Codex login stores an account.
 */
function installLoginRuntime(app: Orchestrator): TestLogin[] {
  const logins: TestLogin[] = [];
  const byContainer = new Map<string, TestLogin>();
  app.logins.setRuntimeForTests({
    start: async (id) => {
      const containerId = `login-${logins.length + 1}`;
      const output = new PassThrough();
      let exit: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => {
        exit = resolve;
      });
      const login: TestLogin & { output: PassThrough; exited: Promise<number | null> } = {
        id,
        spec: { cmd: [] },
        input: '',
        cancelled: false,
        output,
        exited,
        print: (text) => output.write(text),
        exit: (code) => {
          output.end();
          exit(code);
        },
      };
      logins.push(login);
      byContainer.set(containerId, login);
      return containerId;
    },
    exec: async (containerId, spec) => {
      const login = byContainer.get(containerId) as
        | (TestLogin & { output: PassThrough; exited: Promise<number | null> })
        | undefined;
      if (!login) throw new Error(`no login container ${containerId}`);
      if (spec.cmd[0] === 'cat') {
        // What the Codex CLI left behind, read back once it has exited.
        const output = new PassThrough();
        output.end(LOGIN_DOCUMENT);
        return { output, stdin: null, exited: Promise.resolve(0), kill: () => undefined };
      }
      login.spec = spec;
      const stdin = spec.tty ? new PassThrough() : null;
      stdin?.on('data', (chunk: Buffer) => {
        login.input += chunk.toString('utf8');
      });
      return {
        output: login.output,
        stdin,
        exited: login.exited,
        kill: () => login.exit(null),
      };
    },
    remove: async (containerId) => {
      const login = byContainer.get(containerId);
      if (login) login.cancelled = true;
    },
  });
  return logins;
}

/** What a review delete names, taken off the query it travels in. */
function deleteSubject(query: unknown): unknown {
  const { path, line } = query as { path?: string; line?: string };
  if (path === undefined) return null;
  return { path, line: Number(line) };
}

/**
 * Starts the real orchestrator on an ephemeral port, with the boxes given.
 *
 * Only the Docker daemon, git inside a container and the agent are stand-ins.
 * `gatewayScript` sets what the stub gateway answers prompts with, which
 * modes it advertises and what it asks permission for.
 */
export async function startOrchestrator(
  boxes: BoxSpec[] = [{}],
  gatewayScript: Partial<GatewayScript> = {},
): Promise<TestOrchestrator> {
  const dataDir = mkdtempSync(join(tmpdir(), 'boxes-e2e-'));
  // The orchestrator logs every response at info level.
  setLogLevel('error');
  const cfg = loadConfig({
    ...process.env,
    DATA_DIR: dataDir,
    // This process's own ids, so every chown is a no-op.
    BOX_UID: String(process.getuid?.() ?? 1020),
    BOX_GID: String(process.getgid?.() ?? 1020),
  });
  setConfigForTests(cfg);

  const docker = installFakeDocker(cfg.BOX_IMAGE, FAKE_SELF_CONTAINER);
  const db = openDb(dataDir);
  // The bundle this run just built, rather than the copy a built image holds.
  const app = buildApp(cfg, db, { bundleDir: resolve(import.meta.dirname, '../dist') });
  installLocalGit((boxId) => ws.workspacePath(dataDir, boxId));

  /** The stand-in adapter for a box, made on first use and put in the manager's map. */
  const upstreamFor = (boxId: string): TestUpstream => {
    const held = upstreamsOf(app.manager).get(boxId);
    if (held) return held as TestUpstream;
    const made = new TestUpstream(boxId, db, gateway);
    upstreamsOf(app.manager).set(boxId, made);
    return made;
  };

  /** Puts a credential in the store at a status, or takes it out. */
  const holdCredential = (
    id: 'claude' | 'openai',
    method: 'token' | 'api_key',
    secret: string,
    status: CredentialStatus | null,
  ): void => {
    // Credentials live only in the real store, as if entered on the settings page.
    if (status === null) {
      app.credentials.remove(id);
      return;
    }
    app.credentials.put(id, method, secret);
    if (status !== 'ok') app.credentials.markStatus(id, status, null);
  };
  let catalogued: HarnessId[] = [];
  const state: DeploymentState = {
    get claudeCredential() {
      return app.credentials.get('claude')?.status ?? null;
    },
    set claudeCredential(status: CredentialStatus | null) {
      holdCredential('claude', 'token', CLAUDE_TOKEN, status);
    },
    get openaiCredential() {
      return app.credentials.get('openai')?.status ?? null;
    },
    set openaiCredential(status: CredentialStatus | null) {
      holdCredential('openai', 'api_key', OPENAI_KEY, status);
    },
    get catalogued() {
      return catalogued;
    },
    set catalogued(harnesses: HarnessId[]) {
      catalogued = harnesses;
      db.prepare('DELETE FROM harness_catalog').run();
      for (const id of harnesses) {
        upsertHarnessCatalog(db, id, CATALOG[id].modes, CATALOG[id].configOptions);
      }
    },
    requireCookie: null,
  };
  const calls = {
    attachmentUploads: [] as TestOrchestrator['attachmentUploads'],
    threadCalls: [] as TestOrchestrator['threadCalls'],
    boxCalls: [] as TestOrchestrator['boxCalls'],
    backgroundStops: [] as TestOrchestrator['backgroundStops'],
    boxStops: [] as TestOrchestrator['boxStops'],
    reviewCalls: [] as ReviewCall[],
  };

  // Same origin as the dashboard, as in a deployment, so the browser derives
  // the WebSocket URL from its own location.
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
      token: (boxId) => boxRow(db, boxId)?.ws_token ?? null,
      thread: (boxId, threadId) => {
        const row = threadId ? getThread(db, threadId) : latestThread(db, boxId);
        if (row) {
          if (row.box_id !== boxId) return null;
          // A fixture thread may have no conversation yet. The real gateway
          // mints one when a browser pins to it, and so does the stand-in.
          return row.acp_session_id ?? upstreamFor(boxId).adoptThread(row);
        }
        if (threadId !== null) return null;
        // A box with no threads gets its first one here, as the real gateway does.
        if (!boxRow(db, boxId)) return null;
        return upstreamFor(boxId).mintFirstThread();
      },
    },
  );

  // The orchestrator's entry point wires the upgrade in a deployment.
  attachTerminalEndpoint(app, db);

  installHooks(app, state, calls);
  const logins = installLoginRuntime(app);

  // As at boot: creating a box fails until the egress policy exists.
  await app.egress.prepare();
  // A working deployment: a credential for each agent, and Claude's catalogue.
  state.claudeCredential = 'ok';
  state.openaiCredential = 'ok';
  state.catalogued = ['claude'];

  await app.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.app.server.address() as AddressInfo;

  /** Sends a request as the harness, which the recorded calls leave out. */
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

  const workspaceOf = (boxId: string): string => ws.workspacePath(dataDir, boxId);

  const harness: TestOrchestrator = {
    url: `http://127.0.0.1:${port}`,
    gateway,
    state,
    ...calls,
    terminalsOpen: (boxId) => app.manager.terminalCount(boxId),
    get terminalAnswer() {
      return docker.terminalAnswer;
    },
    set terminalAnswer(fn: TestOrchestrator['terminalAnswer']) {
      docker.terminalAnswer = fn;
    },
    createBox: (spec = {}) => createBox(app, db, docker, upstreamFor, spec),
    resetBoxes: () => {
      const rows = db.prepare('SELECT id FROM boxes').all() as Array<{ id: string }>;
      for (const row of rows) {
        ws.removeWorkspace(dataDir, row.id);
        ws.removeHome(dataDir, row.id);
        upstreamsOf(app.manager).delete(row.id);
      }
      db.prepare('DELETE FROM threads').run();
      db.prepare('DELETE FROM pending_requests').run();
      db.prepare('DELETE FROM boxes').run();
    },
    review: (boxId, spec = reviewWorkspace()) => buildWorkspace(workspaceOf(boxId), spec),
    write: (boxId, path, content) => writeFile(workspaceOf(boxId), path, content),
    read: (boxId, path) => readFileSync(join(workspaceOf(boxId), path), 'utf8'),
    hasReview: (boxId) => existsSync(join(workspaceOf(boxId), 'REVIEW.md')),
    comment: async (boxId, path, line, text) => {
      await setup('PUT', `/api/boxes/${boxId}/review/annotations`, {
        path,
        line,
        comment: text,
      });
    },
    comments: async (boxId, path) => {
      const res = await setup(
        'GET',
        `/api/boxes/${boxId}/review/file?path=${encodeURIComponent(path)}`,
      );
      return (res.json() as ReviewFileResponse).annotations;
    },
    agentSet: async (setId) => {
      const res = await setup('GET', `/api/agent-sets/${setId}`);
      return res.json() as AgentSetDetail;
    },
    credentials: async () => (await setup('GET', '/api/credentials')).json() as CredentialSummary[],
    settings: async () => (await setup('GET', '/api/settings')).json() as Settings,
    logins,
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

  for (const spec of boxes) harness.createBox(spec);
  await measureBoxes(app, boxes);
  return harness;
}
