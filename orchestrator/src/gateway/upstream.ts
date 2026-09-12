import type { Config } from '../config.ts';
import {
  appendAcpLog,
  clearSessionTurns,
  clearThreadInheritance,
  currentThread,
  getThread,
  insertThread,
  pruneAcpLog,
  setThreadMode,
  setThreadTitle,
  setThreadTurnActive,
  threadByAcpId,
  threadConfig,
  touchSession,
  touchThread,
  type Db,
  type SessionRow,
  type ThreadRow,
} from '../db.ts';
import * as dk from '../docker.ts';
import { DEFAULT_HARNESS, harness, HARNESS_IDS, type HarnessId } from '../harness.ts';
import { log, type Logger } from '../log.ts';
import type { NotifyKind, Notifier } from '../notify.ts';
import { Activity } from './activity.ts';
import { AdapterConnection, inheritedSource, type AdapterHost } from './adapter.ts';
import { BackgroundProbe, workToStop } from './background.ts';
import { Broadcast, threadOf } from './broadcast.ts';
import type { PendingStore } from './pending.ts';
import type {
  SessionConfigOption,
  ThreadOptions,
  TurnStateParams,
} from '../../../shared/types.ts';

/**
 * Everything about one session that is not one adapter process: the browsers
 * attached to it, what is running in its box, which conversation each message
 * is about, and the container all of that happens in.
 *
 * `SessionManager` creates one of these per session on first use and keeps it
 * for the process's life. It owns one {@link AdapterConnection} per harness a
 * thread of the session runs, started when a thread of that harness first needs
 * one, and routes every message to the connection whose adapter holds the
 * conversation it names. A box with only Claude threads never starts a second
 * adapter; a box with both has two processes over one checkout, and an adapter
 * that dies takes down only its own conversations.
 *
 * The orchestrator owns the connections, not a browser, so a turn runs to
 * completion whoever is watching. Each browser connection is pinned to a single
 * thread, chosen at the handshake, so two tabs can watch two conversations of
 * one box at once — and the session's `current_thread_id` is the default a
 * connection that names none gets rather than the truth about what any browser
 * has loaded.
 */

/**
 * A JSON.stringify replacer that keeps base64 media out of the debug log.
 *
 * An image or audio block carries its whole payload inline, and a screenshot
 * is a megabyte of base64 against a log that truncates at 64,000 characters.
 * The mime type and the size are what a tapped log is read for.
 *
 * Keyed on the holder rather than the key name, which is why this is a
 * `function` and not an arrow: `data` is also where a terminal's output
 * lives, and that is exactly what somebody reading this log came for.
 */
function withoutMediaPayloads(this: unknown, key: string, value: unknown): unknown {
  if (key !== 'data' || typeof value !== 'string') return value;
  const type = (this as { type?: unknown })?.type;
  if (type !== 'image' && type !== 'audio') return value;
  return `[${value.length} base64 chars omitted]`;
}

/** A browser attached to this session, as seen from the upstream side. */
export interface DownstreamHandle {
  readonly id: number;
  /**
   * The ACP thread this connection is for, resolved once at attach and fixed
   * from then on. Null only in the window before the resolution finishes, in
   * which case the connection is counted as attached but nothing is routed
   * to it — it has not asked for anything yet either.
   */
  acpThreadId: string | null;
  /** Bumped whenever this browser sends something; picks the permission target. */
  lastActiveAt: number;
  /** Sends a notification to this browser. */
  notify(method: string, params: unknown): void;
  /** Sends a request to this browser and awaits its answer. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Closes this browser's socket, which makes it reconnect from scratch. */
  close(): void;
}

/**
 * How long work gets to stop politely before it is killed.
 *
 * Long enough for a shell to run a trap and a build to put its files down;
 * short enough that a person who pressed stop sees it stop.
 */
const TERM_GRACE_MS = 2_000;

/** Why a thread cannot be forked yet; the API turns this into a 409. */
export const NOTHING_TO_FORK = 'That thread has nothing to fork from yet';

/**
 * The block of text a prompt's attachments are named in. The dashboard writes
 * it for the model rather than the user typing it, so it is not something to
 * name a thread after.
 */
const ATTACHMENTS_OPEN = '<attachments>';

/**
 * How much of a prompt a name may be taken from. Long enough for a sentence,
 * and short enough to stay a name rather than the message it came out of.
 */
const MAX_PROMPT_NAME_LENGTH = 120;

/**
 * What to call a thread from a prompt sent on it, or null when the prompt has
 * nothing to take a name from.
 *
 * The first line of what the user typed, which is where a person puts what
 * they want. The attachments block is passed over: it is the same text in
 * every prompt carrying a file, and would name every such thread alike.
 */
function nameFromPrompt(params: unknown): string | null {
  const blocks = (params as { prompt?: unknown } | null)?.prompt;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as Array<{ type?: unknown; text?: unknown } | null>) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.startsWith(ATTACHMENTS_OPEN)) continue;
    const line = block.text.split('\n').find((candidate) => candidate.trim() !== '');
    if (line === undefined) continue;
    const name = line.trim().replace(/\s+/g, ' ');
    if (name.length <= MAX_PROMPT_NAME_LENGTH) return name;
    return `${name.slice(0, MAX_PROMPT_NAME_LENGTH - 1)}…`;
  }
  return null;
}

/** The orchestrator's own ACP connections to one session's adapters. */
export class UpstreamSession implements AdapterHost {
  /** One adapter process per harness a thread of this session runs. */
  private readonly connections = new Map<HarnessId, AdapterConnection>();
  /** The container start, shared by every connection that wants one. */
  private containerStarting: Promise<string> | null = null;
  /** Who each adapter update goes to. */
  private readonly downstreams: Broadcast;
  /** Whether this session still has work running in it. */
  private readonly background: BackgroundProbe;
  /** Whether the agent is talking on each thread. */
  private readonly activity: Activity;
  private readonly slog: Logger;
  /** Threads being brought up, so concurrent pins share one; see below. */
  private readonly resolving = new Map<string, Promise<string>>();
  /** The reading's own timer while a browser is watching; see pollWhileWatched. */
  private polling: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly sessionId: string,
    readonly db: Db,
    private readonly cfg: Config,
    private readonly pending: PendingStore,
    private readonly notifier: Notifier,
    private readonly onStatusChange: (status: SessionRow['status']) => void,
    /**
     * Run, and awaited, just before the container is started: it writes out
     * this session's agent configuration and rebuilds the container if Docker
     * no longer has it.
     *
     * Opening a thread on a stopped box is the other way a container starts,
     * so neither repair can live only in `SessionManager.start`. The
     * entrypoint installs whatever is on disk at that moment, so the
     * configuration has to be current here too — and a box something pruned
     * has to be made again here too, or opening a thread on one is a 404 from
     * the daemon with nothing to do about it.
     *
     * It may therefore change the session's container id, which is why the
     * row is read again below rather than before.
     */
    private readonly beforeStart: () => Promise<void>,
  ) {
    this.slog = log.session(sessionId);
    this.downstreams = new Broadcast(sessionId, (thread) => this.threadState(thread));
    this.background = new BackgroundProbe({
      list: () => this.containerProcesses(),
      // One token, still: the reading is per adapter process and a box may now
      // hold two. Milestone 4 replaces it with one answer about the whole box
      // that knows every harness's token; until then a box is read as the
      // Claude box every existing one is.
      adapter: harness(DEFAULT_HARNESS).processToken,
      ttlMs: cfg.BACKGROUND_POLL_SECONDS * 1_000,
      // A probe that cannot read its box holds whatever it last believed, and
      // what it last believed holds the reaper off. Silence here is a session
      // that never stops for a reason nobody can see.
      onTrouble: (error) =>
        error
          ? this.slog.warn('cannot read what is running in the box', {
              error: error.message,
            })
          : this.slog.info('reading what is running in the box again'),
      // Nothing reports a build finishing, so a reading is the only news
      // there is: a bar above a composer appears and goes away because this
      // said so.
      onChange: (threads) => {
        for (const thread of threads) this.downstreams.threadState(thread);
      },
      // And a box that says it is busy while every one of its threads says it
      // is not looks exactly like a bug from the outside. It is a real state,
      // and this is the only place its reason can be found.
      onUnexplained: (why) =>
        why
          ? this.slog.warn('the box is busy with work no conversation claims', { why })
          : this.slog.info('what is running in the box is accounted for again'),
    });
    this.activity = new Activity({
      quietMs: cfg.AGENT_QUIET_SECONDS * 1000,
      settleMs: cfg.AGENT_SETTLE_SECONDS * 1000,
      // Every transition reaches the browsers watching that conversation, so
      // the composer stops offering a stop button the moment the agent stops
      // needing one.
      onChange: (thread) => this.downstreams.threadState(thread),
      // And a turn that has been over for a while, with nobody there to have
      // seen it end, is worth a notification. Same gate as everything else
      // here: only when that thread has no browser on it.
      onSettled: (thread) => {
        if (this.downstreams.byRecency(thread).length === 0) this.announce('idle', thread);
      },
    });
  }

  // --- the connections ------------------------------------------------------

  /**
   * The connection for one harness, created on first use.
   *
   * Creating one costs nothing and starts nothing: the adapter process is
   * spawned by `ensureStarted`, which is what a thread of that harness needing
   * it calls.
   */
  private connection(id: HarnessId): AdapterConnection {
    let conn = this.connections.get(id);
    if (!conn) {
      conn = new AdapterConnection(
        harness(id),
        this,
        log.tagged({ session: this.sessionId, harness: id }),
      );
      this.connections.set(id, conn);
    }
    return conn;
  }

  /**
   * Starts the adapter a session needs by default: the one its current thread
   * runs on, or Claude's before it has a thread at all.
   *
   * Every other path names the harness it wants — a pin resolves the thread
   * first, a forwarded message is routed by the conversation it is about — and
   * this is what a caller with nothing to go on gets.
   */
  async ensureStarted(harnessId?: HarnessId): Promise<void> {
    await this.connection(harnessId ?? this.defaultHarness()).ensureStarted();
  }

  /** The harness of the session's current thread, or the registry's default. */
  private defaultHarness(): HarnessId {
    return this.current?.harness ?? DEFAULT_HARNESS;
  }

  /**
   * Whether threads of one harness can be forked, which is what that adapter's
   * `initialize` advertised.
   *
   * Per harness because the answer is per adapter: two adapters in one box
   * answer this separately, and an adapter that has not been reached is
   * reported as not forkable rather than assumed.
   */
  canFork(harnessId: HarnessId): boolean {
    return this.connections.get(harnessId)?.canFork ?? false;
  }

  /** The harnesses whose adapters have advertised the fork capability. */
  get forkableHarnesses(): Set<HarnessId> {
    const forkable = new Set<HarnessId>();
    for (const [id, conn] of this.connections) if (conn.canFork) forkable.add(id);
    return forkable;
  }

  /**
   * The initialize response to hand a browser: the one cached by the adapter
   * holding the thread that browser is pinned to.
   *
   * The two adapters advertise different things — different modes, different
   * session capabilities — so answering with either would tell half the
   * browsers something untrue about the conversation they are watching.
   */
  initializeFor(acpThreadId: string): unknown {
    const conn = this.connectionHolding(acpThreadId);
    return conn?.cachedInitialize ?? null;
  }

  /** The connection whose adapter is holding one conversation, if any is. */
  private connectionHolding(acpThreadId: string): AdapterConnection | null {
    for (const conn of this.connections.values()) {
      if (conn.holds(acpThreadId)) return conn;
    }
    return null;
  }

  /**
   * One of this session's threads by the adapter's own id for it, whichever
   * harness it belongs to.
   *
   * The lookup takes the harness, and here it is not known: an update has come
   * off a connection that knows it, but a timer in `Activity` or a queued
   * permission request has only the id. Both adapters mint UUIDs, so asking
   * each harness in turn finds the one row there is.
   */
  private rowOfAcp(acpThreadId: string): ThreadRow | undefined {
    for (const id of HARNESS_IDS) {
      const row = threadByAcpId(this.db, this.sessionId, id, acpThreadId);
      if (row) return row;
    }
    return undefined;
  }

  /**
   * The connection a forwarded message belongs on: the one holding the
   * conversation it names, else the one for that conversation's stored
   * harness, else the browser's own thread, else the session's default.
   *
   * A message about a thread has to reach the adapter that has that thread —
   * routing it to the other one would be a session id the adapter has never
   * heard of — and a message about nothing in particular (`authenticate`,
   * `session/list`) belongs to whoever asked.
   */
  private connectionFor(params: unknown, from?: DownstreamHandle): AdapterConnection {
    const acpThreadId = threadOf(params) ?? from?.acpThreadId ?? null;
    if (acpThreadId) {
      const holding = this.connectionHolding(acpThreadId);
      if (holding) return holding;
      const row = this.rowOfAcp(acpThreadId);
      if (row) return this.connection(row.harness);
    }
    return this.connection(this.defaultHarness());
  }

  // --- what the connections ask of the session -------------------------------

  /**
   * Starts the box once, however many adapters want it.
   *
   * Two connections coming up together must not race over the container, and a
   * later one must still start a box that has been stopped since — so the
   * promise is shared while it is in flight and dropped when it settles.
   */
  ensureContainer(): Promise<string> {
    if (!this.containerStarting) {
      this.containerStarting = this.startContainer().finally(() => {
        this.containerStarting = null;
      });
    }
    return this.containerStarting;
  }

  /** Brings the box up and makes sure the egress proxy is on its network. */
  private async startContainer(): Promise<string> {
    if (!this.row().container_id) throw new Error('Session has no container');

    // Awaited, and the row read after it: this may have rebuilt the container
    // the row named, and the id to start is the one it left behind.
    await this.beforeStart();
    const row = this.row();
    if (!row.container_id) throw new Error('Session has no container');

    await dk.startContainer(row.container_id);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    return row.container_id;
  }

  /** Every conversation a browser is watching, for a connection coming back up. */
  watchedThreads(): readonly string[] {
    return this.downstreams.watchedThreads;
  }

  /** A connection is up and serving, so the reading's own clock runs again. */
  onUp(): void {
    this.pollWhileWatched();
  }

  /** A connection's outcome, which is the session's status. */
  onStatus(status: 'running' | 'error'): void {
    this.onStatusChange(status);
  }

  /**
   * Forgets what one adapter's conversations were in the middle of, leaving
   * every other conversation of the box alone.
   *
   * Both facts together, and the browsers told afterwards rather than between,
   * so a state published halfway through cannot claim a turn on a thread that
   * has just been cleared. What was running in the background needs no
   * forgetting: it is read from the container rather than remembered, and an
   * adapter that has gone took its children with it.
   */
  onThreadsLost(acpThreadIds: readonly string[]): void {
    for (const acpThreadId of acpThreadIds) {
      setThreadTurnActive(this.db, this.sessionId, acpThreadId, false);
      this.activity.reset(acpThreadId);
    }
    this.downstreams.refreshThreadStates();
  }

  // --- the box ---------------------------------------------------------------

  /** How many browsers are attached to this session. */
  get attachedCount(): number {
    return this.downstreams.size;
  }

  /**
   * Whether this session has work running in the background, which holds the
   * idle reaper off the way an attached browser or a running turn does.
   */
  get backgroundActive(): boolean {
    return this.background.active;
  }

  /** Test seam: takes a reading now rather than when one goes stale. */
  refreshBackgroundForTests(): Promise<void> {
    return this.background.refresh();
  }

  /**
   * Keeps the reading current while a browser is watching, and stops when the
   * last one leaves.
   *
   * A reading answers two questions on two clocks. The reaper's is answered
   * by asking when it sweeps, which is where the lazy refresh behind `active`
   * is enough. A person looking at a thread is the other: nothing reports a
   * build finishing, so the bar above their composer goes away only when a
   * reading notices.
   *
   * Only while watched, because an unwatched box is read once a minute by the
   * reaper.
   */
  private pollWhileWatched(): void {
    if (this.polling || this.downstreams.size === 0) return;
    this.polling = setInterval(
      () => void this.background.refresh(),
      this.cfg.BACKGROUND_POLL_SECONDS * 1_000,
    );
    this.polling.unref?.();
    // And once now: a browser that has just arrived is the most likely to be
    // shown a reading taken before whatever it came back to look at.
    void this.background.refresh();
  }

  /** Stops the reading's own clock. The lazy refresh behind `active` remains. */
  private stopPolling(): void {
    if (!this.polling) return;
    clearInterval(this.polling);
    this.polling = null;
  }

  /**
   * Stops what a conversation left running in its box: one process tree, or
   * everything that thread has running.
   *
   * A kill rather than a cancel. `session/cancel` is what the composer's stop
   * button sends and it is right for a turn — the adapter interrupts the
   * query and tears down the subagents it was holding open for. It does
   * nothing to a shell, which is the whole point of a background command: it
   * is a child of the CLI process that outlives the turn that started it, so
   * no interrupt reaches it.
   *
   * The pids are read from inside the container at this moment and used
   * immediately, because they are the box's own numbering and because a
   * process that ended in between should not be found. TERM first, and
   * whatever is still there after a moment is sent KILL — the
   * escalation is not waited for, so the answer here is about what was
   * signalled rather than what has already died.
   *
   * @returns How many processes were signalled. Zero is a normal answer: the
   *   work ended between the reading a browser is showing and this call.
   */
  async stopBackgroundWork(acpThreadId: string, id?: string): Promise<number> {
    const containerId = this.row().container_id;
    if (!containerId) return 0;
    if ((await dk.containerState(containerId)) !== 'running') return 0;

    const doomed = workToStop(
      await dk.containerProcessesFromInside(containerId),
      this.adapterToken(acpThreadId),
      acpThreadId,
      id,
    );
    if (doomed.length === 0) {
      // Nothing to kill is still news: what the browser is showing is a
      // reading that has been overtaken, and a fresh one puts it right.
      void this.background.refresh();
      return 0;
    }

    this.slog.info('stopping background work', { acpThreadId, id: id ?? null, pids: doomed });
    await dk.killInContainer(containerId, 'TERM', doomed);
    // No reading here: a process signalled a millisecond ago is very likely
    // still in the table, and a reading that says so would put the bar back
    // for a poll's length. The escalation takes one when it settles, which
    // is the first moment the answer can be true either way.
    this.escalate(containerId, acpThreadId, id);
    return doomed.length;
  }

  /**
   * The adapter token a reading of one thread's work is taken against: the
   * process token of the harness that thread runs.
   *
   * Per thread rather than per box, because two adapters may be in the table
   * and work under one of them is not work under the other. The whole reading
   * becomes box-wide at milestone 4; this is the half that can already be
   * asked about one conversation.
   */
  private adapterToken(acpThreadId?: string): string {
    const row = acpThreadId ? this.rowOfAcp(acpThreadId) : undefined;
    return harness(row?.harness ?? this.defaultHarness()).processToken;
  }

  /**
   * KILLs whatever a TERM did not stop, a moment later.
   *
   * Detached from the request, which has been answered: a stop is judged by
   * the next reading, not by this. What it re-reads is the same question
   * rather than the same pids: a pid that has gone is no longer this thread's
   * work, and one that has not is what was asked to stop.
   */
  private escalate(containerId: string, acpThreadId: string, id?: string): void {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const left = workToStop(
            await dk.containerProcessesFromInside(containerId),
            this.adapterToken(acpThreadId),
            acpThreadId,
            id,
          );
          if (left.length === 0) return;
          this.slog.info('background work ignored TERM; killing', { acpThreadId, pids: left });
          await dk.killInContainer(containerId, 'KILL', left);
        } catch (err) {
          this.slog.warn('could not finish stopping background work', {
            error: (err as Error).message,
          });
        } finally {
          void this.background.refresh();
        }
      })();
    }, TERM_GRACE_MS);
    timer.unref?.();
  }

  /**
   * What is running in this session's container, for the probe.
   *
   * A session with no container, or one that is not up, has nothing running
   * in it. That is null rather than an empty table: an empty table is what a
   * box that could not be read looks like, which counts as busy, and a
   * stopped session was answering "still running" forever because of it.
   */
  private async containerProcesses(): Promise<dk.ContainerProcess[] | null> {
    const containerId = this.row().container_id;
    if (!containerId) return null;
    if ((await dk.containerState(containerId)) !== 'running') return null;
    return dk.containerProcesses(containerId);
  }

  /** The threads of this session the agent is talking on. */
  get speakingThreads(): string[] {
    return this.activity.speakingThreads;
  }

  /** The threads of this session with work still running in them. */
  get workingThreads(): string[] {
    return this.background.workingThreads;
  }

  /**
   * Everything a browser is told about a thread: whether a prompt of its own
   * is open, whether the agent is talking, and what it has left running.
   *
   * The three are gathered here because this is the only object that has all
   * three, and they are sent together because a reader's question — is this
   * thread waiting for me? — is answered by all three at once.
   */
  threadState(acpThreadId: string): TurnStateParams {
    return {
      sessionId: acpThreadId,
      active: this.downstreams.isPrompting(acpThreadId),
      speaking: this.activity.speaking(acpThreadId),
      background: this.background.work(acpThreadId),
    };
  }

  // --- browsers --------------------------------------------------------------

  /**
   * Adds a browser to the broadcast set. It counts as attached from here —
   * it is holding a socket open, which is what the reaper cares about — but
   * receives nothing until `pin` has settled which thread it is watching.
   */
  attach(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
    this.pollWhileWatched();
    this.slog.info('downstream attached', { attached: this.downstreams.size });
  }

  /**
   * Settles which of the session's conversations a connection is for, and
   * answers with the adapter's own id for it.
   *
   * `threadId` names one of the session's threads, or is null for a
   * connection that named none, as an external ACP client does, which gets
   * the session's current one.
   *
   * The thread's own harness decides which adapter has to be up: a thread
   * minted and never prompted has no adapter-side conversation until one is
   * made, and pinning a connection to an id no adapter holds would leave every
   * prompt on it failing.
   */
  async pin(handle: DownstreamHandle, threadId: string | null): Promise<string> {
    const acpThreadId = await this.resolveThread(threadId);
    handle.acpThreadId = acpThreadId;
    this.slog.info('downstream pinned to a thread', { handle: handle.id, acpThreadId });
    return acpThreadId;
  }

  /**
   * The live adapter id for one of the session's threads, bringing the thread
   * up first when its adapter is not already holding it.
   *
   * The spawn path brings back the session's current thread and the ones
   * browsers were already watching, which is every thread it can know about.
   * Opening any other one lands here, and is loaded on the same terms as at
   * spawn, so the connection is never pinned to a conversation the adapter
   * has never heard of.
   */
  private async resolveThread(threadId: string | null): Promise<string> {
    let row = threadId ? getThread(this.db, threadId) : this.current;
    if (!row && !threadId) {
      // A session with no thread at all: its first one is minted by the
      // default adapter coming up, which is the one path that creates a row
      // rather than bringing one up.
      await this.ensureStarted();
      row = this.current;
    }
    if (!row || row.session_id !== this.sessionId) throw new Error('Thread not found');
    const conn = this.connection(row.harness);
    if (row.acp_session_id && conn.holds(row.acp_session_id)) return row.acp_session_id;
    // Two tabs opening the same thread at once share one bring-up, so the
    // second neither replays it twice nor overwrites the first's id in the
    // row.
    const inFlight = this.resolving.get(row.id);
    if (inFlight) return inFlight;
    const attempt = conn.bringUp(row.id).finally(() => this.resolving.delete(row.id));
    this.resolving.set(row.id, attempt);
    return attempt;
  }

  /** Removes a browser from the broadcast set, leaving the upstream running. */
  detach(handle: DownstreamHandle): void {
    this.downstreams.remove(handle);
    if (this.downstreams.size === 0) this.stopPolling();
    this.slog.info('downstream detached', { attached: this.downstreams.size });
  }

  /**
   * Closes the sockets of the browsers watching one thread, so each
   * reconnects from scratch and pins whatever that thread is now.
   *
   * The only caller is the respawn path, for a thread whose adapter id did
   * not survive. A connection is pinned to its own thread, so neither
   * switching the session's default nor adding a thread drops a browser.
   */
  dropWatchers(acpThreadId: string): void {
    for (const handle of this.downstreams.byRecency(acpThreadId)) {
      try {
        handle.close();
      } catch (err) {
        this.slog.debug('downstream close failed', { error: (err as Error).message });
      }
    }
  }

  /** This session's stored row. Throws once the session is gone. */
  private row(): SessionRow {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(this.sessionId) as SessionRow | undefined;
    if (!row) throw new Error(`Session ${this.sessionId} not found`);
    return row;
  }

  /** Marks the session as active now, which holds off the reaper. */
  private touch(): void {
    touchSession(this.db, this.sessionId);
  }

  /**
   * Forgets everything this session was in the middle of, across every adapter.
   * None of the callers leaves anything running: a deliberate stop, or the
   * session being closed.
   */
  private clearThreadStates(): void {
    clearSessionTurns(this.db, this.sessionId);
    this.activity.clear();
    this.downstreams.refreshThreadStates();
  }

  // --- threads --------------------------------------------------------------

  /** The thread the gateway answers session/new with, or null before one exists. */
  get current(): ThreadRow | null {
    return currentThread(this.db, this.sessionId) ?? null;
  }

  /** The session's current thread, for the connections. */
  currentThread(): ThreadRow | null {
    return this.current;
  }

  /**
   * Starts a fresh, empty conversation on the same workspace and makes it the
   * session's default. Nobody is moved onto it: a browser already watching
   * another thread keeps watching it, and the new one is opened by following
   * a link to it.
   *
   * The row is written first and the adapter asked afterwards, so that a
   * harness whose credential has not been entered still gets a thread: the
   * dialog is what keeps somebody from asking for one, and the API is not a
   * gate. Such a thread has no conversation until a credential exists, which
   * is the same state as a thread whose adapter has restarted, and it is
   * brought up by the next pin.
   */
  async newThread(options?: ThreadOptions): Promise<ThreadRow> {
    const wanted = harness(options?.harness ?? DEFAULT_HARNESS);
    const thread = insertThread(this.db, this.sessionId, {
      harness: wanted.id,
      modeId: options?.modeId ?? null,
      config: options?.config ?? { ...wanted.defaultConfig },
    });
    this.slog.info('new thread', {
      threadId: thread.id,
      ordinal: thread.ordinal,
      harness: wanted.id,
    });
    try {
      // Through the same resolution a pin uses, because the row is already the
      // session's current thread: an adapter coming up for it mints its
      // conversation on the way, and asking for one again would leave two
      // behind.
      const acpSessionId = await this.resolveThread(thread.id);
      return { ...thread, acp_session_id: acpSessionId };
    } catch (err) {
      this.slog.warn('the new thread has no conversation yet', {
        threadId: thread.id,
        error: (err as Error).message,
      });
      return thread;
    }
  }

  /**
   * Branches one conversation into a second carrying its context, and makes
   * the new one the session's default. The source is left exactly as it was,
   * still streaming to whoever is watching it.
   *
   * A fork stays on its source's harness and keeps what the source is
   * configured with: only the adapter that wrote a transcript can load it, and
   * a fork is that conversation continued rather than a new one. What it does
   * not keep is the mode — it starts in its harness's fork mode, `plan` for
   * Claude, because it shares the source's checkout and the motion this exists
   * for is asking a fork about work the original is still doing. That does not
   * fix the shared workspace; it stops the common accident, and flipping the
   * fork back is one tap in the header.
   */
  async forkThread(sourceThreadId: string): Promise<ThreadRow> {
    const source = getThread(this.db, sourceThreadId);
    if (!source || source.session_id !== this.sessionId) {
      throw new Error('Thread not found');
    }
    if (!source.acp_session_id) throw new Error(NOTHING_TO_FORK);
    const wanted = harness(source.harness);
    const conn = this.connection(wanted.id);
    await conn.ensureStarted();
    const config = threadConfig(source);
    const acpSessionId = await conn.mintAcpThread(
      source.acp_session_id,
      wanted.forkModeId,
      config,
    );
    // The source is recorded, not just used: until the fork is prompted the
    // adapter writes it no transcript, and the row is where its replay has to
    // come from meanwhile. The mode is recorded too, unlike a fresh thread's:
    // a fresh thread is in its harness's default, which is what an empty
    // column already means, where a fork is somewhere the default would not
    // put it back.
    const thread = insertThread(this.db, this.sessionId, {
      harness: wanted.id,
      acpSessionId,
      modeId: wanted.forkModeId,
      config,
      inheritsFrom: source.id,
    });
    this.slog.info('thread forked', { from: source.id, threadId: thread.id });
    return thread;
  }

  /**
   * Makes another of this session's threads its default: what a connection
   * naming no thread gets.
   *
   * An ordinary write, and nothing more. No live connection is pinned to the
   * default, so nobody is dropped and nothing reconnects.
   */
  switchThread(threadId: string): ThreadRow {
    const thread = getThread(this.db, threadId);
    if (!thread || thread.session_id !== this.sessionId) {
      throw new Error('Thread not found');
    }
    this.db
      .prepare('UPDATE sessions SET current_thread_id = ? WHERE id = ?')
      .run(thread.id, this.sessionId);
    this.slog.info('thread selected', { threadId: thread.id });
    return thread;
  }

  // --- what arrives from the adapters ----------------------------------------

  /**
   * Taps an adapter update and delivers it to the browsers it is meant for.
   *
   * `replaying` is the answering connection's own: a load on one harness says
   * nothing about whether the other one's agent is talking.
   */
  onUpdate(harnessId: HarnessId, params: unknown, replaying: boolean): void {
    this.touch();
    // Only what is happening now. A replay re-sends everything the thread
    // ever said, and a transcript arriving in a burst is not the agent
    // talking. The cost is that a turn starting during somebody else's replay
    // goes unobserved, which is a window of milliseconds.
    const thread = threadOf(params);
    if (!replaying && thread) {
      const update = (params as { update?: unknown })?.update;
      this.activity.observe(thread, update, harnessId);
    }
    this.recordThreadInfo(harnessId, params);
    this.tap('up', 'session/update', params);
    this.downstreams.update(params);
  }

  /**
   * Keeps a thread's row in step with what the adapter says about it: the
   * title the agent generates at the end of a turn, the mode and settings it
   * reports itself in, and when it was last heard from.
   *
   * The mode and the settings are here as well as on the requests that set
   * them because the adapter changes them on its own too — leaving plan mode
   * when a plan is accepted, falling back to another model under load — and a
   * thread should come back as it ended up rather than as it was last asked to
   * be.
   *
   * The row is found by the update's own ACP id *and the harness it arrived
   * on*, so an update lands on the thread it is about whichever adapter is
   * talking and whatever is current.
   */
  private recordThreadInfo(harnessId: HarnessId, params: unknown): void {
    const acpSessionId = (params as { sessionId?: string })?.sessionId;
    if (!acpSessionId) return;
    const row = threadByAcpId(this.db, this.sessionId, harnessId, acpSessionId);
    if (!row) return;
    touchThread(this.db, row.id);

    const update = (
      params as {
        update?: {
          sessionUpdate?: string;
          title?: unknown;
          currentModeId?: unknown;
          configOptions?: SessionConfigOption[];
        };
      }
    )?.update;
    switch (update?.sessionUpdate) {
      case 'session_info_update':
        // Every field of a session_info_update is optional, so an update that
        // carries no title says nothing about it. An explicit null is the
        // adapter clearing it, which puts the thread back on its ordinal.
        if (update.title === null) setThreadTitle(this.db, row.id, null);
        else if (typeof update.title === 'string' && update.title.trim()) {
          setThreadTitle(this.db, row.id, update.title.trim());
        }
        return;
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') {
          setThreadMode(this.db, row.id, update.currentModeId);
        }
        return;
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) {
          this.connection(harnessId).recordConfigOptions(acpSessionId, update.configOptions);
        }
        return;
      default:
        return;
    }
  }

  /**
   * Puts a permission request to the most recently active browser watching
   * the thread that asked, or queues it when none is. The adapter blocks
   * until the answer arrives, so an unattended turn pauses instead of
   * proceeding without consent.
   *
   * A browser watching another thread is not asked. It is looking at a
   * different conversation, and a question about one thread's tool call
   * cannot be answered from another's transcript.
   */
  onPermission(params: unknown): Promise<unknown> {
    this.touch();
    this.tap('up', 'session/request_permission', params);

    const thread = threadOf(params);
    const target = thread ? this.downstreams.byRecency(thread)[0] : undefined;
    if (target) {
      return target.request('session/request_permission', params).catch((err) => {
        // The browser vanished mid-question: fall back to queueing so the
        // turn is not failed by a closed tab.
        this.slog.warn('permission forward failed; queueing', {
          error: (err as Error).message,
        });
        return this.queuePermission(params);
      });
    }
    return this.queuePermission(params);
  }

  /** Holds a permission request for a browser to answer, and sends a notification. */
  private queuePermission(params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = this.pending.add(
        this.sessionId,
        threadOf(params) ?? null,
        'session/request_permission',
        params,
        { resolve, reject },
        this.cfg.PERMISSION_HOLD_MINUTES * 60_000,
        (timedOut) => this.applyPermissionFallback(timedOut.row.id, params, resolve),
      );
      this.slog.info('permission request queued', { pendingId: entry.row.id });
      this.announce('approval', threadOf(params) ?? null);
    });
  }

  /**
   * Applies PERMISSION_FALLBACK once PERMISSION_HOLD_MINUTES has passed. The
   * deny fallback answers with a reject option from the request's own list,
   * never an invented one, and cancels the request when none is offered.
   */
  private applyPermissionFallback(
    pendingId: number,
    params: unknown,
    resolve: (r: unknown) => void,
  ): void {
    if (this.cfg.PERMISSION_FALLBACK === 'hold') {
      this.slog.info('permission hold elapsed; still holding', { pendingId });
      return;
    }
    const options = (params as { options?: Array<{ optionId?: string; kind?: string }> })?.options;
    const reject = options?.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    this.pending.settle(pendingId);
    if (reject?.optionId) {
      this.slog.warn('permission denied by timeout fallback', {
        pendingId,
        optionId: reject.optionId,
      });
      resolve({ outcome: { outcome: 'selected', optionId: reject.optionId } });
    } else {
      this.slog.warn('permission cancelled by timeout fallback (no reject option offered)', {
        pendingId,
      });
      resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  /**
   * Tells the notifier that a thread wants somebody, naming the conversation
   * rather than only the box: with two threads live, "your session needs you"
   * is not enough to act on from a lock screen.
   *
   * Fire and forget: a turn already waiting on a human must not also wait on
   * a push service.
   */
  private announce(kind: NotifyKind, acpThreadId: string | null): void {
    const thread = acpThreadId ? this.rowOfAcp(acpThreadId) : undefined;
    let sessionName: string;
    try {
      sessionName = this.row().name;
    } catch {
      // The session was deleted between the event and this call; there is
      // nothing left to notify anybody about.
      return;
    }
    void this.notifier.notify({
      kind,
      sessionId: this.sessionId,
      sessionName,
      threadId: thread?.id ?? null,
      // The same name the dashboard shows, so a notification and the list
      // agree about which conversation this is.
      threadName: thread ? thread.title?.trim() || `Thread ${thread.ordinal}` : null,
      // What is still going on in that conversation, which separates a thread
      // to come back to later from one that is about to say something on its
      // own. Another thread's work is not news about this one.
      background: acpThreadId ? this.background.work(acpThreadId).length > 0 : false,
    });
  }

  /**
   * Puts the queued permission requests of a browser's own thread to it, once
   * it has one. Another thread's questions are not this browser's to answer.
   *
   * Called when that browser has taken the thread's replay, not when it
   * attaches: a client rebuilds its transcript from the replay and drops
   * whatever it held before, and a queued request is delivered once.
   */
  flushPendingTo(handle: DownstreamHandle): void {
    const thread = handle.acpThreadId;
    if (!thread) return;
    // Whether its thread is mid-turn, which is the other thing a replay does
    // not carry: the transcript says what has been said, not that the agent
    // is still saying it. Sent here rather than at attach for the same reason
    // the queued questions are — a client rebuilds from the replay and drops
    // whatever it held before it landed.
    this.downstreams.threadStateTo(handle);
    for (const entry of this.pending.listForThread(this.sessionId, thread)) {
      const params = JSON.parse(entry.row.params) as unknown;
      handle
        .request('session/request_permission', params)
        .then((result) => {
          if (this.pending.settle(entry.row.id)) entry.resolve(result);
        })
        .catch((err) => {
          this.slog.warn('pending permission delivery failed; leaving queued', {
            pendingId: entry.row.id,
            error: (err as Error).message,
          });
        });
    }
  }

  // --- what arrives from the browsers ----------------------------------------

  /**
   * Forwards a browser request to the adapter holding the conversation it is
   * about, tracking prompt turns.
   *
   * `from` is the browser that asked, which decides who a replay goes to, lets
   * a prompt be echoed to everyone watching, and says which adapter a request
   * naming no thread belongs to.
   */
  async forwardRequest(
    method: string,
    params: unknown,
    from?: DownstreamHandle,
  ): Promise<unknown> {
    const conn = this.connectionFor(params, from);
    await conn.ensureStarted();
    this.tap('down', method, params);

    // Which conversation this is about, taken from the message itself: two
    // threads of one session share this gateway, so nothing here may be
    // decided by which of them is the session's default.
    const thread = threadOf(params);
    const isPrompt = method === 'session/prompt' && thread !== undefined;
    const isLoad = method === 'session/load' && thread !== undefined && from !== undefined;

    if (isPrompt) {
      // A fork's first prompt is where it stops borrowing: the adapter starts
      // a transcript for it here, and that transcript opens with everything
      // the source had said, so replaying the source as well would say all of
      // it twice.
      const row = conn.rowOf(thread);
      if (row?.inherits_from) clearThreadInheritance(this.db, row.id);
      // A thread nobody has named yet is called after the prompt going out,
      // so it is recognisable from the moment it is sent rather than from the
      // end of the turn the agent's own title arrives with. Every prompt
      // until then rather than only the first, so a thread the adapter put
      // back on its ordinal is named again by whatever is asked next.
      if (row && !row.title) {
        const name = nameFromPrompt(params);
        if (name) setThreadTitle(this.db, row.id, name);
      }
      this.setTurnActive(thread, true);
      // Before the echo, so the state that goes with it already says the
      // agent is working: the browser that sent the prompt gets its spinner
      // in one hop rather than waiting out the model's own first-token
      // latency.
      this.activity.begin(thread);
      this.downstreams.beginPrompt(params);
    }
    if (isLoad) this.downstreams.beginReplay(from, thread);

    try {
      const result = isLoad
        ? await conn.whileReplaying(() => conn.request(method, params))
        : await conn.request(method, params);
      // A mode the adapter accepted is this thread's from now on, including
      // across the restarts that lose the adapter's copy of it. Recorded here
      // as well as from the adapter's own current_mode_update, because that
      // notification is the adapter's courtesy and this is the answer to the
      // request the user made.
      if (method === 'session/set_mode' && thread !== undefined) {
        const modeId = (params as { modeId?: unknown })?.modeId;
        const row = conn.rowOf(thread);
        if (row && typeof modeId === 'string') setThreadMode(this.db, row.id, modeId);
      }
      // And a setting it accepted is recorded from its own answer, which
      // carries the whole list and the value it settled on. An adapter that
      // answers with nothing leaves the request itself as the record.
      if (method === 'session/set_config_option' && thread !== undefined) {
        this.recordConfigChange(conn, thread, params, result);
      }
      // A fork's own replay is empty until it has been prompted, so the
      // conversation it branched from is replayed in its place — after its
      // own, which is the part that answers the request.
      if (isLoad) await this.replayInherited(conn, thread, from);
      return result;
    } finally {
      if (isPrompt) {
        this.setTurnActive(thread, false);
        this.downstreams.endPrompt(params);
        // Nothing is announced from here. A prompt coming back says the
        // request is over, which is not the same as the agent having
        // finished: the adapter holds one open until the background subagents
        // the turn spawned settle, so an announcement here would be hours
        // late — and a turn the harness started on its own has no request to
        // come back at all. The moment worth telling somebody about is the
        // agent going quiet, and activity.ts is what finds it.
      }
      if (isLoad) this.downstreams.endReplay(from, thread);
    }
  }

  /**
   * Records a setting a browser changed, from the adapter's answer where there
   * is one and from the request where there is not.
   *
   * The mode's own option is excluded by both paths: a mode is `mode_id` and
   * `session/set_mode`, and recording it here as well would give one answer two
   * homes.
   */
  private recordConfigChange(
    conn: AdapterConnection,
    acpThreadId: string,
    params: unknown,
    result: unknown,
  ): void {
    const answered = (result as { configOptions?: SessionConfigOption[] } | null)?.configOptions;
    if (Array.isArray(answered)) {
      conn.recordConfigOptions(acpThreadId, answered);
      return;
    }
    const { configId, value } = (params ?? {}) as { configId?: unknown; value?: unknown };
    if (typeof configId === 'string' && typeof value === 'string') {
      conn.recordConfigValue(acpThreadId, configId, value);
    }
  }

  /**
   * Records whether a prompt turn is running on one thread, and marks the
   * session active.
   *
   * The thread comes from the prompt's own params, so a turn is recorded
   * against the conversation it is on rather than against the session's
   * default.
   */
  private setTurnActive(acpThreadId: string, active: boolean): void {
    setThreadTurnActive(this.db, this.sessionId, acpThreadId, active);
  }

  /**
   * Shows a fork the conversation it was branched from, when it has none of
   * its own yet.
   *
   * A fork holds the source's context from the moment it is minted, but the
   * adapter writes it a transcript only when it is first prompted — so
   * loading it replays nothing, and it opens on a blank screen claiming to
   * know what was said somewhere the reader cannot see. What is sent instead
   * is the source's own replay, re-tagged as this thread's: the same history
   * the fork is carrying, said back to the browser reading it.
   *
   * It goes to the one browser that asked, exactly as that browser's own
   * replay does, and the source's live updates are held back for its length
   * the same way — a replay of a thread cannot be told apart from what it is
   * saying right now, and this is the one place where two threads are the
   * same conversation.
   *
   * A source that cannot be replayed costs the browser the history and
   * nothing else: it asked to load a thread, and the thread is loaded. The
   * source is on the same adapter by construction — a fork stays on its
   * source's harness — so the same connection replays it.
   */
  private async replayInherited(
    conn: AdapterConnection,
    acpThreadId: string,
    to: DownstreamHandle,
  ): Promise<void> {
    const fork = conn.rowOf(acpThreadId);
    if (!fork?.inherits_from) return;
    const source = inheritedSource(this.db, this.sessionId, fork);
    if (!source?.acp_session_id) return;

    this.downstreams.beginReplay(to, source.acp_session_id, acpThreadId);
    try {
      await conn.whileReplaying(() =>
        conn.request('session/load', {
          sessionId: source.acp_session_id,
          cwd: dk.WORKSPACE_DIR,
          mcpServers: [],
          ...conn.meta(),
        }),
      );
      this.slog.info('replayed a fork from the thread it came from', {
        threadId: fork.id,
        from: source.id,
      });
    } catch (err) {
      this.slog.warn('could not replay the thread a fork came from', {
        threadId: fork.id,
        from: source.id,
        error: (err as Error).message,
      });
    } finally {
      this.downstreams.endReplay(to, source.acp_session_id);
    }
  }

  /** Forwards a browser notification to the adapter its thread is on. */
  async forwardNotification(method: string, params: unknown): Promise<void> {
    const conn = this.connectionFor(params);
    await conn.ensureStarted();
    this.tap('down', method, params);
    // Only the cancelled thread's turn ends. Another thread of the same
    // session may still be mid-turn.
    const thread = threadOf(params);
    if (method === 'session/cancel' && thread) {
      this.setTurnActive(thread, false);
      // Whatever the agent was in the middle of saying, it is not saying it
      // any more. The tool calls it had open go with it.
      this.activity.reset(thread);
      this.downstreams.threadState(thread);
    }
    await conn.notify(method, params);
  }

  /** Records one message in the debug log. A failed write never breaks the flow. */
  tap(direction: 'up' | 'down', method: string, params: unknown): void {
    try {
      appendAcpLog(
        this.db,
        this.sessionId,
        direction,
        JSON.stringify({ method, params }, withoutMediaPayloads),
      );
    } catch (err) {
      this.slog.debug('acp_log write failed', { error: (err as Error).message });
    }
  }

  // --- shutdown --------------------------------------------------------------

  /** Stops every connection deliberately, which suppresses the reconnects. */
  stop(): void {
    this.stopPolling();
    // The box is going away, and what was in it went with it. Said now rather
    // than at the next reading, so a card does not carry "still running" over
    // the moment its session was shut down.
    this.background.clear();
    for (const conn of this.connections.values()) conn.stop();
    this.clearThreadStates();
    this.pending.failSession(this.sessionId, 'Session stopped');
  }

  /** Stops for good and forgets every attached browser. */
  close(): void {
    this.stop();
    this.downstreams.clear();
  }

  /** Periodic housekeeping: keeps the debug log within its ring size. */
  maintenance(): void {
    try {
      pruneAcpLog(this.db, this.sessionId);
    } catch (err) {
      this.slog.debug('acp_log prune failed', { error: (err as Error).message });
    }
  }
}
