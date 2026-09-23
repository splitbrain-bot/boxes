import type { Config } from '../config.ts';
import {
  clearBoxTurns,
  clearThreadInheritance,
  currentThread,
  getThread,
  insertThread,
  setThreadMode,
  setThreadTitle,
  setThreadTurnActive,
  threadByAcpId,
  threadConfig,
  touchBox,
  touchThread,
  type Db,
  type BoxRow,
  type ThreadRow,
} from '../db.ts';
import * as dk from '../docker.ts';
import { DEFAULT_HARNESS, harness, HARNESS_IDS, type HarnessId } from '../harness.ts';
import { log, type Logger } from '../log.ts';
import type { NotifyKind, Notifier } from '../notify.ts';
import { Activity } from './activity.ts';
import {
  AdapterConnection,
  NOTHING_TO_FORK,
  THREAD_NOT_FOUND,
  type AdapterHost,
} from './adapter.ts';
import { BackgroundProbe, workPids } from './background.ts';
import { Broadcast, threadOf } from './broadcast.ts';
import type { PendingStore } from './pending.ts';
import type { AdapterOptions } from './thread-log.ts';
import { ACP_METHOD, UPDATE_KIND } from '../../../shared/acp.ts';
import {
  BOXES_META,
  type BackgroundProcess,
  type BoxWork,
  type LoadMeta,
  type ThreadConfigOption,
  type ThreadOptions,
  type TurnStateParams,
} from '../../../shared/types.ts';

/**
 * Everything about one box that is not one adapter process: the browsers
 * attached to it, what is running in its box, which conversation each message
 * is about, and the container all of that happens in.
 *
 * `BoxManager` creates one of these per box on first use and keeps it
 * for the process's life. It owns one {@link AdapterConnection} per harness a
 * thread of the box runs, started when a thread of that harness first needs
 * one, and routes every message to the connection whose adapter holds the
 * conversation it names. A box with only Claude threads never starts a second
 * adapter; a box with both has two processes over one checkout, and an adapter
 * that dies takes down only its own conversations.
 *
 * The orchestrator owns the connections, not a browser, so a turn runs to
 * completion whoever is watching. Each browser connection is pinned to a single
 * thread, chosen at the handshake, so two tabs can watch two conversations of
 * one box at once — and the box's `current_thread_id` is the default a
 * connection that names none gets rather than the truth about what any browser
 * has loaded.
 */

/** How much of one tapped ACP message a debug line carries. */
const MAX_TAPPED_CHARS = 64_000;

/**
 * A JSON.stringify replacer that keeps base64 media out of the debug log.
 *
 * An image or audio block carries its whole payload inline, and a screenshot
 * is a megabyte of base64 against a line that truncates at MAX_TAPPED_CHARS.
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

/** A browser attached to this box, as seen from the upstream side. */
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
  /**
   * Sends a request to this browser and awaits its answer.
   *
   * `signal` withdraws the question once it has gone out, which is how a
   * browser holding a copy of a question somebody else has answered is told
   * to stop waiting. The promise still settles on that browser's own answer:
   * a withdrawal asks it to stop, it does not end the exchange.
   */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Closes this browser's socket, which makes it reconnect from scratch. */
  close(): void;
}

/**
 * Every harness, for the reading of a box.
 *
 * The reading is about the whole container rather than about one adapter: a
 * box may be running either harness's adapter, or both, and a rule that knew
 * only one of them would read the other's box as empty and let the reaper
 * suspend a build nobody could see.
 */
const ALL_HARNESSES = HARNESS_IDS.map((id) => harness(id));

/**
 * How long work gets to stop politely before it is killed.
 *
 * Long enough for a shell to run a trap and a build to put its files down;
 * short enough that a person who pressed stop sees it stop.
 */
const TERM_GRACE_MS = 2_000;

export { NOTHING_TO_FORK, THREAD_NOT_FOUND };

/**
 * The message a browser asked a `session/load` to be picked up after, or
 * undefined when it asked for the thread whole.
 *
 * It travels in `_meta`, which ACP reserves for extensions and this gateway
 * already reads its own options from. Anything but a non-empty string is read
 * as no resume point, so a client that sends something else gets the whole
 * thread rather than an argument.
 */
function resumePointOf(params: unknown): string | undefined {
  const meta = (params as { _meta?: Record<string, unknown> } | null)?._meta;
  const asked = (meta?.[BOXES_META] as LoadMeta | undefined)?.resumeFrom;
  return typeof asked === 'string' && asked ? asked : undefined;
}

/**
 * The block of text a prompt's attachments are named in. The dashboard writes
 * it for the model rather than the user typing it, so it is not something to
 * name a thread after.
 */
const ATTACHMENTS_OPEN = '<attachments>';

/**
 * How long a thread's name may be, whoever wrote it. Long enough for a
 * sentence, and short enough to stay a name rather than the message it came
 * out of.
 */
const MAX_PROMPT_NAME_LENGTH = 120;

/**
 * A name cut to {@link MAX_PROMPT_NAME_LENGTH}, with an ellipsis standing for
 * what was cut. One already short enough comes back as it is.
 */
function capName(name: string): string {
  if (name.length <= MAX_PROMPT_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_PROMPT_NAME_LENGTH - 1)}…`;
}

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
    return capName(line.trim().replace(/\s+/g, ' '));
  }
  return null;
}

/** The orchestrator's own ACP connections to one box's adapters. */
export class UpstreamBox implements AdapterHost {
  /** One adapter process per harness a thread of this box runs. */
  private readonly connections = new Map<HarnessId, AdapterConnection>();
  /** The container start, shared by every connection that wants one. */
  private containerStarting: Promise<string> | null = null;
  /** Who each adapter update goes to. */
  private readonly downstreams: Broadcast;
  /** Whether this box still has work running in it. */
  private readonly background: BackgroundProbe;
  /** Whether the agent is talking on each thread. */
  private readonly activity: Activity;
  private readonly slog: Logger;
  /** Threads being brought up, so concurrent pins share one; see below. */
  private readonly resolving = new Map<string, Promise<string>>();
  /** The reading's own timer while a browser is watching; see pollWhileWatched. */
  private polling: ReturnType<typeof setInterval> | null = null;
  /**
   * When each thread last had an approval announced, by the adapter's own
   * thread id and the empty string for a question naming no thread.
   *
   * A thread announces one approval per hold window. An agent asking in a
   * loop would otherwise be a push to every subscribed browser per question,
   * and a lock screen nobody can read is a notification that has stopped
   * working.
   */
  private readonly announcedApprovals = new Map<string, number>();
  /**
   * KILL escalations armed and not yet fired. Held so a stop can cancel
   * them: each names a container, and one that fires after the box has
   * gone reads processes in a box that is not there.
   */
  private readonly escalations = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    readonly boxId: string,
    readonly db: Db,
    private readonly cfg: Config,
    private readonly pending: PendingStore,
    private readonly notifier: Notifier,
    private readonly onStatusChange: (status: BoxRow['status']) => void,
    /**
     * Run, and awaited, just before the container is started: it brings the
     * box's container up to date, which is everything from writing out
     * the agent configuration to rebuilding a box Docker no longer has.
     *
     * Opening a thread on a stopped box is the other way a container starts,
     * so the repairs cannot live only in `BoxManager.start`. The
     * entrypoint installs whatever is on disk at that moment, so the
     * configuration has to be current here too — and a box something pruned
     * has to be made again here too, or opening a thread on one is a 404 from
     * the daemon with nothing to do about it.
     *
     * It may therefore change the box's container id, which is why the
     * row is read again below rather than before.
     */
    private readonly beforeStart: () => Promise<void>,
  ) {
    this.slog = log.box(boxId);
    this.downstreams = new Broadcast(boxId, (thread) => this.threadState(thread));
    this.background = new BackgroundProbe({
      list: () => this.containerProcesses(),
      // Every harness, because the answer is about the box and not about one
      // adapter in it: what holds a box awake is anything running that Boxes
      // did not put there, whichever agent started it.
      harnesses: ALL_HARNESSES,
      ttlMs: cfg.BACKGROUND_POLL_SECONDS * 1_000,
      // A probe that cannot read its box holds whatever it last believed, and
      // what it last believed holds the reaper off. Silence here is a box
      // that never stops for a reason nobody can see.
      onTrouble: (error) =>
        error
          ? this.slog.warn('cannot read what is running in the box', {
              error: error.message,
            })
          : this.slog.info('reading what is running in the box again'),
      // The bars come off the adapters' own task updates, so a reading has
      // nothing to push to a browser. What it has is the one thing no event
      // can say — that a box which has lost its adapter is still working — and
      // the log is where that has to go, with the commands, because a card
      // saying "still running" with every thread of it quiet is otherwise
      // indistinguishable from a fault.
      onChange: (reading) =>
        reading.busy
          ? this.slog.info('the box has work running in it', { work: reading.work })
          : this.slog.info('nothing is running in the box any more'),
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
        log.tagged({ box: this.boxId, harness: id }),
      );
      this.connections.set(id, conn);
    }
    return conn;
  }

  /**
   * Starts the adapter a box needs by default: the one its current thread
   * runs on, or Claude's before it has a thread at all.
   *
   * Every other path names the harness it wants — a pin resolves the thread
   * first, a forwarded message is routed by the conversation it is about — and
   * this is what a caller with nothing to go on gets.
   */
  async ensureStarted(harnessId?: HarnessId): Promise<void> {
    await this.connection(harnessId ?? this.defaultHarness()).ensureStarted();
  }

  /** The harness of the box's current thread, or the registry's default. */
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
   * box capabilities — so answering with either would tell half the
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
   * One of this box's threads by the adapter's own id for it, whichever
   * harness it belongs to.
   *
   * The lookup takes the harness, and here it is not known: an update has come
   * off a connection that knows it, but a timer in `Activity` or a queued
   * permission request has only the id. Both adapters mint UUIDs, so asking
   * each harness in turn finds the one row there is.
   */
  private rowOfAcp(acpThreadId: string): ThreadRow | undefined {
    for (const id of HARNESS_IDS) {
      const row = threadByAcpId(this.db, this.boxId, id, acpThreadId);
      if (row) return row;
    }
    return undefined;
  }

  /**
   * The connection a forwarded message belongs on: the one holding the
   * conversation it names, else the one for that conversation's stored
   * harness, else the browser's own thread, else the box's default.
   *
   * A message about a thread has to reach the adapter that has that thread —
   * routing it to the other one would be a thread id the adapter has never
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

  // --- what the connections ask of the box -------------------------------

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
    if (!this.row().container_id) throw new Error('Box has no container');

    // Awaited, and the row read after it: this may have rebuilt the container
    // the row named, and the id to start is the one it left behind.
    await this.beforeStart();
    const row = this.row();
    if (!row.container_id) throw new Error('Box has no container');

    await dk.startContainer(row.container_id);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    return row.container_id;
  }

  /** Every conversation a browser is watching, for a connection coming back up. */
  watchedThreads(): readonly string[] {
    return this.downstreams.watchedThreads;
  }

  /**
   * The log hooks a connection reaches the broadcast through.
   *
   * A thread's log belongs to the box rather than to the process that
   * filled it: a browser opening the thread is served from it, and it has to
   * outlive the adapter restarts that rebuild the conversation behind it.
   */
  openLog(acpThreadId: string, options: AdapterOptions, from?: string): void {
    this.downstreams.openLog(acpThreadId, options, from);
  }

  beginFill(acpThreadId: string): void {
    this.downstreams.beginFill(acpThreadId);
  }

  endFill(acpThreadId: string, options: AdapterOptions): void {
    this.downstreams.endFill(acpThreadId, options);
  }

  dropLog(acpThreadId: string): void {
    this.downstreams.dropLog(acpThreadId);
  }

  /** A connection is up and serving, so the reading's own clock runs again. */
  onUp(): void {
    this.pollWhileWatched();
  }

  /** A connection's outcome, which is the box's status. */
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
      setThreadTurnActive(this.db, this.boxId, acpThreadId, false);
      this.activity.reset(acpThreadId);
      // The adapter that asked is gone, so no answer can reach it any more.
      // Left queued, each question holds its box out of the reaper and
      // shows a browser a question nobody can answer.
      this.pending.failThread(this.boxId, acpThreadId, 'The agent adapter exited');
    }
    this.downstreams.refreshThreadStates();
  }

  // --- the box ---------------------------------------------------------------

  /** How many browsers are attached to this box. */
  get attachedCount(): number {
    return this.downstreams.size;
  }

  /**
   * Whether this box has work running in the background, which holds the
   * idle reaper off the way an attached browser or a running turn does.
   *
   * The box first, because that is the answer that holds when no adapter is
   * running and not every thread is loaded — after a respawn the bars are
   * empty and the build is still compiling. A task an adapter has told us
   * about counts too: not every task is a process of its own, and a monitor
   * the agent is holding open inside the CLI would otherwise be reaped with
   * the box it is watching.
   *
   * Null until the box has been read and no adapter has a task: the reaper
   * holds a box it has no answer for, and a card shows it as nothing
   * running.
   */
  get backgroundActive(): boolean | null {
    if ([...this.connections.values()].some((conn) => conn.hasTasks)) return true;
    return this.background.active;
  }

  /**
   * What the last reading found running in the box, for a reader deciding
   * whether to stop it.
   *
   * The reading alone, with nothing of the adapters' in it: a task an adapter
   * announced is named on its own thread's bar, and a task that is not a
   * process of its own — a monitor the agent holds open inside the CLI — is
   * not in a process table at all. So this is shorter than
   * {@link backgroundActive} is true for, and the two disagreeing is the
   * ordinary case rather than a fault.
   */
  get boxWork(): readonly BoxWork[] {
    return this.background.work;
  }

  /**
   * Whether this upstream is holding nothing at all: no browser attached, no
   * permission request waiting, no connection to an adapter, no start in
   * flight and no stop armed.
   *
   * What lets the manager forget one it built only to answer a question about
   * a box. Nothing is lost by that: the connections are what carry the
   * conversations an adapter knows, and there are none.
   */
  get holdsNothing(): boolean {
    return (
      this.downstreams.size === 0 &&
      [...this.connections.values()].every((conn) => conn.holdsNothing) &&
      this.containerStarting === null &&
      this.escalations.size === 0 &&
      this.pending.countForBox(this.boxId) === 0
    );
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
   * Stops what a conversation left running in its box: one task, or every task
   * it has.
   *
   * The adapter's own stop, not a signal. `session/cancel` is the composer's
   * button and it is right for a turn — the adapter interrupts the query and
   * tears down the subagents it was holding open for — but a backgrounded
   * command is a child of the agent process that outlives its turn by design,
   * so no interrupt reaches it. `_session/async_task/stop` names the task
   * itself, on the connection whose adapter is running it.
   *
   * An adapter that is no longer up has nothing to stop this way: the tasks it
   * announced went with the process, and what it left running in the box is
   * the box-level stop's to kill.
   *
   * @returns How many tasks the adapter said it stopped. Zero is a normal
   *   answer: a task that was already over answers `stopped: false`, and the
   *   thread's state is re-sent either way so the bar catches up.
   */
  async stopBackgroundWork(acpThreadId: string, taskId?: string): Promise<number> {
    const conn = this.connectionHolding(acpThreadId);
    if (!conn) return 0;
    const stopped = await conn.stopTasks(acpThreadId, taskId);
    this.downstreams.threadState(acpThreadId);
    return stopped;
  }

  /**
   * Kills everything running in the box that Boxes did not put there.
   *
   * The floor's own stop, for work no task claims. After a respawn the bars
   * are empty and the box is still busy — neither adapter re-announces what
   * the process before it left running — and a signal is the only thing that
   * can reach an orphaned build. It is not addressed to a conversation because
   * it cannot be: the reading knows what is running and not whose it is.
   *
   * The pids are read from inside the container at this moment and used
   * immediately, because they are the box's own numbering and because a
   * process that ended in between should not be found. TERM first, leaves
   * before the branches they hang off — a parent killed first hands its
   * children to init, still running and out of every reading — and whatever is
   * still there a moment later is sent KILL. The escalation is not waited for,
   * so the answer is about what was signalled rather than what has died.
   *
   * @returns How many processes were signalled. Zero is an ordinary answer:
   *   the work ended between the reading a card is showing and this call.
   */
  async stopBoxWork(): Promise<number> {
    const containerId = this.row().container_id;
    if (!containerId) return 0;
    if ((await dk.containerState(containerId)) !== 'running') return 0;

    const doomed = workPids(
      await dk.containerProcessesFromInside(containerId),
      ALL_HARNESSES,
    );
    if (doomed.length === 0) {
      // Nothing to kill is still news: what the card is showing is a reading
      // that has been overtaken, and a fresh one puts it right.
      void this.background.refresh();
      return 0;
    }

    this.slog.info('stopping everything running in the box', { pids: doomed });
    await dk.killInContainer(containerId, 'TERM', doomed);
    // No reading here: a process signalled a millisecond ago is very likely
    // still in the table, and a reading that says so would put the badge back
    // for a poll's length. The escalation takes one when it settles, which is
    // the first moment the answer can be true either way.
    this.escalate(containerId);
    return doomed.length;
  }

  /**
   * KILLs whatever a TERM did not stop, a moment later.
   *
   * Detached from the request, which has been answered: a stop is judged by
   * the next reading, not by this. What it re-reads is the same question
   * rather than the same pids — a pid that has gone is no longer work, and one
   * that has not is what was asked to stop.
   */
  private escalate(containerId: string): void {
    const timer = setTimeout(() => {
      this.escalations.delete(timer);
      void (async () => {
        try {
          const left = workPids(
            await dk.containerProcessesFromInside(containerId),
            ALL_HARNESSES,
          );
          if (left.length === 0) return;
          this.slog.info('work in the box ignored TERM; killing', { pids: left });
          await dk.killInContainer(containerId, 'KILL', left);
        } catch (err) {
          this.slog.warn('could not finish stopping what the box was running', {
            error: (err as Error).message,
          });
        } finally {
          void this.background.refresh();
        }
      })();
    }, TERM_GRACE_MS);
    timer.unref?.();
    this.escalations.add(timer);
  }

  /**
   * What is running in this box's container, for the probe.
   *
   * A box with no container, or one that is not up, has nothing running
   * in it. That is null rather than an empty table: an empty table is what a
   * box that could not be read looks like, which counts as busy, and a
   * stopped box was answering "still running" forever because of it.
   */
  private async containerProcesses(): Promise<dk.ContainerProcess[] | null> {
    const containerId = this.row().container_id;
    if (!containerId) return null;
    if ((await dk.containerState(containerId)) !== 'running') return null;
    return dk.containerProcesses(containerId);
  }

  /** The threads of this box the agent is talking on. */
  get speakingThreads(): string[] {
    return this.activity.speakingThreads;
  }

  /**
   * The threads of this box with work still running in them, across every
   * adapter the box is holding.
   *
   * From the adapters rather than from the box: what a person sees named is
   * what an adapter announced, and a list that shows every thread of a box at
   * once has to say which of them is holding it up.
   */
  get workingThreads(): string[] {
    return [...this.connections.values()].flatMap((conn) => conn.taskThreads);
  }

  /**
   * What one conversation has running, whichever adapter announced it.
   *
   * A task id belongs to one connection by construction — the adapter that
   * minted the conversation is the adapter running its tasks — so the first
   * connection with anything for this thread is the one that has it.
   */
  private tasksFor(acpThreadId: string): BackgroundProcess[] {
    for (const conn of this.connections.values()) {
      const tasks = conn.tasksFor(acpThreadId);
      if (tasks.length > 0) return tasks;
    }
    return [];
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
      background: this.tasksFor(acpThreadId),
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
   * Settles which of the box's conversations a connection is for, and
   * answers with the adapter's own id for it.
   *
   * `threadId` names one of the box's threads, or is null for a
   * connection that named none, as an external ACP client does, which gets
   * the box's current one.
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
   * The live adapter id for one of the box's threads, bringing the thread
   * up first when its adapter is not already holding it.
   *
   * The spawn path brings back the box's current thread and the ones
   * browsers were already watching, which is every thread it can know about.
   * Opening any other one lands here, and is loaded on the same terms as at
   * spawn, so the connection is never pinned to a conversation the adapter
   * has never heard of.
   */
  private async resolveThread(threadId: string | null): Promise<string> {
    let row = threadId ? getThread(this.db, threadId) : this.current;
    if (!row && !threadId) {
      // A box with no thread at all: its first one is minted by the
      // default adapter coming up, which is the one path that creates a row
      // rather than bringing one up.
      await this.ensureStarted();
      row = this.current;
    }
    if (!row || row.box_id !== this.boxId) throw new Error(THREAD_NOT_FOUND);
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
   * switching the box's default nor adding a thread drops a browser.
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

  /** This box's stored row. Throws once the box is gone. */
  private row(): BoxRow {
    const row = this.db
      .prepare('SELECT * FROM boxes WHERE id = ?')
      .get(this.boxId) as BoxRow | undefined;
    if (!row) throw new Error(`Box ${this.boxId} not found`);
    return row;
  }

  /** Marks the box as active now, which holds off the reaper. */
  private touch(): void {
    touchBox(this.db, this.boxId);
  }

  /**
   * Forgets everything this box was in the middle of, across every adapter.
   * None of the callers leaves anything running: a deliberate stop, or the
   * box being closed.
   */
  private clearThreadStates(): void {
    clearBoxTurns(this.db, this.boxId);
    this.activity.clear();
    this.downstreams.refreshThreadStates();
  }

  // --- threads --------------------------------------------------------------

  /**
   * The box's default conversation: what a connection naming no thread is
   * pinned to. Null before the box has one.
   */
  get current(): ThreadRow | null {
    return currentThread(this.db, this.boxId) ?? null;
  }

  /** The box's current thread, for the connections. */
  currentThread(): ThreadRow | null {
    return this.current;
  }

  /**
   * Starts a fresh, empty conversation on the same workspace and makes it the
   * box's default. Nobody is moved onto it: a browser already watching
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
    const thread = insertThread(this.db, this.boxId, {
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
      // box's current thread: an adapter coming up for it mints its
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
   * the new one the box's default. The source is left exactly as it was,
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
    if (!source || source.box_id !== this.boxId) {
      throw new Error(THREAD_NOT_FOUND);
    }
    if (!source.acp_session_id) throw new Error(NOTHING_TO_FORK);
    const wanted = harness(source.harness);
    const conn = this.connection(wanted.id);
    await conn.ensureStarted();
    // The fork's log starts as a copy of the source's, so the source has to
    // have one: brought up here if no browser has opened it on this adapter.
    if (!(await conn.hold(source))) throw new Error(NOTHING_TO_FORK);
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
    const thread = insertThread(this.db, this.boxId, {
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
   * Makes another of this box's threads its default: what a connection
   * naming no thread gets.
   *
   * An ordinary write, and nothing more. No live connection is pinned to the
   * default, so nobody is dropped and nothing reconnects.
   */
  switchThread(threadId: string): ThreadRow {
    const thread = getThread(this.db, threadId);
    if (!thread || thread.box_id !== this.boxId) {
      throw new Error(THREAD_NOT_FOUND);
    }
    this.db
      .prepare('UPDATE boxes SET current_thread_id = ? WHERE id = ?')
      .run(thread.id, this.boxId);
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
    // talking. Only that thread's own replay silences it, and the cost is a
    // turn starting on a thread while it rebuilds, which is a window of
    // milliseconds.
    const thread = threadOf(params);
    const update = (params as { update?: unknown })?.update;
    if (!replaying && thread) this.activity.observe(thread, update, harnessId);
    this.recordThreadInfo(harnessId, params, replaying);
    this.tap('up', ACP_METHOD.sessionUpdate, params);
    this.downstreams.update(params);
    // After the update rather than before it, so a browser reading its
    // transcript and the bar above its composer agree about what has just
    // happened. A task update is passed through as well as read here: the
    // gateway forwards everything an adapter says, and what a client makes of
    // this extension is its own business.
    if (thread !== undefined && this.connection(harnessId).noteTask(thread, update)) {
      this.downstreams.threadState(thread);
    }
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
   * The three kinds below are the whole of what is recorded, and that is a
   * different list from the kinds `activity.ts` reads as the agent at work
   * and from the kinds the dashboard draws. A mode change is stored here and
   * is not the agent doing anything; a message chunk is the agent working and
   * is not stored, because the transcript is the adapter's.
   *
   * The row is found by the update's own ACP id *and the harness it arrived
   * on*, so an update lands on the thread it is about whichever adapter is
   * talking and whatever is current.
   *
   * A replayed update does not count as the thread having been heard from:
   * it is the transcript being read back, so opening a thread would otherwise
   * move it to the top of the list for having been opened.
   */
  private recordThreadInfo(harnessId: HarnessId, params: unknown, replaying: boolean): void {
    const acpSessionId = (params as { sessionId?: string })?.sessionId;
    if (!acpSessionId) return;
    const row = threadByAcpId(this.db, this.boxId, harnessId, acpSessionId);
    if (!row) return;
    if (!replaying) touchThread(this.db, row.id);

    const update = (
      params as {
        update?: {
          sessionUpdate?: string;
          title?: unknown;
          currentModeId?: unknown;
          configOptions?: ThreadConfigOption[];
        };
      }
    )?.update;
    switch (update?.sessionUpdate) {
      case UPDATE_KIND.sessionInfo:
        // Every field of a session_info_update is optional, so an update that
        // carries no title says nothing about it. An explicit null is the
        // adapter clearing it, which puts the thread back on its ordinal.
        if (update.title === null) setThreadTitle(this.db, row.id, null);
        else if (typeof update.title === 'string' && update.title.trim()) {
          // Cut to the same length a prompt-derived name is, so no adapter's
          // idea of a title can push a paragraph into the thread list.
          setThreadTitle(this.db, row.id, capName(update.title.trim()));
        }
        return;
      case UPDATE_KIND.currentMode:
        if (typeof update.currentModeId === 'string') {
          setThreadMode(this.db, row.id, update.currentModeId);
        }
        return;
      case UPDATE_KIND.configOption:
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
    this.tap('up', ACP_METHOD.sessionRequestPermission, params);

    const thread = threadOf(params);
    const target = thread ? this.downstreams.byRecency(thread)[0] : undefined;
    if (target) {
      return target.request(ACP_METHOD.sessionRequestPermission, params).catch((err) => {
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
        this.boxId,
        threadOf(params) ?? null,
        ACP_METHOD.sessionRequestPermission,
        params,
        { resolve, reject },
        this.cfg.PERMISSION_HOLD_MINUTES * 60_000,
        (timedOut) => this.applyPermissionFallback(timedOut.row.id, params, resolve),
      );
      this.slog.info('permission request queued', { pendingId: entry.row.id });
      const thread = threadOf(params) ?? null;
      if (this.mayAnnounceApproval(thread)) this.announce('approval', thread);
    });
  }

  /**
   * Whether a thread may say it is waiting for a decision, and records that
   * it has when it may.
   *
   * The window is the hold: the first question of a thread is worth waking
   * somebody for, and the ones behind it are the same trip back to the same
   * conversation. Whoever comes back finds all of them.
   */
  private mayAnnounceApproval(acpThreadId: string | null): boolean {
    const key = acpThreadId ?? '';
    const last = this.announcedApprovals.get(key) ?? 0;
    const now = Date.now();
    if (now - last < this.cfg.PERMISSION_HOLD_MINUTES * 60_000) return false;
    this.announcedApprovals.set(key, now);
    return true;
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
   * rather than only the box: with two threads live, "your box needs you"
   * is not enough to act on from a lock screen.
   *
   * Fire and forget: a turn already waiting on a human must not also wait on
   * a push service.
   */
  private announce(kind: NotifyKind, acpThreadId: string | null): void {
    const thread = acpThreadId ? this.rowOfAcp(acpThreadId) : undefined;
    let boxName: string;
    try {
      boxName = this.row().name;
    } catch {
      // The box was deleted between the event and this call; there is
      // nothing left to notify anybody about.
      return;
    }
    void this.notifier.notify({
      kind,
      boxId: this.boxId,
      boxName,
      threadId: thread?.id ?? null,
      // The same name the dashboard shows, so a notification and the list
      // agree about which conversation this is.
      threadName: thread ? thread.title?.trim() || `Thread ${thread.ordinal}` : null,
      // What is still going on in that conversation, which separates a thread
      // to come back to later from one that is about to say something on its
      // own. Another thread's work is not news about this one.
      background: acpThreadId ? this.tasksFor(acpThreadId).length > 0 : false,
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
    for (const entry of this.pending.listForThread(this.boxId, thread)) {
      const params = JSON.parse(entry.row.params) as unknown;
      // This browser's own copy of the question, withdrawn when another
      // browser answers it first. Dropped as soon as this browser has
      // answered, so its own answer does not withdraw itself.
      const delivery = new AbortController();
      entry.deliveries.add(delivery);
      handle
        .request(ACP_METHOD.sessionRequestPermission, params, delivery.signal)
        .then((result) => {
          entry.deliveries.delete(delivery);
          if (this.pending.settle(entry.row.id)) entry.resolve(result);
        })
        .catch((err) => {
          entry.deliveries.delete(delivery);
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
    // threads of one box share this gateway, so nothing here may be
    // decided by which of them is the box's default.
    const thread = threadOf(params);
    const isPrompt = method === ACP_METHOD.sessionPrompt && thread !== undefined;
    const isLoad = method === ACP_METHOD.sessionLoad && thread !== undefined && from !== undefined;

    if (isPrompt) {
      // A fork's first prompt is where the adapter starts a transcript for
      // it, opening with everything the source had said. From here a restart
      // loads the fork back rather than branching its source again.
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
    // A browser opening a thread is sent the gateway's own log of it, from
    // the last message it says it holds, and the adapter is not asked. The
    // thread was brought up — transcript read, log filled — when this browser
    // was pinned to it, and asking the adapter to replay it now would mix
    // that replay into whatever the thread is saying live.
    if (isLoad) return this.downstreams.open(from, thread, resumePointOf(params));

    try {
      const result = await conn.request(method, params);
      // A mode the adapter accepted is this thread's from now on, including
      // across the restarts that lose the adapter's copy of it. Recorded here
      // as well as from the adapter's own current_mode_update, because that
      // notification is the adapter's courtesy and this is the answer to the
      // request the user made.
      if (method === ACP_METHOD.sessionSetMode && thread !== undefined) {
        const modeId = (params as { modeId?: unknown })?.modeId;
        const row = conn.rowOf(thread);
        if (row && typeof modeId === 'string') setThreadMode(this.db, row.id, modeId);
      }
      // And a setting it accepted is recorded from its own answer, which
      // carries the whole list and the value it settled on. An adapter that
      // answers with nothing leaves the request itself as the record.
      if (method === ACP_METHOD.sessionSetConfigOption && thread !== undefined) {
        this.recordConfigChange(conn, thread, params, result);
      }
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
    const answered = (result as { configOptions?: ThreadConfigOption[] } | null)?.configOptions;
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
   * box active.
   *
   * The thread comes from the prompt's own params, so a turn is recorded
   * against the conversation it is on rather than against the box's
   * default.
   */
  private setTurnActive(acpThreadId: string, active: boolean): void {
    setThreadTurnActive(this.db, this.boxId, acpThreadId, active);
  }

  /** Forwards a browser notification to the adapter its thread is on. */
  async forwardNotification(method: string, params: unknown): Promise<void> {
    const conn = this.connectionFor(params);
    await conn.ensureStarted();
    this.tap('down', method, params);
    // Only the cancelled thread's turn ends. Another thread of the same
    // box may still be mid-turn.
    const thread = threadOf(params);
    if (method === ACP_METHOD.sessionCancel && thread) {
      this.setTurnActive(thread, false);
      // Whatever the agent was in the middle of saying, it is not saying it
      // any more. The tool calls it had open go with it.
      this.activity.reset(thread);
      this.downstreams.threadState(thread);
    }
    await conn.notify(method, params);
  }

  /** Writes one message to the log at debug level, where `docker logs` sees it. */
  tap(direction: 'up' | 'down', method: string, params: unknown): void {
    if (!log.wants('debug')) return;
    this.slog.debug('acp', {
      direction,
      method,
      payload: JSON.stringify(params, withoutMediaPayloads).slice(0, MAX_TAPPED_CHARS),
    });
  }

  // --- shutdown --------------------------------------------------------------

  /** Stops every connection deliberately, which suppresses the reconnects. */
  stop(): void {
    this.stopPolling();
    // Each one names a container this box may not have by the time it
    // fires, and reads the box it named.
    for (const timer of this.escalations) clearTimeout(timer);
    this.escalations.clear();
    // The box is going away, and what was in it went with it. Said now rather
    // than at the next reading, so a card does not carry "still running" over
    // the moment its box was shut down.
    this.background.clear();
    for (const conn of this.connections.values()) conn.stop();
    this.clearThreadStates();
    // A question this box's adapters asked cannot be answered any more, so
    // the next one a fresh adapter asks is news again.
    this.announcedApprovals.clear();
    this.pending.failBox(this.boxId, 'Box stopped');
  }

  /** Stops for good and forgets every attached browser. */
  close(): void {
    this.stop();
    this.downstreams.clear();
  }
}
