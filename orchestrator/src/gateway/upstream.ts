import { client as acpClient, type ClientConnection } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable } from 'node:stream';
import type { Config } from '../config.ts';
import {
  clearSessionTurns,
  clearThreadInheritance,
  currentThread,
  getThread,
  insertThread,
  setThreadAcpId,
  setThreadMode,
  setThreadModel,
  setThreadTitle,
  setThreadTurnActive,
  threadByAcpId,
  touchSession,
  touchThread,
  type Db,
  type SessionRow,
  type ThreadRow,
} from '../db.ts';
import * as dk from '../docker.ts';
import { log, type Logger } from '../log.ts';
import type { NotifyKind, Notifier } from '../notify.ts';
import { Activity } from './activity.ts';
import { BackgroundProbe, workToStop } from './background.ts';
import { Broadcast, threadOf } from './broadcast.ts';
import type { PendingStore } from './pending.ts';
import type { SessionConfigOption, SessionModeState, ThreadOptions } from './thread-log.ts';
import { ACP_METHOD, UPDATE_KIND } from '../../../shared/acp.ts';
import { BOXES_META, type LoadMeta, type TurnStateParams } from '../../../shared/types.ts';

/**
 * One persistent ACP client per session, connected to the adapter inside the
 * session container over a long-lived docker exec.
 *
 * The orchestrator owns this connection, not a browser, so a turn runs to
 * completion whoever is watching. Thread replay belongs to the adapter's own
 * session/load.
 *
 * A session owns several threads, and this one connection carries all of the
 * ones anybody is watching. Each browser connection is pinned to a single
 * thread, chosen at the handshake, so two tabs can watch two conversations of
 * one box at once. The session's `current_thread_id` is the default a
 * connection that names no thread gets rather than the truth about what any
 * browser has loaded.
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

/** Pass-through parser, leaving params and their _meta untouched. */
const raw = <T = unknown>(params: unknown): T => params as T;

/** How often a failed adapter spawn is retried before the session errors. */
const MAX_SPAWN_ATTEMPTS = 3;

/** Wait before each retry, in milliseconds. */
const SPAWN_BACKOFF_MS = [1000, 3000, 8000];

/** JSON-RPC code the ACP SDK uses for a resource that does not exist. */
const RESOURCE_NOT_FOUND = -32002;

/**
 * The mode a fresh thread is switched into, when the adapter advertises one
 * by that id. An adapter that offers no such mode is left in whichever mode
 * it starts in.
 */
const DEFAULT_MODE_ID = 'auto';

/**
 * The mode a fork starts in instead. A fork shares the thread it came from's
 * checkout, and the point of one is to ask questions about work the original
 * is still doing, so it starts in a mode that reads rather than writes. It is
 * the user's from then on, one tap away in the header.
 */
const FORK_MODE_ID = 'plan';

/**
 * How far a borrowed replay follows the chain of forks back. A fork of a fork
 * inherits through the middle thread, and the bound is what stops a row that
 * somehow points at itself from spinning.
 */
const MAX_INHERIT_HOPS = 32;

/**
 * The model a fresh thread is put on, when the adapter offers it. An adapter
 * that offers no such model leaves the thread on whichever one it starts on.
 */
const DEFAULT_MODEL_ID = 'opus';

/**
 * A model named on every conversation, so that the adapter offers it.
 *
 * The adapter lists the models the account's plan covers. Fable is billed
 * against usage credits rather than the plan, so it is left out of that list
 * unless a conversation names it, and naming it is what puts it in the
 * dashboard's picker. Naming a model does not select it: a fresh thread
 * still starts on {@link DEFAULT_MODEL_ID}.
 */
const OFFERED_MODEL_ID = 'fable';

/**
 * What the adapter is asked for on every conversation this orchestrator
 * creates or brings back.
 *
 * `model` names a model to offer beyond the ones the adapter lists of its
 * own accord. The rest is thinking.
 *
 * `display` carries it. Current models default it to `omitted`, which streams
 * thinking blocks carrying a signature and no text, so the adapter has
 * nothing to put in an `agent_thought_chunk` and the dashboard's reasoning
 * disclosure never appears. `summarized` is what makes the agent's reasoning
 * readable.
 *
 * `enabled` with a budget rather than `adaptive`: the two behave the same on
 * a current model, and a model that predates `adaptive` can reject it. Which
 * model a thread runs is the user's choice from the header, while the
 * thinking setting is fixed at the thread's creation.
 *
 * It travels in `_meta`, which is where ACP puts an agent's own extensions:
 * the adapter reads `_meta.claudeCode.options` and lays it over the options
 * it hands the Claude Agent SDK.
 */
const SESSION_META = {
  claudeCode: {
    options: {
      model: OFFERED_MODEL_ID,
      thinking: { type: 'enabled', budgetTokens: 10_000, display: 'summarized' },
    },
  },
} as const;

/**
 * The value to select for a wanted model: the name itself when the adapter
 * offers it, else a bracketed variant of it such as `opus[1m]`, which is the
 * same model with a different context window. A name that merely starts the
 * same way, such as `opusplan`, is a different model and never matches.
 */
function pickModel(options: Array<{ value: string }>, wanted: string): string | null {
  if (options.some((option) => option.value === wanted)) return wanted;
  return options.find((option) => option.value.startsWith(`${wanted}[`))?.value ?? null;
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

/** A thread id that names none of the session's threads; the API turns this into a 404. */
export const THREAD_NOT_FOUND = 'Thread not found';

/** True when the adapter reported a missing thread rather than a failure. */
function isResourceNotFound(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === RESOURCE_NOT_FOUND;
}

/**
 * What a browser opening the thread is handed of the adapter's answer to a
 * `session/new`, `session/fork` or `session/load`: the modes it offers and
 * the options it lets a client set. Absent ones read as none.
 */
function optionsOf(
  res: {
    modes?: SessionModeState | null;
    configOptions?: SessionConfigOption[] | null;
  } | null,
): ThreadOptions {
  return { modes: res?.modes ?? null, configOptions: res?.configOptions ?? [] };
}

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

/** The orchestrator's own ACP connection to one session's adapter. */
export class UpstreamSession {
  private exec: dk.AdapterExec | null = null;
  private conn: ClientConnection | null = null;
  private initializeResponse: unknown = null;
  private starting: Promise<void> | null = null;
  /** Who each adapter update goes to. */
  private readonly downstreams: Broadcast;
  /** Whether this session still has work running in it. */
  private readonly background: BackgroundProbe;
  /** Whether the agent is talking on each thread. */
  private readonly activity: Activity;
  private readonly slog: Logger;
  /** Threads being brought up, so concurrent pins share one; see below. */
  private readonly resolving = new Map<string, Promise<string>>();
  /**
   * The conversations this adapter process has been made to hold: every one
   * it has minted, and every one it has loaded back.
   *
   * A stored ACP id says a thread had a conversation once, not that the
   * adapter running now knows about it. Only this says that, which is what
   * lets a pin tell a thread it has to bring up from one that is already up.
   * Emptied with the connection, because a fresh adapter holds nothing.
   */
  private readonly live = new Set<string>();
  private closed = false;
  /** Guards against reconnect storms after a deliberate stop. */
  private stopping = false;
  /** Loads in flight per thread, which is what says an update is history. */
  private readonly replaying = new Map<string, number>();
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
  /** The reading's own timer while a browser is watching; see pollWhileWatched. */
  private polling: ReturnType<typeof setInterval> | null = null;
  /**
   * KILL escalations armed and not yet fired. Held so a stop can cancel
   * them: each names a container, and one that fires after the session has
   * gone reads processes in a box that is not there.
   */
  private readonly escalations = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    readonly sessionId: string,
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly pending: PendingStore,
    private readonly notifier: Notifier,
    private readonly onStatus: (status: SessionRow['status']) => void,
    /**
     * Run, and awaited, just before the container is started: it brings the
     * session's container up to date, which is everything from writing out
     * the agent configuration to rebuilding a box Docker no longer has.
     *
     * Opening a thread on a stopped box is the other way a container starts,
     * so the repairs cannot live only in `SessionManager.start`. The
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
      adapter: this.adapterToken(),
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

  /** How many browsers are attached to this session. */
  get attachedCount(): number {
    return this.downstreams.size;
  }

  /**
   * Whether this session has work running in the background, which holds the
   * idle reaper off the way an attached browser or a running turn does.
   *
   * Null until the box has been read: the reaper holds a session it has no
   * answer for, and a card shows it as nothing running.
   */
  get backgroundActive(): boolean | null {
    return this.background.active;
  }

  /**
   * Whether this upstream is holding nothing at all: no browser attached, no
   * permission request waiting, no connection to an adapter, no start in
   * flight and no stop armed.
   *
   * What lets the manager forget one it built only to answer a question about
   * a box. Nothing is lost by that: the connection is what carries the
   * conversations an adapter knows, and there is none.
   */
  get holdsNothing(): boolean {
    return (
      this.downstreams.size === 0 &&
      this.conn === null &&
      this.exec === null &&
      this.starting === null &&
      this.escalations.size === 0 &&
      this.pending.countForSession(this.sessionId) === 0
    );
  }

  /** Test seam: takes a reading now rather than when one goes stale. */
  refreshBackgroundForTests(): Promise<void> {
    return this.background.refresh();
  }

  /**
   * A token from the adapter's command line, which is the command Boxes
   * launched and so the one thing in the box guaranteed to be recognisable
   * from out here.
   */
  private adapterToken(): string {
    return JSON.parse(this.row().agent_cmd)[0] as string;
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
      this.adapterToken(),
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
   * KILLs whatever a TERM did not stop, a moment later.
   *
   * Detached from the request, which has been answered: a stop is judged by
   * the next reading, not by this. What it re-reads is the same question
   * rather than the same pids: a pid that has gone is no longer this thread's
   * work, and one that has not is what was asked to stop.
   */
  private escalate(containerId: string, acpThreadId: string, id?: string): void {
    const timer = setTimeout(() => {
      this.escalations.delete(timer);
      void (async () => {
        try {
          const left = workToStop(
            await dk.containerProcessesFromInside(containerId),
            this.adapterToken(),
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
    this.escalations.add(timer);
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

  /** The initialize response to hand browsers, cached verbatim. */
  get cachedInitialize(): unknown {
    return this.initializeResponse;
  }

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
   * The adapter has to be up first: a thread minted and never prompted has no
   * adapter-side conversation until one is made, and pinning a connection to
   * an id the adapter has forgotten would leave every prompt on it failing.
   */
  async pin(handle: DownstreamHandle, threadId: string | null): Promise<string> {
    await this.ensureStarted();
    const acpThreadId = await this.resolveThread(threadId);
    handle.acpThreadId = acpThreadId;
    this.slog.info('downstream pinned to a thread', { handle: handle.id, acpThreadId });
    return acpThreadId;
  }

  /**
   * The live adapter id for one of the session's threads, bringing the thread
   * up first when this adapter is not already holding it.
   *
   * The spawn path brings back the session's current thread and the ones
   * browsers were already watching, which is every thread it can know about.
   * Opening any other one lands here, and is loaded on the same terms as at
   * spawn, so the connection is never pinned to a conversation the adapter
   * has never heard of.
   */
  private async resolveThread(threadId: string | null): Promise<string> {
    const row = threadId ? getThread(this.db, threadId) : this.current;
    if (!row || row.session_id !== this.sessionId) throw new Error(THREAD_NOT_FOUND);
    if (row.acp_session_id && this.live.has(row.acp_session_id)) return row.acp_session_id;
    // Two tabs opening the same thread at once share one bring-up, so the
    // second neither replays it twice nor overwrites the first's id in the
    // row.
    const inFlight = this.resolving.get(row.id);
    if (inFlight) return inFlight;
    const attempt = this.bringUp(row.id).finally(() => this.resolving.delete(row.id));
    this.resolving.set(row.id, attempt);
    return attempt;
  }

  /**
   * Makes this adapter hold one of the session's threads: its stored
   * conversation when the adapter still has the transcript for it, a fresh
   * one when it does not.
   *
   * A thread minted, never prompted, and left behind by an adapter restart is
   * the second case — the agent SDK writes no transcript until a prompt has
   * run — and it has nothing to lose, so a fresh conversation in its row is
   * the whole repair.
   */
  private async bringUp(threadId: string): Promise<string> {
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    const row = getThread(this.db, threadId);
    if (!row) throw new Error(THREAD_NOT_FOUND);
    if (row.acp_session_id && (await this.loadSession(conn, row))) return row.acp_session_id;
    return this.mintInto(threadId);
  }

  /**
   * Mints a fresh adapter conversation and records it against a thread row.
   *
   * A fork that has not been prompted yet is branched again rather than
   * started empty: it exists to carry the source's context, and an adapter
   * restart is not the user changing their mind about that. When the source
   * cannot be branched either — the same restart may have left it with a
   * conversation of its own to lose — the thread is started empty, because a
   * thread with nothing to pin is worse than one with nothing to say.
   */
  private async mintInto(threadId: string): Promise<string> {
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    const row = getThread(this.db, threadId);
    const source = row ? this.inheritedSource(row) : null;
    // What the row remembers beats where a thread of its kind starts: a fork
    // the user has since flipped to auto is not put back in plan by an
    // adapter restart.
    const modeId = row?.mode_id ?? (source ? FORK_MODE_ID : DEFAULT_MODE_ID);
    const modelId = row?.model_id ?? null;
    let branched: string | null = null;
    if (source?.acp_session_id) {
      try {
        if (!(await this.hold(conn, source))) throw new Error(NOTHING_TO_FORK);
        branched = await this.mintAcpThread(conn, source.acp_session_id, modeId, modelId);
      } catch (err) {
        this.slog.warn('could not branch a fork again; starting it empty', {
          threadId,
          from: source.id,
          error: (err as Error).message,
        });
      }
    }
    const acpSessionId =
      branched ?? (await this.mintAcpThread(conn, null, modeId, modelId));
    setThreadAcpId(this.db, threadId, acpSessionId);
    this.slog.info('thread had no adapter conversation; minted one', {
      threadId,
      acpSessionId,
      forkedFrom: branched ? source?.id : null,
    });
    return acpSessionId;
  }

  /**
   * Makes sure this adapter holds one of the session's threads, log and all.
   * False when the adapter no longer has its transcript.
   *
   * What a fork needs of its source: the conversation it is about to copy.
   * A thread a browser has opened on this adapter is already held; one that
   * has only ever been looked at from the list is loaded here first.
   */
  private async hold(conn: ClientConnection, thread: ThreadRow): Promise<boolean> {
    if (!thread.acp_session_id) return false;
    if (this.live.has(thread.acp_session_id)) return true;
    return this.loadSession(conn, thread);
  }

  /** Removes a browser from the broadcast set, leaving the upstream running. */
  detach(handle: DownstreamHandle): void {
    this.downstreams.remove(handle);
    if (this.downstreams.size === 0) this.stopPolling();
    this.slog.info('downstream detached', { attached: this.downstreams.size });
  }

  /** This session's stored row. Throws once the session is gone. */
  private row(): SessionRow {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(this.sessionId) as SessionRow | undefined;
    if (!row) throw new Error(`Session ${this.sessionId} not found`);
    return row;
  }

  /**
   * Runs a `session/load` with that thread's replay marked as history rather
   * than news.
   *
   * Every load re-sends a conversation as ordinary notifications, which is
   * what makes replay and live streaming the same code path everywhere else —
   * and the one place that difference matters is background work, where a
   * five-hour-old tool call is not evidence of anything running now.
   *
   * Counted per thread, because a replay is about one conversation: a turn
   * starting on a second thread while this one rebuilds is the agent talking,
   * and has to be seen as such. `acpThreadId` is the id the updates being
   * replayed carry, which for a borrowed replay is the source's own.
   */
  private async whileReplaying<T>(acpThreadId: string, load: () => Promise<T>): Promise<T> {
    this.replaying.set(acpThreadId, (this.replaying.get(acpThreadId) ?? 0) + 1);
    try {
      return await load();
    } finally {
      const left = (this.replaying.get(acpThreadId) ?? 1) - 1;
      if (left > 0) this.replaying.set(acpThreadId, left);
      else this.replaying.delete(acpThreadId);
    }
  }

  /** Marks the session as active now, which holds off the reaper. */
  private touch(): void {
    touchSession(this.db, this.sessionId);
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
   * Forgets everything this session was in the middle of. None of the
   * callers leaves anything running: a deliberate stop, an adapter exit, the
   * session being closed.
   *
   * Both facts together, and the browsers told afterwards rather than
   * between, so a state published halfway through cannot claim a turn on a
   * thread that has just been cleared. What was running in the background
   * needs no forgetting: it is read from the container rather than
   * remembered, and an adapter that has gone took its children with it.
   */
  private clearThreadStates(): void {
    clearSessionTurns(this.db, this.sessionId);
    this.activity.clear();
    this.downstreams.refreshThreadStates();
  }

  /**
   * Brings up the container, the exec and the ACP session. Concurrent callers
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

  /** Starts the container and spawns the adapter, retrying with a backoff. */
  private async start(): Promise<void> {
    this.stopping = false;
    if (!this.row().container_id) throw new Error('Session has no container');

    // Awaited, and the row read after it: this may have rebuilt the container
    // the row named, and the id to start is the one it left behind.
    await this.beforeStart();
    // A repair that replaces the container stops this session's upstream,
    // which is this one. Said again, so the flag it set cannot make the spawn
    // below ignore its own exec exiting.
    this.stopping = false;
    const row = this.row();
    if (!row.container_id) throw new Error('Session has no container');

    await dk.startContainer(row.container_id);
    await dk.ensureProxyAttached(row.network_name, this.cfg);

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      if (this.abandoned) return;
      if (attempt > 0) {
        const wait = SPAWN_BACKOFF_MS[attempt - 1] ?? 8000;
        this.slog.warn('retrying adapter spawn', { attempt, waitMs: wait });
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        await this.spawnAndInitialize(row);
        // The stop arrived while this was coming up, so what it brought up
        // goes with it: the session was asked to be down, and the exec left
        // behind would answer for a box nobody is holding.
        if (this.abandoned) {
          this.teardownConnection();
          return;
        }
        this.onStatus('running');
        // A browser that stayed attached through a stop and start is still
        // watching, and the clock its bar goes away on was cleared with the
        // connection.
        this.pollWhileWatched();
        return;
      } catch (err) {
        lastError = err;
        this.slog.error('adapter spawn failed', { attempt, error: (err as Error).message });
        this.teardownConnection();
      }
    }
    if (this.abandoned) return;
    this.onStatus('error');
    throw new Error(
      `Adapter failed to start after ${MAX_SPAWN_ATTEMPTS} attempts: ${(lastError as Error)?.message}`,
    );
  }

  /**
   * Whether a start still in flight has been overtaken by a stop or a close.
   *
   * A spawn retries for twelve seconds, which is long enough for the session
   * to be stopped under it. What it would report then is about a box that is
   * already down, so it gives up quietly instead.
   */
  private get abandoned(): boolean {
    return this.stopping || this.closed;
  }

  /**
   * Spawns the adapter, performs the ACP handshake, and either replays the
   * stored thread or starts a fresh one.
   */
  private async spawnAndInitialize(row: SessionRow): Promise<void> {
    const cmd = JSON.parse(row.agent_cmd) as string[];
    const exec = await dk.spawnAdapterExec(row.container_id!, cmd, dk.WORKSPACE_DIR);
    this.exec = exec;

    // stderr is log-only: the adapter sends its console logging there to
    // keep stdout clean for protocol.
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
    const app = acpClient({ name: `boxes-${this.sessionId}` })
      .onNotification(ACP_METHOD.sessionUpdate as string, raw, ({ params }) => {
        this.onSessionUpdate(params);
      })
      .onRequest(ACP_METHOD.sessionRequestPermission as string, raw, ({ params }) =>
        this.onPermissionRequest(params),
      );

    const conn = app.connect(stream);
    this.conn = conn;

    // Empty capabilities: no fs, no terminal, no elicitation, which confines
    // client-bound traffic to the two methods handled above.
    this.initializeResponse = await conn.agent.request(ACP_METHOD.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    this.slog.info('adapter initialized', { workingDir: dk.WORKSPACE_DIR });

    await this.loadThreads(conn);
  }

  /**
   * Brings back every conversation this connection has to carry: the
   * session's current thread, and each thread a browser is watching.
   *
   * With two tabs on two threads, a respawn that loaded only the current one
   * would leave the other browser's next prompt naming a thread the adapter
   * has never heard of. The set is derived from the attached handles, so it
   * needs no storage and shrinks as tabs close.
   */
  private async loadThreads(conn: ClientConnection): Promise<void> {
    // The current thread first, because it is the one a session with no
    // threads at all has to be given.
    const thread = currentThread(this.db, this.sessionId) ?? null;
    const replayed = thread?.acp_session_id
      ? await this.loadSession(conn, thread)
      : false;
    if (!replayed) await this.mintCurrent(conn, thread);

    for (const acpThreadId of this.downstreams.watchedThreads) {
      // What this adapter already holds: the current thread above, and a
      // thread a second tab is watching as well.
      if (this.live.has(acpThreadId)) continue;
      // No row under that id either — the thread it named was re-minted, and
      // the browsers on it are pinned to the id it lost.
      const row = threadByAcpId(this.db, this.sessionId, acpThreadId);
      try {
        if (row?.acp_session_id && (await this.loadSession(conn, row))) continue;
      } catch (err) {
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
      this.dropWatchers(acpThreadId);
    }
  }

  /**
   * Loads a stored thread, reading its transcript into the thread's log.
   * Returns false when the adapter no longer holds it, which tells the caller
   * to start a fresh one.
   *
   * This is the one place the adapter's replay is asked for, and it runs on
   * a thread nothing else can reach yet — one this adapter has just been
   * spawned under, or one no browser is pinned to — so what the adapter says
   * meanwhile is the transcript and only the transcript. Everything a browser
   * is later sent of this thread comes from the log it fills.
   *
   * A missing thread is a legitimate state: the agent SDK writes a transcript
   * only once a prompt has run, so an id minted by session/new and never
   * prompted does not survive the container stopping. Any other error is
   * rethrown, which keeps a transient fault from discarding a live thread.
   */
  private async loadSession(conn: ClientConnection, thread: ThreadRow): Promise<boolean> {
    const acpSessionId = thread.acp_session_id!;
    this.downstreams.beginFill(acpSessionId);
    try {
      // The same `_meta` a fresh thread gets: a load is where the adapter
      // rebuilds the query for a conversation it no longer holds, which is
      // the other place these options are read.
      const res = (await this.whileReplaying(acpSessionId, () =>
        conn.agent.request(ACP_METHOD.sessionLoad, {
          sessionId: acpSessionId,
          cwd: dk.WORKSPACE_DIR,
          mcpServers: [],
          _meta: SESSION_META,
        }),
      )) as {
        modes?: SessionModeState | null;
        configOptions?: SessionConfigOption[] | null;
      } | null;
      this.downstreams.endFill(acpSessionId, optionsOf(res));
      this.live.add(acpSessionId);
      this.slog.info('acp session loaded', { threadId: thread.id, acpSessionId });
      // A load brings the conversation back and nothing else: the mode and the
      // model were the old process's, and this one starts in its own. Both are
      // put back from the row, which is why the row has them.
      await this.applyMode(
        conn,
        acpSessionId,
        res?.modes ?? null,
        thread.mode_id ?? DEFAULT_MODE_ID,
      );
      await this.applyModel(conn, acpSessionId, res?.configOptions ?? null, thread.model_id);
      return true;
    } catch (err) {
      this.downstreams.dropLog(acpSessionId);
      if (!isResourceNotFound(err)) throw err;
      this.live.delete(acpSessionId);
      this.slog.warn('stored thread is gone; starting a fresh one', {
        threadId: thread.id,
        acpSessionId,
        error: (err as Error).message,
      });
      // Only this thread's row loses its adapter id. The session's other
      // threads have transcripts of their own and are untouched.
      setThreadAcpId(this.db, thread.id, null);
      return false;
    }
  }

  /**
   * Mints an ACP thread and gives it the mode and model it is meant to have.
   *
   * `from` forks that thread's context instead of starting empty. `modeId`
   * and `modelId` are what to put the result in: a fork starts somewhere a
   * fresh thread does not, and a thread being minted again for a row that
   * already exists gets back what that row remembers. Both answers carry
   * `modes` and `configOptions`, so the same two steps apply either way.
   */
  private async mintAcpThread(
    conn: ClientConnection,
    from: string | null,
    modeId: string = DEFAULT_MODE_ID,
    modelId: string | null = null,
  ): Promise<string> {
    const method = from ? ACP_METHOD.sessionFork : ACP_METHOD.sessionNew;
    const res = (await conn.agent.request(method, {
      ...(from ? { sessionId: from } : {}),
      cwd: dk.WORKSPACE_DIR,
      mcpServers: [],
      _meta: SESSION_META,
    })) as {
      sessionId?: string;
      modes?: SessionModeState | null;
      configOptions?: SessionConfigOption[] | null;
    };
    if (!res?.sessionId) throw new Error(`${method} returned no sessionId`);
    this.live.add(res.sessionId);
    this.downstreams.openLog(res.sessionId, optionsOf(res), from ?? undefined);
    this.slog.info('acp session created', { method, acpSessionId: res.sessionId, from });
    await this.applyMode(conn, res.sessionId, res.modes ?? null, modeId);
    await this.applyModel(conn, res.sessionId, res.configOptions ?? null, modelId);
    return res.sessionId;
  }

  /**
   * Mints a fresh ACP thread for the session's current conversation: into the
   * existing row when the adapter has forgotten its thread, into a new row
   * when the session has no thread at all.
   *
   * An existing row goes through {@link mintInto}, so it keeps the mode and
   * model it remembers and, if it is a fork nobody has prompted, is branched
   * from its source again. Only a session with no thread at all starts from
   * the deployment's defaults, which is all a row that does not exist yet
   * could be given.
   */
  private async mintCurrent(conn: ClientConnection, thread: ThreadRow | null): Promise<void> {
    if (thread) {
      await this.mintInto(thread.id);
      return;
    }
    const acpSessionId = await this.mintAcpThread(conn, null);
    const created = insertThread(this.db, this.sessionId, acpSessionId);
    this.slog.info('first thread recorded', { threadId: created.id });
  }

  // --- threads --------------------------------------------------------------

  /**
   * The session's default conversation: what a connection naming no thread is
   * pinned to. Null before the session has one.
   */
  get current(): ThreadRow | null {
    return currentThread(this.db, this.sessionId) ?? null;
  }

  /**
   * Whether the adapter advertised the fork capability. It is unstable in the
   * ACP schema, so an adapter that does not offer it — or one that has not
   * been reached yet — is reported as not forkable rather than assumed.
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

  /**
   * Starts a fresh, empty conversation on the same workspace and makes it the
   * session's default. Nobody is moved onto it: a browser already watching
   * another thread keeps watching it, and the new one is opened by following
   * a link to it.
   */
  async newThread(): Promise<ThreadRow> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    const acpSessionId = await this.mintAcpThread(conn, null);
    const thread = insertThread(this.db, this.sessionId, acpSessionId);
    this.slog.info('new thread', { threadId: thread.id, ordinal: thread.ordinal });
    return thread;
  }

  /**
   * Branches one conversation into a second carrying its context, and makes
   * the new one the session's default. The source is left exactly as it was,
   * still streaming to whoever is watching it.
   *
   * A fork starts in `plan` mode rather than `auto`. It shares the source's
   * checkout, and the motion this exists for is asking a fork about work the
   * original is still doing — so a fork that decided to edit a file would
   * collide with a thread mid-turn, and neither agent can see the other doing
   * it. That does not fix the shared workspace; it stops the common accident,
   * and flipping the fork to `auto` is one tap in the header.
   */
  async forkThread(sourceThreadId: string): Promise<ThreadRow> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    const source = getThread(this.db, sourceThreadId);
    if (!source || source.session_id !== this.sessionId) {
      throw new Error(THREAD_NOT_FOUND);
    }
    if (!source.acp_session_id) throw new Error(NOTHING_TO_FORK);
    // The fork's log starts as a copy of the source's, so the source has to
    // have one: brought up here if no browser has opened it on this adapter.
    if (!(await this.hold(conn, source))) throw new Error(NOTHING_TO_FORK);
    const acpSessionId = await this.mintAcpThread(conn, source.acp_session_id, FORK_MODE_ID);
    // The source is recorded, not just used: until the fork is prompted the
    // adapter writes it no transcript, and the row is where its replay has to
    // come from meanwhile.
    const thread = insertThread(this.db, this.sessionId, acpSessionId, source.id);
    // Recorded, unlike a fresh thread's mode: a fresh thread is in the
    // deployment's default, which is what an empty column already means,
    // where a fork is somewhere the default would not put it back.
    setThreadMode(this.db, thread.id, FORK_MODE_ID);
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
      throw new Error(THREAD_NOT_FOUND);
    }
    this.db
      .prepare('UPDATE sessions SET current_thread_id = ? WHERE id = ?')
      .run(thread.id, this.sessionId);
    this.slog.info('thread selected', { threadId: thread.id });
    return thread;
  }

  /**
   * Closes the sockets of the browsers watching one thread, so each
   * reconnects from scratch and pins whatever that thread is now.
   *
   * The only caller is the respawn path, for a thread whose adapter id did
   * not survive. A connection is pinned to its own thread, so neither
   * switching the session's default nor adding a thread drops a browser.
   */
  private dropWatchers(acpThreadId: string): void {
    for (const handle of this.downstreams.byRecency(acpThreadId)) {
      try {
        handle.close();
      } catch (err) {
        this.slog.debug('downstream close failed', { error: (err as Error).message });
      }
    }
  }

  /**
   * Puts a thread in the mode it is meant to be in: the one recorded for it,
   * or this deployment's default when nothing is.
   *
   * Called on a thread the adapter has just minted and on one it has just
   * loaded back, because both arrive in whatever mode the adapter starts in.
   * A mode is the user's choice, and the thread's row is where that choice
   * outlives the process that was holding it.
   *
   * An adapter that does not offer the mode is left alone rather than argued
   * with, and so is one already in it.
   */
  private async applyMode(
    conn: ClientConnection,
    acpSessionId: string,
    modes: SessionModeState | null,
    modeId: string,
  ): Promise<void> {
    if (!modes?.availableModes?.some((mode) => mode.id === modeId)) return;
    if (modes.currentModeId === modeId) return;
    try {
      await conn.agent.request(ACP_METHOD.sessionSetMode, {
        sessionId: acpSessionId,
        modeId,
      });
      this.slog.info('thread put in its mode', { acpSessionId, modeId });
    } catch (err) {
      // A thread in the adapter's own mode is still usable, so this never
      // fails the spawn.
      this.slog.warn('could not set the mode', { error: (err as Error).message });
    }
  }

  /**
   * Puts a thread on the model it is meant to be on, on the same terms as
   * {@link applyMode}: the one recorded for it, or this deployment's default.
   *
   * The recorded model is matched the way {@link pickModel} matches any
   * other, so a thread left on `opus` comes back on `opus[1m]` where that is
   * the variant the adapter now lists. One the adapter no longer offers at
   * all falls back to the default, since model ids come and go.
   */
  private async applyModel(
    conn: ClientConnection,
    acpSessionId: string,
    configOptions: SessionConfigOption[] | null,
    modelId: string | null,
  ): Promise<void> {
    const selector = configOptions?.find((option) => option.category === 'model');
    if (!selector?.options) return;
    const value =
      (modelId ? pickModel(selector.options, modelId) : null) ??
      pickModel(selector.options, DEFAULT_MODEL_ID);
    if (!value || value === selector.currentValue) return;
    try {
      await conn.agent.request(ACP_METHOD.sessionSetConfigOption, {
        sessionId: acpSessionId,
        configId: selector.id,
        value,
      });
      this.slog.info('thread put on its model', { acpSessionId, modelId: value });
    } catch (err) {
      // A thread on the adapter's own model is still usable, so this never
      // fails the spawn.
      this.slog.warn('could not set the model', { error: (err as Error).message });
    }
  }

  /** ACP Stream over the demuxed exec: ndJSON in, ndJSON out. */
  private makeStream(exec: dk.AdapterExec): Stream {
    const readable = Readable.toWeb(exec.stdout) as ReadableStream<Uint8Array>;
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

  /** Taps an adapter update and delivers it to the browsers it is meant for. */
  private onSessionUpdate(params: unknown): void {
    this.touch();
    // Only what is happening now. A replay re-sends everything the thread
    // ever said, and a transcript arriving in a burst is not the agent
    // talking. Only that thread's own replay silences it, and the cost is a
    // turn starting on a thread while it rebuilds, which is a window of
    // milliseconds.
    const thread = threadOf(params);
    if (thread && !this.replaying.has(thread)) {
      const update = (params as { update?: unknown })?.update;
      this.activity.observe(thread, update);
    }
    this.recordThreadInfo(params);
    this.tap('up', ACP_METHOD.sessionUpdate, params);
    this.downstreams.update(params);
  }

  /**
   * Keeps a thread's row in step with what the adapter says about it: the
   * title the agent SDK generates at the end of a turn, the mode and model it
   * reports itself in, and when it was last heard from.
   *
   * The mode and model are here as well as on the request that set them
   * because the adapter changes them on its own too — leaving plan mode when
   * a plan is accepted, falling back to another model under load — and a
   * thread should come back in the mode it was in rather than the last one
   * somebody asked for.
   *
   * The three kinds below are the whole of what is recorded, and that is a
   * different list from the kinds `activity.ts` reads as the agent at work
   * and from the kinds the dashboard draws. A mode change is stored here and
   * is not the agent doing anything; a message chunk is the agent working and
   * is not stored, because the transcript is the adapter's.
   *
   * The row is found by the update's own ACP id rather than by which thread
   * is current, so an update that arrives while a switch is in flight lands
   * on the thread it is about.
   *
   * A replayed update does not count as the thread having been heard from:
   * it is the transcript being read back, so opening a thread would otherwise
   * move it to the top of the list for having been opened.
   */
  private recordThreadInfo(params: unknown): void {
    const acpSessionId = (params as { sessionId?: string })?.sessionId;
    if (!acpSessionId) return;
    const row = threadByAcpId(this.db, this.sessionId, acpSessionId);
    if (!row) return;
    if (!this.replaying.has(acpSessionId)) touchThread(this.db, row.id);

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
      case UPDATE_KIND.configOption: {
        // Which of them is the model is the option's category, not its id:
        // the id is the adapter's own and this deployment names none of them.
        const model = update.configOptions?.find((option) => option.category === 'model');
        if (typeof model?.currentValue === 'string') {
          setThreadModel(this.db, row.id, model.currentValue);
        }
        return;
      }
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
  private onPermissionRequest(params: unknown): Promise<unknown> {
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
        this.sessionId,
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
   * rather than only the box: with two threads live, "your session needs you"
   * is not enough to act on from a lock screen.
   *
   * Fire and forget: a turn already waiting on a human must not also wait on
   * a push service.
   */
  private announce(kind: NotifyKind, acpThreadId: string | null): void {
    const thread = acpThreadId
      ? threadByAcpId(this.db, this.sessionId, acpThreadId)
      : undefined;
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

  /**
   * Forwards a browser request to the adapter, tracking prompt turns.
   *
   * `from` is the browser that asked, which decides who a replay goes to and
   * lets a prompt be echoed to everyone watching.
   */
  async forwardRequest(
    method: string,
    params: unknown,
    from?: DownstreamHandle,
  ): Promise<unknown> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    this.tap('down', method, params);

    // Which conversation this is about, taken from the message itself: two
    // threads of one session share this connection, so nothing here may be
    // decided by which of them is the session's default.
    const thread = threadOf(params);
    const isPrompt = method === ACP_METHOD.sessionPrompt && thread !== undefined;
    const isLoad = method === ACP_METHOD.sessionLoad && thread !== undefined && from !== undefined;

    if (isPrompt) {
      // A fork's first prompt is where the adapter starts a transcript for
      // it, opening with everything the source had said. From here a restart
      // loads the fork back rather than branching its source again.
      const row = threadByAcpId(this.db, this.sessionId, thread);
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
      const result = await conn.agent.request(method, params);
      // A mode the adapter accepted is this thread's from now on, including
      // across the restarts that lose the adapter's copy of it. Recorded here
      // as well as from the adapter's own current_mode_update, because that
      // notification is the adapter's courtesy and this is the answer to the
      // request the user made.
      if (method === ACP_METHOD.sessionSetMode && thread !== undefined) {
        const modeId = (params as { modeId?: unknown })?.modeId;
        const row = threadByAcpId(this.db, this.sessionId, thread);
        if (row && typeof modeId === 'string') setThreadMode(this.db, row.id, modeId);
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
   * The nearest thread a fork can be branched from again, or null when there
   * is none: the first up its chain that has a transcript of its own.
   *
   * A fork of a fork inherits through the middle one: that thread has no
   * transcript either, so following the chain is what makes the second branch
   * carry the conversation both of them came from.
   */
  private inheritedSource(thread: ThreadRow): ThreadRow | null {
    let row: ThreadRow | undefined = thread;
    for (let hop = 0; hop < MAX_INHERIT_HOPS; hop++) {
      const next: string | null = row?.inherits_from ?? null;
      if (!next) return null;
      row = getThread(this.db, next);
      if (!row || row.session_id !== this.sessionId) return null;
      if (row.acp_session_id && !row.inherits_from) return row;
    }
    return null;
  }

  /** Forwards a browser notification to the adapter. */
  async forwardNotification(method: string, params: unknown): Promise<void> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error('Upstream not connected');
    this.tap('down', method, params);
    // Only the cancelled thread's turn ends. Another thread of the same
    // session may still be mid-turn.
    const thread = threadOf(params);
    if (method === ACP_METHOD.sessionCancel && thread) {
      this.setTurnActive(thread, false);
      // Whatever the agent was in the middle of saying, it is not saying it
      // any more. The tool calls it had open go with it.
      this.activity.reset(thread);
      this.downstreams.threadState(thread);
    }
    await conn.agent.notify(method, params);
  }

  /** Records one message in the debug log. A failed write never breaks the flow. */
  private tap(direction: 'up' | 'down', method: string, params: unknown): void {
    if (!log.wants('debug')) return;
    this.slog.debug('acp', {
      direction,
      method,
      payload: JSON.stringify(params, withoutMediaPayloads).slice(0, MAX_TAPPED_CHARS),
    });
  }

  /**
   * Drops the connection when the adapter exits on its own. The next forwarded
   * message calls ensureStarted, which re-spawns and re-issues session/load.
   */
  private handleExecExit(code: number | null): void {
    if (this.closed || this.stopping) return;
    this.slog.warn('adapter exec exited', { code });
    this.teardownConnection();
    this.clearThreadStates();
    // The adapter that asked them is gone, so no answer can reach it any
    // more. Left queued, each one holds its session out of the reaper and
    // shows a question nobody can answer.
    this.pending.failSession(this.sessionId, 'The agent adapter exited');
  }

  /** Closes the connection and kills the exec, tolerating either being gone. */
  private teardownConnection(): void {
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    this.conn = null;
    // A fresh adapter holds none of them, so the next pin brings its thread
    // back up rather than trusting an id this process never heard.
    this.live.clear();
    // The loads counted here belong to the connection going away. A count
    // left behind reads as a replay that never ends, and everything its
    // thread says afterwards is taken for history: no agent speaking, no
    // turn settling, and a row that is never touched again.
    this.replaying.clear();
    // A question this adapter asked cannot be answered any more, so the next
    // one a fresh adapter asks is news again.
    this.announcedApprovals.clear();
    try {
      this.exec?.kill();
    } catch {
      // already gone
    }
    this.exec = null;
  }

  /** Stops the connection deliberately, which suppresses the reconnect. */
  stop(): void {
    this.stopping = true;
    this.stopPolling();
    // Each one names a container this session may not have by the time it
    // fires, and reads the box it named.
    for (const timer of this.escalations) clearTimeout(timer);
    this.escalations.clear();
    // The box is going away, and what was in it went with it. Said now rather
    // than at the next reading, so a card does not carry "still running" over
    // the moment its session was shut down.
    this.background.clear();
    this.teardownConnection();
    this.clearThreadStates();
    this.pending.failSession(this.sessionId, 'Session stopped');
  }

  /** Stops the connection for good and forgets every attached browser. */
  close(): void {
    this.closed = true;
    this.stop();
    this.downstreams.clear();
  }

  /** Periodic housekeeping: keeps the debug log within its ring size. */
}
