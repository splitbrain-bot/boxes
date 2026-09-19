import { ACP_METHOD, UPDATE_KIND } from '../../../shared/acp.ts';
import {
  REPLAY_METHOD,
  TURN_STATE_METHOD,
  type ReplayParams,
  type TurnStateParams,
} from '../../../shared/types.ts';
import { log } from '../log.ts';
import { ThreadLog, type ThreadOptions } from './thread-log.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * Who each adapter update goes to, and what a browser is sent when it opens
 * a thread.
 *
 * Broadcasting everything to everyone is wrong in two places, both of which
 * need more than one browser attached to show up: a phone and a desktop on
 * one session, or two tabs on two threads of one box.
 *
 * Every rule here is scoped to a thread, because every rule is about one
 * conversation. A connection is pinned to a thread and an update carries the
 * thread it is about, so routing is a lookup rather than a guess: a prompt
 * echoed on one thread is not suppressed on another, and a thread being read
 * into its log leaves another thread's live updates alone.
 */
export class Broadcast {
  private readonly downstreams = new Set<DownstreamHandle>();
  /**
   * How many prompts the gateway is forwarding and has echoed itself, per
   * thread. While a thread's count is above zero the gateway, not the
   * adapter, is the authority on what the user just said on it, so an adapter
   * that echoes the prompt back does not produce a second copy.
   */
  private readonly promptsInFlight = new Map<string, number>();
  /**
   * What each thread the adapter holds has said, by the adapter's id for it.
   *
   * A browser opening a thread is sent this and nothing else — see
   * {@link open}. The adapter's own replay never reaches a browser: it is
   * read once into the log, when the thread is brought up, and a browser's
   * `session/load` is answered from here without asking the adapter again.
   */
  private readonly logs = new Map<string, ThreadLog>();

  /**
   * @param stateOf Everything a browser is told about a thread. The gateway
   *   supplies it, because two thirds of it — whether the agent is speaking,
   *   and what it left running in the background — are known upstream of this
   *   class. The default is the part this class knows on its own, which is
   *   what a test about routing wants.
   */
  constructor(
    private readonly sessionId: string,
    private readonly stateOf: (acpThreadId: string) => TurnStateParams = (acpThreadId) => ({
      sessionId: acpThreadId,
      active: this.isPrompting(acpThreadId),
      speaking: false,
      background: [],
    }),
  ) {}

  /** How many browsers are attached, across every thread. */
  get size(): number {
    return this.downstreams.size;
  }

  /** The ACP threads at least one browser is watching. */
  get watchedThreads(): string[] {
    const threads = new Set<string>();
    for (const d of this.downstreams) {
      if (d.acpThreadId) threads.add(d.acpThreadId);
    }
    return [...threads];
  }

  /** Browsers watching one thread, most recently active first. */
  byRecency(acpThreadId: string): DownstreamHandle[] {
    return [...this.downstreams]
      .filter((d) => d.acpThreadId === acpThreadId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Adds a browser. Its thread may still be resolving, in which case it is
   * counted as attached — it is holding a socket open — but nothing is routed
   * to it until it has one.
   */
  add(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
  }

  /** Drops a browser. */
  remove(handle: DownstreamHandle): void {
    this.downstreams.delete(handle);
  }

  clear(): void {
    this.downstreams.clear();
    this.promptsInFlight.clear();
    this.logs.clear();
  }

  /**
   * Routes one adapter update: into its thread's log, and on to the browsers
   * watching that thread.
   */
  update(params: unknown): void {
    const thread = threadOf(params);
    // An update that names no thread cannot be routed. Broadcasting it to
    // everyone is what this class exists to stop.
    if (!thread) return;
    const history = this.logs.get(thread);
    // The transcript being read back into the log. Nobody is sent it:
    // whoever opens the thread is sent the log instead, once it is whole.
    if (history?.filling) {
      history.append(params);
      return;
    }
    // A prompt the gateway has already echoed on this thread: whatever the
    // adapter says the user said is the same thing, and sending it again
    // would double it.
    if (this.isPrompting(thread) && updateKind(params) === UPDATE_KIND.userMessageChunk) {
      return;
    }
    history?.append(params);
    // With nobody on this thread the update is delivered to no one rather
    // than broadcast, which is what stops a background thread's stream
    // reaching the wrong tab. It is logged all the same: the reconnect the
    // log is for is a browser that was away while the turn ran.
    this.deliver(this.byRecency(thread), params);
  }

  /**
   * Starts reading a thread's transcript into a fresh log. Until
   * {@link endFill}, the thread's updates are logged and sent to nobody.
   *
   * Fresh rather than added to, because the transcript is the whole of what
   * the thread has said: whatever an earlier log of it held, the adapter is
   * about to say again.
   */
  beginFill(acpThreadId: string): void {
    const history = new ThreadLog();
    history.filling = true;
    this.logs.set(acpThreadId, history);
  }

  /** The transcript has all been read; the thread's updates are live again. */
  endFill(acpThreadId: string, options: ThreadOptions): void {
    const history = this.logs.get(acpThreadId);
    if (!history) return;
    history.filling = false;
    history.options = options;
  }

  /** Forgets a thread's log, because the adapter turned out not to hold it. */
  dropLog(acpThreadId: string): void {
    this.logs.delete(acpThreadId);
  }

  /**
   * Opens a log for a thread the adapter has just minted.
   *
   * `from` names the thread it was forked from, whose log becomes the start
   * of this one: the fork carries that conversation, and until it is first
   * prompted the adapter has no transcript of its own to say so.
   */
  openLog(acpThreadId: string, options: ThreadOptions, from?: string): void {
    const history = new ThreadLog();
    history.options = options;
    const source = from ? this.logs.get(from) : undefined;
    if (source) history.copyFrom(source, acpThreadId);
    this.logs.set(acpThreadId, history);
  }

  /**
   * Sends one browser a thread, and returns the answer to the `session/load`
   * it asked with.
   *
   * `anchor` is the last message the browser holds, when it has one. The
   * browser is told first whether it is being sent a tail to fold onto what
   * it has or the thread whole to replace it — `_boxes/replay` — because
   * nothing in the updates that follow tells the two apart, and a browser
   * that finds out afterwards has to throw away what it was just sent.
   *
   * A thread with no log is one the adapter never brought up here, and is
   * sent as empty rather than refused: the browser asked to open a thread,
   * and what there is of it is nothing.
   */
  open(handle: DownstreamHandle, acpThreadId: string, anchor?: string): ThreadOptions {
    const history = this.logs.get(acpThreadId);
    const opening = history?.opening(anchor) ?? {
      resumed: false,
      updates: [],
      options: { modes: null, configOptions: [] },
    };
    const params: ReplayParams = { sessionId: acpThreadId, resumed: opening.resumed };
    this.send([handle], REPLAY_METHOD, params);
    for (const update of opening.updates) this.deliver([handle], update);
    return opening.options;
  }

  /**
   * Tells the browsers watching a thread what was just prompted on it, and
   * opens the window in which the gateway owns what the user said.
   *
   * The adapter is not required to echo a prompt live — it only has to replay
   * it later — so without this the browser that sent it sees nothing until
   * its next reload, and a second device on the same thread sees nothing at
   * all. The echo is logged like anything else a watcher is sent, so a
   * browser opening the thread later sees the prompt where it was made.
   */
  beginPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    const before = this.promptsInFlight.get(thread) ?? 0;
    this.promptsInFlight.set(thread, before + 1);
    // The first prompt on a thread is what starts its turn; a second one
    // arriving while that runs does not start a second turn.
    if (before === 0) this.threadState(thread);
    const blocks = (params as { prompt?: unknown })?.prompt;
    if (!Array.isArray(blocks)) return;
    for (const content of blocks) {
      const echo = {
        sessionId: thread,
        update: { sessionUpdate: UPDATE_KIND.userMessageChunk, content },
      };
      this.logs.get(thread)?.append(echo);
      this.deliver(this.byRecency(thread), echo);
    }
  }

  /** Ends the window in which the gateway owns what the user said on a thread. */
  endPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    const left = (this.promptsInFlight.get(thread) ?? 0) - 1;
    if (left > 0) {
      this.promptsInFlight.set(thread, left);
      return;
    }
    this.promptsInFlight.delete(thread);
    this.threadState(thread);
  }

  /** Whether the gateway is carrying a prompt on a thread right now. */
  isPrompting(acpThreadId: string): boolean {
    return (this.promptsInFlight.get(acpThreadId) ?? 0) > 0;
  }

  /**
   * Tells the browsers watching a thread what it is doing.
   *
   * The one thing a browser cannot work out for itself: a turn it did not
   * start, on a thread it has only just re-opened, is indistinguishable from
   * a finished one until somebody says — and so is a monitor left running in
   * the box an hour ago. See TURN_STATE_METHOD.
   */
  threadState(acpThreadId: string): void {
    this.send(this.byRecency(acpThreadId), TURN_STATE_METHOD, this.stateOf(acpThreadId));
  }

  /** The same, to one browser: what a fresh connection is told after it opens a thread. */
  threadStateTo(handle: DownstreamHandle): void {
    if (!handle.acpThreadId) return;
    this.send([handle], TURN_STATE_METHOD, this.stateOf(handle.acpThreadId));
  }

  /**
   * Re-states every watched thread, for whoever has just changed something
   * true of all of them — an adapter that exited, a session stopping.
   */
  refreshThreadStates(): void {
    for (const thread of this.watchedThreads) this.threadState(thread);
  }

  /** Sends one update to a set of browsers, surviving any one of them failing. */
  private deliver(targets: Iterable<DownstreamHandle>, params: unknown): void {
    this.send(targets, ACP_METHOD.sessionUpdate, params);
  }

  /** Sends one notification to a set of browsers, surviving any one failing. */
  private send(targets: Iterable<DownstreamHandle>, method: string, params: unknown): void {
    for (const d of targets) {
      try {
        d.notify(method, params);
      } catch (err) {
        log.session(this.sessionId).warn('broadcast failed', {
          method,
          error: (err as Error).message,
        });
      }
    }
  }
}

/** The ACP thread a message is about, or undefined when it names none. */
export function threadOf(params: unknown): string | undefined {
  const sessionId = (params as { sessionId?: unknown })?.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

/** The kind of a session/update notification, or undefined for anything else. */
function updateKind(params: unknown): string | undefined {
  const update = (params as { update?: { sessionUpdate?: unknown } })?.update;
  return typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}
