import { client as acpClient, type ClientConnection } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { PassThrough, Readable } from 'node:stream';
import {
  getThread,
  insertThread,
  setThreadAcpId,
  setThreadConfig,
  threadByAcpId,
  threadConfig,
  upsertHarnessCatalog,
  type Db,
  type ThreadRow,
} from '../db.ts';
import * as dk from '../docker.ts';
import { HARNESS_IDS, type Harness, type HarnessId } from '../harness.ts';
import type { Logger } from '../log.ts';
import { ACP_METHOD } from '../../../shared/acp.ts';
import type {
  BackgroundProcess,
  SessionConfigOption,
  SessionModeState,
} from '../../../shared/types.ts';
import { TaskBoard } from './background.ts';
import { threadOf } from './broadcast.ts';

/**
 * One adapter process of one session: the exec, the ACP handshake, and the
 * conversations that process is holding.
 *
 * A session owns one of these per harness a thread of it runs, spawned when a
 * thread of that harness first needs it — a box with only Claude threads never
 * starts `codex-acp`. Everything here is about the *process*: it dies with the
 * exec and is rebuilt by the next message that needs it, and it knows nothing
 * about browsers, permissions or what the box is running. Those belong to the
 * session, in `upstream.ts`, which owns these connections and routes to them.
 *
 * The split is what makes two adapters in one box possible at all. Each holds
 * its own `live` set, its own replay counter, its own cached `initialize` and
 * its own board of running tasks, so a load on one harness does not mask live
 * activity on the other and an adapter that dies takes only its own threads —
 * and only its own tasks — down with it.
 */

/** Pass-through parser, leaving params and their _meta untouched. */
const raw = <T = unknown>(params: unknown): T => params as T;

/**
 * Update kinds this SDK's schema does not know, and which have to be taken off
 * the stream before it sees them. See {@link AdapterConnection.siftExtensions}.
 */
const EXTENSION_UPDATE = /^async_task_/;

/** How often a failed adapter spawn is retried before the session errors. */
const MAX_SPAWN_ATTEMPTS = 3;

/** Wait before each retry, in milliseconds. */
const SPAWN_BACKOFF_MS = [1000, 3000, 8000];

/** JSON-RPC code the ACP SDK uses for a resource that does not exist. */
const RESOURCE_NOT_FOUND = -32002;

/** JSON-RPC code an adapter refusing an unauthenticated session call uses. */
const AUTH_REQUIRED = -32000;

/**
 * How far a borrowed replay follows the chain of forks back. A fork of a fork
 * inherits through the middle thread, and the bound is what stops a row that
 * somehow points at itself from spinning.
 */
const MAX_INHERIT_HOPS = 32;

/**
 * What Boxes advertises about itself at `initialize`.
 *
 * One extension, under the namespace both adapters read it from: without it
 * neither ever sends an async-task update, so a backgrounded command is
 * invisible to the client that did not ask. Nothing else — no filesystem, no
 * terminal, no elicitation — which confines adapter-to-client traffic to
 * `session/update`, `session/request_permission` and the task updates.
 */
const CLIENT_CAPABILITIES = {
  _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
} as const;

/** A thread id that names none of the session's threads; the API turns this into a 404. */
export const THREAD_NOT_FOUND = 'Thread not found';

/** True when the adapter reported a missing thread rather than a failure. */
export function isResourceNotFound(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === RESOURCE_NOT_FOUND;
}

/**
 * True when the adapter refused because it has no account.
 *
 * Matched on both halves, because -32000 is the generic server error and only
 * the message says what this one is. Codex's adapter checks authorization on
 * every session call and logs itself in from the environment first, so this is
 * what a box holding a placeholder for a credential nobody has entered answers
 * with.
 */
export function isAuthRequired(err: unknown): boolean {
  const error = err as { code?: number; message?: unknown } | null;
  return (
    error?.code === AUTH_REQUIRED &&
    typeof error.message === 'string' &&
    error.message.startsWith('Authentication required')
  );
}

/**
 * The value to select for a wanted model: the name itself when the adapter
 * offers it, else a bracketed variant of it such as `opus[1m]`, which is the
 * same model with a different context window. A name that merely starts the
 * same way, such as `opusplan`, is a different model and never matches.
 */
export function pickModel(
  options: ReadonlyArray<{ value: string }>,
  wanted: string,
): string | null {
  if (options.some((option) => option.value === wanted)) return wanted;
  return options.find((option) => option.value.startsWith(`${wanted}[`))?.value ?? null;
}

/**
 * The nearest thread whose transcript a fork can borrow, or null when there is
 * none to ask.
 *
 * A fork of a fork inherits through the middle one: that thread has no
 * transcript either, so following the chain is what makes the second branch
 * show the conversation both of them came from.
 */
export function inheritedSource(
  db: Db,
  sessionId: string,
  thread: ThreadRow,
): ThreadRow | null {
  let row: ThreadRow | undefined = thread;
  for (let hop = 0; hop < MAX_INHERIT_HOPS; hop++) {
    const next: string | null = row?.inherits_from ?? null;
    if (!next) return null;
    row = getThread(db, next);
    if (!row || row.session_id !== sessionId) return null;
    if (row.acp_session_id && !row.inherits_from) return row;
  }
  return null;
}

/**
 * What a connection needs from the session that owns it.
 *
 * Everything here is session-level state an adapter process has no business
 * holding: the container every connection shares, who is watching what, and
 * where an update goes once it has arrived.
 */
export interface AdapterHost {
  readonly sessionId: string;
  readonly db: Db;
  /**
   * Starts the box and attaches the egress proxy, answering with the container
   * to exec into. Shared by every connection through one promise, so two
   * adapters starting at once start one container.
   */
  ensureContainer(): Promise<string>;
  /** The session's current thread, or null before it has one. */
  currentThread(): ThreadRow | null;
  /** Every conversation a browser is watching, by the adapter's own id. */
  watchedThreads(): readonly string[];
  /**
   * An adapter update, and whether it is a replay: a transcript arriving in a
   * burst is history rather than the agent talking.
   */
  onUpdate(harness: HarnessId, params: unknown, replaying: boolean): void;
  /** A permission request, which blocks the adapter until it is answered. */
  onPermission(params: unknown): Promise<unknown>;
  /**
   * This connection's conversations are gone with its process: their turns are
   * over, and the browsers on them have to be told.
   */
  onThreadsLost(acpThreadIds: readonly string[]): void;
  /** Closes the browsers pinned to one conversation, so each reconnects. */
  dropWatchers(acpThreadId: string): void;
  /** The connection is up and carrying threads. */
  onUp(): void;
  /** It is up and working, or it failed every attempt and the session is in error. */
  onStatus(status: 'running' | 'error'): void;
}

/** The orchestrator's ACP connection to one harness's adapter in one box. */
export class AdapterConnection {
  private exec: dk.AdapterExec | null = null;
  private conn: ClientConnection | null = null;
  private initializeResponse: unknown = null;
  private starting: Promise<void> | null = null;
  /** Guards against reconnect storms after a deliberate stop. */
  private stopping = false;
  /**
   * Loads in flight on *this* adapter, per thread, which is what says an
   * update is history. Per thread because a replay is about one conversation:
   * a turn starting on a second thread while this one rebuilds is the agent
   * talking, and has to be seen as such.
   */
  private readonly replaying = new Map<string, number>();
  /**
   * The conversations this adapter process has been made to hold: every one it
   * has minted, and every one it has loaded back.
   *
   * A stored ACP id says a thread had a conversation once, not that the adapter
   * running now knows about it. Only this says that, which is what lets a pin
   * tell a thread it has to bring up from one that is already up. Emptied with
   * the connection, because a fresh adapter holds nothing.
   */
  private readonly live = new Set<string>();
  /**
   * What each config option the adapter has mentioned is for, by its own id.
   *
   * Kept because a `session/set_config_option` passing through the gateway
   * names an option and a value and nothing else, and whether that option is
   * the one echoing the mode decides whether it is recorded at all.
   */
  private readonly categories = new Map<string, string | null>();
  /**
   * What this adapter process has told Boxes it is running in the background.
   *
   * On the connection rather than on the session, because a task is a fact
   * about one process: the id a stop names is this adapter's, the request goes
   * back down this connection, and a process that dies takes every task it
   * announced with it. Nothing re-announces them on the respawn, which is the
   * case the box reading in `background.ts` exists for.
   */
  private readonly tasks = new TaskBoard();
  /** Whether the missing credential has already been said once. */
  private unauthenticated = false;

  constructor(
    readonly harness: Harness,
    private readonly host: AdapterHost,
    /** Tagged with the session and this harness, since a box may run two. */
    private readonly slog: Logger,
  ) {}

  /** Whether the adapter process is up. */
  get isConnected(): boolean {
    return this.conn !== null;
  }

  /** The initialize response to hand browsers, cached verbatim. */
  get cachedInitialize(): unknown {
    return this.initializeResponse;
  }

  /**
   * Whether this connection is holding nothing: no process, no start in
   * flight. What lets the session forget an upstream it built only to answer
   * a question about a box.
   */
  get holdsNothing(): boolean {
    return this.conn === null && this.exec === null && this.starting === null;
  }

  /**
   * Whether this adapter advertised the fork capability. It is unstable in the
   * ACP schema, so an adapter that does not offer it — or one that has not been
   * reached yet — is reported as not forkable rather than assumed.
   */
  get canFork(): boolean {
    // ACP spells a supported capability as an object, `{}` included, and an
    // unsupported one as absent or null.
    const fork = (
      this.initializeResponse as {
        agentCapabilities?: { sessionCapabilities?: { fork?: unknown } | null } | null;
      } | null
    )?.agentCapabilities?.sessionCapabilities?.fork;
    return fork !== undefined && fork !== null;
  }

  /** Whether this process is holding one conversation right now. */
  holds(acpThreadId: string): boolean {
    return this.live.has(acpThreadId);
  }

  /** Every conversation this process is holding. */
  get liveThreads(): string[] {
    return [...this.live];
  }

  // --- background work -------------------------------------------------------

  /**
   * Reads one update for what it says about a task this adapter is running,
   * and answers whether the thread's bar has changed.
   *
   * Replays are not excluded. Neither adapter re-announces the tasks of a
   * process that has died, so a replay carries none of these in practice — and
   * if one ever did, a task the adapter is telling us about again is a task it
   * is still running, which is exactly what a bar should show.
   */
  noteTask(acpThreadId: string, update: unknown): boolean {
    return this.tasks.note(acpThreadId, update);
  }

  /** What one conversation of this adapter has running. */
  tasksFor(acpThreadId: string): BackgroundProcess[] {
    return this.tasks.for(acpThreadId);
  }

  /** The conversations of this adapter with something running in them. */
  get taskThreads(): string[] {
    return this.tasks.threads;
  }

  /** Whether this adapter has any task running at all. */
  get hasTasks(): boolean {
    return this.tasks.any;
  }

  /**
   * Stops one task of a conversation, or every task it has, and answers how
   * many the adapter said it stopped.
   *
   * A kill rather than a cancel, and the adapter's own kill: `session/cancel`
   * is the composer's button and it is right for a turn, but a backgrounded
   * command outlives the turn that started it by design and no interrupt
   * reaches it. `_session/async_task/stop` names the task itself.
   *
   * `stopped: false` means the task was already over — the answer to a bar
   * showing something that has finished, not a failure — so the entry goes
   * either way and the caller re-sends the thread's state. A request that
   * *failed* is different: nothing is known about the task, and dropping it
   * would take a running build off the bar.
   */
  async stopTasks(acpThreadId: string, taskId?: string): Promise<number> {
    const wanted = taskId ? [taskId] : this.tasks.for(acpThreadId).map((task) => task.id);
    let stopped = 0;
    for (const id of wanted) {
      try {
        const answer = (await this.request('_session/async_task/stop', {
          sessionId: acpThreadId,
          asyncTaskId: id,
        })) as { stopped?: unknown } | null;
        if (answer?.stopped === true) stopped += 1;
        else this.slog.info('the task was already over', { acpThreadId, asyncTaskId: id });
        this.tasks.drop(acpThreadId, id);
      } catch (err) {
        this.slog.warn('could not stop a task', {
          acpThreadId,
          asyncTaskId: id,
          error: (err as Error).message,
        });
      }
    }
    return stopped;
  }

  /**
   * Brings up the container, the exec and the ACP handshake. Concurrent callers
   * share one attempt.
   *
   * The guard is the cached initialize response, not the connection: the
   * connection exists from the moment the exec stream is wired up, but its
   * handshake takes a few hundred milliseconds, and a browser arriving inside
   * that window has to wait for the handshake.
   */
  async ensureStarted(): Promise<void> {
    if (this.conn && this.initializeResponse) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** Spawns the adapter and brings back its threads, retrying with a backoff. */
  private async start(): Promise<void> {
    this.stopping = false;
    const containerId = await this.host.ensureContainer();
    // A repair that replaces the container stops this session's upstream,
    // which is this one. Said again, so the flag it set cannot make the spawn
    // below ignore its own exec exiting.
    this.stopping = false;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      if (this.stopping) return;
      if (attempt > 0) {
        const wait = SPAWN_BACKOFF_MS[attempt - 1] ?? 8000;
        this.slog.warn('retrying adapter spawn', { attempt, waitMs: wait });
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        await this.spawnAndInitialize(containerId);
      } catch (err) {
        lastError = err;
        this.slog.error('adapter spawn failed', { attempt, error: (err as Error).message });
        this.teardownConnection();
        continue;
      }
      try {
        await this.loadThreads();
      } catch (err) {
        // An adapter with no account to run under is a configuration problem
        // rather than a spawn failure: retrying cannot fix it, tearing the
        // connection down would only spawn it again, and the session is not in
        // error — it is waiting for somebody to enter a credential. The next
        // request on this connection fails with the adapter's own message,
        // which is what the browser shows.
        if (isAuthRequired(err)) {
          this.noteAuthRequired(err);
          this.host.onUp();
          return;
        }
        lastError = err;
        this.slog.error('adapter could not bring its threads back', {
          attempt,
          error: (err as Error).message,
        });
        this.teardownConnection();
        continue;
      }
      // The stop arrived while this was coming up, so what it brought up
      // goes with it: the session was asked to be down, and the exec left
      // behind would answer for a box nobody is holding.
      if (this.stopping) {
        this.teardownConnection();
        return;
      }
      this.host.onStatus('running');
      // A browser that stayed attached through a stop and start is still
      // watching, and the clock its bar goes away on was cleared with the
      // connection.
      this.host.onUp();
      return;
    }
    // A spawn retries for twelve seconds, which is long enough for the
    // session to be stopped under it. What it would report then is about a
    // box that is already down, so it gives up quietly instead.
    if (this.stopping) return;
    // Only the session that needed *this* adapter is in error. A box whose
    // other connection is serving threads perfectly well is not.
    this.host.onStatus('error');
    throw new Error(
      `${this.harness.label} adapter failed to start after ${MAX_SPAWN_ATTEMPTS} attempts: ` +
        `${(lastError as Error)?.message}`,
    );
  }

  /** Spawns the adapter exec and performs the ACP handshake. */
  private async spawnAndInitialize(containerId: string): Promise<void> {
    const exec = await dk.spawnAdapterExec(
      containerId,
      [...this.harness.cmd],
      dk.WORKSPACE_DIR,
    );
    this.exec = exec;

    // stderr is log-only: the adapter sends its console logging there to keep
    // stdout clean for protocol.
    exec.stderr.setEncoding('utf8');
    exec.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.slog.debug('adapter stderr', { line: line.slice(0, 2000) });
      }
    });

    // Only while this is still the connection's exec: one that was torn down
    // and replaced reports its exit late, and acting on it would take the
    // successor with it.
    void exec.exited.then((code) => {
      if (this.exec === exec) this.handleExecExit(code);
    });

    const stream = this.makeStream(exec);
    const app = acpClient({ name: `boxes-${this.host.sessionId}` })
      .onNotification(ACP_METHOD.sessionUpdate as string, raw, ({ params }) => {
        this.host.onUpdate(this.harness.id, params, this.isReplaying(params));
      })
      .onRequest(ACP_METHOD.sessionRequestPermission as string, raw, ({ params }) =>
        this.host.onPermission(params),
      );

    const conn = app.connect(stream);
    this.conn = conn;

    this.initializeResponse = await conn.agent.request(ACP_METHOD.initialize, {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    this.slog.info('adapter initialized', { workingDir: dk.WORKSPACE_DIR });
  }

  /**
   * Brings back every conversation of this harness that this connection has to
   * carry: the session's current thread when it is one of ours, and each
   * thread of ours a browser is watching.
   *
   * With two tabs on two threads, a respawn that loaded only the current one
   * would leave the other browser's next prompt naming a thread the adapter has
   * never heard of. The set is derived from the attached handles, so it needs no
   * storage and shrinks as tabs close.
   */
  private async loadThreads(): Promise<void> {
    // The current thread first, because it is the one a session with no threads
    // at all has to be given. A current thread of the *other* harness is that
    // connection's to bring up, not this one's.
    const current = this.host.currentThread();
    if (!current) {
      await this.mintFirstThread();
    } else if (current.harness === this.harness.id) {
      const replayed = current.acp_session_id ? await this.loadSession(current) : false;
      if (!replayed) await this.mintInto(current.id);
    }

    for (const acpThreadId of this.host.watchedThreads()) {
      // What this adapter already holds: the current thread above, and a
      // thread a second tab is watching as well.
      if (this.live.has(acpThreadId)) continue;
      const row = threadByAcpId(this.host.db, this.host.sessionId, this.harness.id, acpThreadId);
      // Another harness's conversation is that connection's to bring up.
      if (!row && this.heldElsewhere(acpThreadId)) continue;
      // No row under that id at all — the thread it named was re-minted, and
      // the browsers on it are pinned to the id it lost.
      try {
        if (row?.acp_session_id && (await this.loadSession(row))) continue;
      } catch (err) {
        if (isAuthRequired(err)) throw err;
        // A fault on a thread that is merely being watched must not cost the
        // session its spawn; the browsers on it reconnect and resolve again.
        this.slog.warn('could not reload a watched thread', {
          threadId: row?.id ?? null,
          error: (err as Error).message,
        });
      }
      // Its id is dead, so the browsers pinned to it are holding one the
      // adapter will reject. Closing their sockets is the repair: each
      // reconnects, and its handshake pins whatever the thread is now.
      this.host.dropWatchers(acpThreadId);
    }
  }

  /** Whether a conversation id belongs to a thread of some other harness. */
  private heldElsewhere(acpThreadId: string): boolean {
    return HARNESS_IDS.some(
      (id) =>
        id !== this.harness.id &&
        threadByAcpId(this.host.db, this.host.sessionId, id, acpThreadId) !== undefined,
    );
  }

  /**
   * Gives a session with no conversation at all its first one, on this harness.
   *
   * Only a session created before a thread was made with it — every box now
   * gets its first thread row when it is created, from what the dialog chose,
   * and that row is brought up like any other.
   */
  private async mintFirstThread(): Promise<void> {
    const acpSessionId = await this.mintAcpThread(null, this.harness.defaultModeId, {
      ...this.harness.defaultConfig,
    });
    const created = insertThread(this.host.db, this.host.sessionId, {
      harness: this.harness.id,
      acpSessionId,
    });
    this.slog.info('first thread recorded', { threadId: created.id });
  }

  /**
   * Makes this adapter hold one of the session's threads: its stored
   * conversation when the adapter still has the transcript for it, a fresh one
   * when it does not.
   *
   * A thread minted, never prompted, and left behind by an adapter restart is
   * the second case — the agent SDK writes no transcript until a prompt has run
   * — and it has nothing to lose, so a fresh conversation in its row is the
   * whole repair.
   */
  async bringUp(threadId: string): Promise<string> {
    await this.ensureStarted();
    // Read after the spawn, not before: an adapter coming up brings back the
    // session's current thread and every watched one, so this may be a thread
    // that is already here — and loading it again would replay the whole
    // conversation a second time to whoever is watching.
    const row = getThread(this.host.db, threadId);
    if (!row) throw new Error(THREAD_NOT_FOUND);
    if (row.acp_session_id && this.live.has(row.acp_session_id)) return row.acp_session_id;
    if (row.acp_session_id && (await this.loadSession(row))) return row.acp_session_id;
    return this.mintInto(threadId);
  }

  /**
   * Mints a fresh adapter conversation and records it against a thread row.
   *
   * A fork that has not been prompted yet is branched again rather than started
   * empty: it exists to carry the source's context, and an adapter restart is
   * not the user changing their mind about that. When the source cannot be
   * branched either — the same restart may have left it with a conversation of
   * its own to lose — the thread is started empty, because a thread with
   * nothing to pin is worse than one with nothing to say.
   */
  async mintInto(threadId: string): Promise<string> {
    const row = getThread(this.host.db, threadId);
    const source = row ? inheritedSource(this.host.db, this.host.sessionId, row) : null;
    // What the row remembers beats where a thread of its kind starts: a fork
    // the user has since flipped to auto is not put back in plan by an adapter
    // restart.
    const modeId =
      row?.mode_id ?? (source ? this.harness.forkModeId : this.harness.defaultModeId);
    const config = row ? threadConfig(row) : { ...this.harness.defaultConfig };
    let branched: string | null = null;
    if (source?.acp_session_id) {
      try {
        branched = await this.mintAcpThread(source.acp_session_id, modeId, config);
      } catch (err) {
        if (isAuthRequired(err)) throw err;
        this.slog.warn('could not branch a fork again; starting it empty', {
          threadId,
          from: source.id,
          error: (err as Error).message,
        });
      }
    }
    const acpSessionId = branched ?? (await this.mintAcpThread(null, modeId, config));
    setThreadAcpId(this.host.db, threadId, acpSessionId);
    this.slog.info('thread had no adapter conversation; minted one', {
      threadId,
      acpSessionId,
      forkedFrom: branched ? source?.id : null,
    });
    return acpSessionId;
  }

  /**
   * Mints an ACP thread and gives it the mode and settings it is meant to have.
   *
   * `from` forks that thread's context instead of starting empty. Both answers
   * carry `modes` and `configOptions`, so the same two steps apply either way.
   */
  async mintAcpThread(
    from: string | null,
    modeId: string,
    config: Record<string, string>,
  ): Promise<string> {
    const method = from ? ACP_METHOD.sessionFork : ACP_METHOD.sessionNew;
    const res = (await this.request(method, {
      ...(from ? { sessionId: from } : {}),
      cwd: dk.WORKSPACE_DIR,
      mcpServers: [],
      ...this.meta(),
    })) as {
      sessionId?: string;
      modes?: SessionModeState | null;
      configOptions?: SessionConfigOption[] | null;
    };
    if (!res?.sessionId) throw new Error(`${method} returned no sessionId`);
    this.live.add(res.sessionId);
    this.noteCatalog(res);
    this.slog.info('acp session created', { method, acpSessionId: res.sessionId, from });
    await this.applyMode(res.sessionId, res.modes ?? null, modeId);
    await this.applyConfig(res.sessionId, res.configOptions ?? null, config);
    return res.sessionId;
  }

  /**
   * Replays a stored thread. Returns false when the adapter no longer holds it,
   * which tells the caller to start a fresh one.
   *
   * A missing thread is a legitimate state: the agent SDK writes a transcript
   * only once a prompt has run, so an id minted by session/new and never
   * prompted does not survive the container stopping. Any other error is
   * rethrown, which keeps a transient fault from discarding a live thread.
   *
   * Both adapters stream a load's whole conversation back as `session/update`
   * notifications, so one path serves either. What only a box can show is that
   * a Codex rollout survives its container being stopped and started, which is
   * what makes this return true rather than mint a fresh thread. PLAN.md
   * section 3, verify step 6.
   */
  private async loadSession(thread: ThreadRow): Promise<boolean> {
    const acpSessionId = thread.acp_session_id!;
    try {
      // The same `_meta` a fresh thread gets: a load is where the adapter
      // rebuilds the query for a conversation it no longer holds, which is the
      // other place these options are read.
      const res = (await this.whileReplaying(acpSessionId, () =>
        this.request(ACP_METHOD.sessionLoad, {
          sessionId: acpSessionId,
          cwd: dk.WORKSPACE_DIR,
          mcpServers: [],
          ...this.meta(),
        }),
      )) as {
        modes?: SessionModeState | null;
        configOptions?: SessionConfigOption[] | null;
      } | null;
      this.live.add(acpSessionId);
      this.noteCatalog(res ?? {});
      this.slog.info('acp session loaded', { threadId: thread.id, acpSessionId });
      // A load brings the conversation back and nothing else: the mode and the
      // settings were the old process's, and this one starts in its own. Both
      // are put back from the row, which is why the row has them.
      await this.applyMode(
        acpSessionId,
        res?.modes ?? null,
        thread.mode_id ?? this.harness.defaultModeId,
      );
      await this.applyConfig(acpSessionId, res?.configOptions ?? null, threadConfig(thread));
      return true;
    } catch (err) {
      if (!isResourceNotFound(err)) throw err;
      this.live.delete(acpSessionId);
      this.slog.warn('stored thread is gone; starting a fresh one', {
        threadId: thread.id,
        acpSessionId,
        error: (err as Error).message,
      });
      // Only this thread's row loses its adapter id. The session's other
      // threads have transcripts of their own and are untouched.
      setThreadAcpId(this.host.db, thread.id, null);
      return false;
    }
  }

  /**
   * Puts a thread in the mode it is meant to be in: the one recorded for it, or
   * its harness's default when nothing is.
   *
   * Called on a thread the adapter has just minted and on one it has just
   * loaded back, because both arrive in whatever mode the adapter starts in. A
   * mode is the user's choice, and the thread's row is where that choice
   * outlives the process that was holding it.
   *
   * An adapter that does not offer the mode is left alone rather than argued
   * with, and so is one already in it.
   */
  async applyMode(
    acpSessionId: string,
    modes: SessionModeState | null,
    modeId: string,
  ): Promise<void> {
    if (!modes?.availableModes?.some((mode) => mode.id === modeId)) return;
    if (modes.currentModeId === modeId) return;
    try {
      await this.request(ACP_METHOD.sessionSetMode, { sessionId: acpSessionId, modeId });
      this.slog.info('thread put in its mode', { acpSessionId, modeId });
    } catch (err) {
      // A thread in the adapter's own mode is still usable, so this never fails
      // the spawn.
      this.slog.warn('could not set the mode', { error: (err as Error).message });
    }
  }

  /**
   * Puts a thread back on everything it was configured with, on the same terms
   * as {@link applyMode}: one `set_config_option` per entry the adapter offers
   * whose current value differs.
   *
   * The option whose category is `mode` is passed over on every path. Both
   * adapters echo the mode as a config option, and the mode travels through
   * `session/set_mode` and the row's own column — a thread put into its mode by
   * two mechanisms is how the two answers come apart.
   *
   * A model the adapter no longer offers falls back to the harness's default
   * through {@link pickModel}, since model ids come and go; every other option
   * is sent as it was recorded, and a value the adapter rejects is logged
   * rather than fatal, because the adapter's own answer corrects the dashboard.
   */
  async applyConfig(
    acpSessionId: string,
    configOptions: SessionConfigOption[] | null,
    config: Record<string, string>,
  ): Promise<void> {
    if (!configOptions) return;
    for (const option of configOptions) {
      if (option.category === 'mode') continue;
      const value = this.wantedValue(option, config[option.id]);
      if (value === null || value === option.currentValue) continue;
      try {
        await this.request(ACP_METHOD.sessionSetConfigOption, {
          sessionId: acpSessionId,
          configId: option.id,
          value,
        });
        this.slog.info('thread put back on a setting', {
          acpSessionId,
          configId: option.id,
          value,
        });
      } catch (err) {
        this.slog.warn('could not set a thread setting', {
          configId: option.id,
          value,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * What one option should be set to, or null to leave the adapter's own
   * answer alone.
   *
   * The model is the one option with a fallback, because it is the one the
   * deployment has an opinion about and the one whose ids move: a thread that
   * recorded nothing still comes back on the harness's default model, and one
   * that recorded a model this adapter no longer lists comes back on a variant
   * of it or on that default. Everything else is either recorded or not.
   */
  private wantedValue(option: SessionConfigOption, recorded: string | undefined): string | null {
    if (option.category !== 'model') return recorded ?? null;
    const offered = option.options ?? [];
    const fallback = this.harness.defaultConfig[option.id];
    return (
      (recorded ? pickModel(offered, recorded) : null) ??
      (fallback ? pickModel(offered, fallback) : null)
    );
  }

  /**
   * Records what the adapter says a thread is configured with, merged over what
   * the row holds.
   *
   * Called with the answer to a `session/set_config_option` passing through the
   * gateway and with a `config_option_update` arriving on its own, because both
   * adapters answer a change with their whole list and change things by
   * themselves as well — a slash command, an accepted plan, a model swapped
   * under load. A thread should come back configured as it ended up rather than
   * as it was last asked to be.
   *
   * Merged rather than replaced, because an answer that omits an option says
   * nothing about it, and the mode's own option is dropped here as everywhere.
   */
  recordConfigOptions(acpSessionId: string, configOptions: SessionConfigOption[]): void {
    const row = this.rowOf(acpSessionId);
    if (!row) return;
    const config = threadConfig(row);
    let changed = false;
    for (const option of configOptions) {
      if (typeof option?.id !== 'string') continue;
      this.categories.set(option.id, option.category ?? null);
      if (option.category === 'mode') continue;
      if (typeof option.currentValue !== 'string') continue;
      if (config[option.id] === option.currentValue) continue;
      config[option.id] = option.currentValue;
      changed = true;
    }
    if (changed) setThreadConfig(this.host.db, row.id, config);
  }

  /**
   * Records one option from the request that set it, for an adapter that
   * answers a `session/set_config_option` with nothing.
   *
   * The answer is the record that matters — it carries the whole list, and the
   * value the adapter settled on rather than the one it was asked for — so this
   * is the fallback. An option this connection has seen categorised as the mode
   * is not recorded, on the rule that holds everywhere else.
   */
  recordConfigValue(acpSessionId: string, configId: string, value: string): void {
    if (this.categories.get(configId) === 'mode') return;
    const row = this.rowOf(acpSessionId);
    if (!row) return;
    const config = threadConfig(row);
    if (config[configId] === value) return;
    config[configId] = value;
    setThreadConfig(this.host.db, row.id, config);
  }

  /** One of this harness's threads, by the adapter's own id for it. */
  rowOf(acpSessionId: string): ThreadRow | undefined {
    return threadByAcpId(this.host.db, this.host.sessionId, this.harness.id, acpSessionId);
  }

  /**
   * Sends a request to the adapter, naming the missing credential when it
   * refuses for want of one.
   *
   * Every call this connection makes goes through here, including the ones the
   * gateway is forwarding for a browser, so the log says which credential is
   * missing once rather than on every request — and the browser's own request
   * fails with the adapter's message, which is the sentence worth showing.
   */
  async request(method: string, params: unknown): Promise<unknown> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.harness.label} adapter is not connected`);
    try {
      const result = await conn.agent.request(method, params);
      this.unauthenticated = false;
      return result;
    } catch (err) {
      if (isAuthRequired(err)) this.noteAuthRequired(err);
      throw err;
    }
  }

  /** Sends a notification to the adapter. */
  async notify(method: string, params: unknown): Promise<void> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.harness.label} adapter is not connected`);
    await conn.agent.notify(method, params);
  }

  /**
   * Runs a `session/load` with that thread's replay marked as history rather
   * than news.
   *
   * Every load re-sends a conversation as ordinary notifications, which is what
   * makes replay and live streaming the same code path everywhere else — and
   * the one place that difference matters is background work, where a five-hour
   * old tool call is not evidence of anything running now.
   *
   * Counted per thread and per connection: a turn starting on a second thread
   * while this one rebuilds is the agent talking, and a load on one harness
   * says nothing about the other's. `acpThreadId` is the id the updates being
   * replayed carry, which for a borrowed replay is the source's own.
   */
  async whileReplaying<T>(acpThreadId: string, load: () => Promise<T>): Promise<T> {
    this.replaying.set(acpThreadId, (this.replaying.get(acpThreadId) ?? 0) + 1);
    try {
      return await load();
    } finally {
      const left = (this.replaying.get(acpThreadId) ?? 1) - 1;
      if (left > 0) this.replaying.set(acpThreadId, left);
      else this.replaying.delete(acpThreadId);
    }
  }

  /** Whether an update is a thread's own transcript being read back. */
  private isReplaying(params: unknown): boolean {
    const thread = threadOf(params);
    return thread !== undefined && this.replaying.has(thread);
  }

  /** Says once that this adapter has no account to run under. */
  private noteAuthRequired(err: unknown): void {
    if (this.unauthenticated) return;
    this.unauthenticated = true;
    this.slog.warn('the adapter has no credential to run under', {
      credential: this.harness.credentialId,
      error: (err as Error).message,
    });
  }

  /**
   * The `_meta` this harness's calls carry, or nothing when it wants none.
   *
   * Only Claude asks for anything: its adapter reads
   * `_meta.claudeCode.options` and lays it over the options it hands the Agent
   * SDK. Codex reads none, and sending it something it does not know would be
   * noise on the wire.
   */
  meta(): { _meta?: Record<string, unknown> } {
    return this.harness.sessionMeta ? { _meta: { ...this.harness.sessionMeta } } : {};
  }

  /** Caches what this answer advertised, for a dialog with no adapter to ask. */
  private noteCatalog(res: {
    modes?: SessionModeState | null;
    configOptions?: SessionConfigOption[] | null;
  }): void {
    if (!res.modes && !res.configOptions) return;
    for (const option of res.configOptions ?? []) {
      if (typeof option?.id === 'string') this.categories.set(option.id, option.category ?? null);
    }
    try {
      upsertHarnessCatalog(this.host.db, this.harness.id, res.modes, res.configOptions);
    } catch (err) {
      this.slog.debug('harness catalogue write failed', { error: (err as Error).message });
    }
  }

  /**
   * Lifts the async-task extension's notifications off the stream before the
   * SDK parses it, and delivers them by the path the SDK would have used.
   *
   * The SDK's client installs a session-update router ahead of every handler an
   * app registers, and that router parses each `session/update` against the
   * schema it was generated from — a strict union of the update kinds that
   * existed when it was generated. An update outside it throws there, and a
   * handler that throws takes the whole message with it: nothing else sees the
   * frame, however raw a parser the app asked for. The async-task extension is
   * by construction outside any generated schema, so every frame this milestone
   * rests on would be logged as invalid params and dropped.
   *
   * So the bytes are read one step earlier. Everything downstream is unchanged
   * — the update is tapped, its thread is touched, the browsers watching are
   * sent it, and the task board reads it — and only the route differs. What it
   * costs is strict ordering against the frames still going through the SDK's
   * own parsing: a bar may appear a beat before the tool call it belongs to,
   * which is a level rather than a sequence and reads the same either way.
   */
  private siftExtensions(stdout: Readable): Readable {
    const passed = new PassThrough();
    let buffer = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let full = true;
      let cut = buffer.indexOf('\n');
      while (cut !== -1) {
        const line = buffer.slice(0, cut + 1);
        buffer = buffer.slice(cut + 1);
        if (!this.consumeExtension(line)) full = passed.write(line) && full;
        cut = buffer.indexOf('\n');
      }
      // A reader that has fallen behind — a replay of a long conversation
      // arriving faster than it is parsed — stops the adapter rather than
      // being buffered without limit here.
      if (!full) {
        stdout.pause();
        passed.once('drain', () => stdout.resume());
      }
    });
    // A half-written line at the end is the adapter dying mid-frame. It goes on
    // as it is, because the SDK's own parser is where a broken frame belongs.
    stdout.on('end', () => {
      if (buffer) passed.write(buffer);
      passed.end();
    });
    stdout.on('error', (err: Error) => passed.destroy(err));
    return passed;
  }

  /**
   * Delivers one line if it is an extension notification, and answers whether
   * it was one.
   *
   * Anything else — a response, a request, an update the SDK knows, a line
   * that is not JSON at all — is left for the stream it came off.
   */
  private consumeExtension(line: string): boolean {
    if (!line.includes('async_task_')) return false;
    let message: {
      id?: unknown;
      method?: unknown;
      params?: { update?: { sessionUpdate?: unknown } };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return false;
    }
    if (message.id !== undefined || message.method !== ACP_METHOD.sessionUpdate) return false;
    const kind = message.params?.update?.sessionUpdate;
    if (typeof kind !== 'string' || !EXTENSION_UPDATE.test(kind)) return false;
    this.host.onUpdate(this.harness.id, message.params, this.isReplaying(message.params));
    return true;
  }

  /** ACP Stream over the demuxed exec: ndJSON in, ndJSON out. */
  private makeStream(exec: dk.AdapterExec): Stream {
    const readable = Readable.toWeb(
      this.siftExtensions(exec.stdout),
    ) as ReadableStream<Uint8Array>;
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          exec.stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
        }),
      close: () => {
        exec.stdin.end();
      },
    });
    return ndJsonStream(writable, readable);
  }

  /**
   * Drops the connection when the adapter exits on its own. The next message
   * for one of its threads calls ensureStarted, which re-spawns and re-issues
   * session/load.
   *
   * Only this harness's threads are affected. The other adapter is a separate
   * process with separate conversations, and it goes on serving them.
   */
  private handleExecExit(code: number | null): void {
    if (this.stopping) return;
    this.slog.warn('adapter exec exited', { code });
    // Every conversation this process held, and every one it had told us about
    // a task on — the two are the same set in practice, and the union is what
    // makes the bars go away even if they ever come apart.
    const lost = new Set([...this.live, ...this.tasks.threads]);
    this.teardownConnection();
    this.host.onThreadsLost([...lost]);
  }

  /** Closes the connection and kills the exec, tolerating either being gone. */
  teardownConnection(): void {
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    this.conn = null;
    this.initializeResponse = null;
    // A fresh adapter holds none of them, so the next pin brings its thread
    // back up rather than trusting an id this process never heard.
    this.live.clear();
    // The loads counted here belong to the connection going away. A count
    // left behind reads as a replay that never ends, and everything its
    // thread says afterwards is taken for history: no agent speaking, no
    // turn settling, and a row that is never touched again.
    this.replaying.clear();
    // And it knows nothing about what the old one had running: neither adapter
    // re-announces a dead process's tasks. What that process left running in
    // the box is the reading's to find and the session-level stop's to kill.
    this.tasks.clear();
    try {
      this.exec?.kill();
    } catch {
      // already gone
    }
    this.exec = null;
  }

  /**
   * Stops this adapter deliberately, which suppresses the reconnect.
   *
   * The session tells the browsers itself: a deliberate stop is the whole box
   * going down, not one process of it, so there is nothing to report back
   * about the threads this one was holding.
   */
  stop(): void {
    this.stopping = true;
    this.teardownConnection();
  }
}
