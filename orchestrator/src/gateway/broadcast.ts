import { ACP_METHOD, UPDATE_KIND } from '../../../shared/acp.ts';
import {
  REPLAY_METHOD,
  TURN_STATE_METHOD,
  type ReplayParams,
  type TurnStateParams,
} from '../../../shared/types.ts';
import { log } from '../log.ts';
import { ThreadLog, type AdapterOptions } from './thread-log.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * Router of adapter updates to the browsers of one box, and the logs a
 * browser is sent when it opens a thread.
 *
 * Every rule is scoped to one thread. Each connection is pinned to a thread,
 * and each update names the thread it is about.
 */
export class Broadcast {
  /** Every attached browser, with or without a thread yet. */
  private readonly downstreams = new Set<DownstreamHandle>();
  /**
   * How many prompts the gateway is forwarding and has echoed itself, per
   * thread. While a thread's count is above zero, the gateway drops the
   * adapter's own echo of the prompt.
   */
  private readonly promptsInFlight = new Map<string, number>();
  /**
   * What each thread the adapter holds has said, by the adapter's id for it.
   *
   * A browser opening a thread is sent its log only. The adapter's replay is
   * read into the log once, when the thread is brought up.
   */
  private readonly logs = new Map<string, ThreadLog>();
  /**
   * The browser each thread's replay goes to, while the adapter replays the
   * full history for it.
   */
  private readonly relays = new Map<string, DownstreamHandle>();

  /**
   * @param boxId The box, for the log.
   * @param stateOf Everything a browser is told about a thread. The default
   *   fills in only whether a prompt is in flight.
   */
  constructor(
    private readonly boxId: string,
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
   * Adds a browser. Until its thread is resolved, it counts as attached but
   * nothing is routed to it.
   */
  add(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
  }

  /** Drops a browser. */
  remove(handle: DownstreamHandle): void {
    this.downstreams.delete(handle);
  }

  /** Forgets every browser, prompt count, log and relay. */
  clear(): void {
    this.downstreams.clear();
    this.promptsInFlight.clear();
    this.logs.clear();
    this.relays.clear();
  }

  /**
   * Routes one adapter update: into its thread's log, and on to the browsers
   * watching that thread.
   */
  update(params: unknown): void {
    const thread = threadOf(params);
    // An update that names no thread goes to nobody.
    if (!thread) return;
    const history = this.logs.get(thread);
    // A transcript being read into the log is sent to nobody.
    if (history?.filling) {
      history.append(params);
      return;
    }
    const relay = this.relays.get(thread);
    if (relay) {
      this.deliver([relay], params);
      return;
    }
    // The gateway has already echoed this prompt, so the adapter's echo
    // would show it twice.
    if (this.isPrompting(thread) && updateKind(params) === UPDATE_KIND.userMessageChunk) {
      return;
    }
    history?.append(params);
    // Logged even with nobody watching, for a browser that opens the thread
    // later.
    this.deliver(this.byRecency(thread), params);
  }

  /**
   * Starts reading a thread's transcript into a fresh log, which replaces any
   * earlier one. Until {@link endFill}, the thread's updates are logged and
   * sent to nobody.
   */
  beginFill(acpThreadId: string): void {
    const history = new ThreadLog();
    history.filling = true;
    this.logs.set(acpThreadId, history);
  }

  /** Ends the fill: the thread's updates are sent to its browsers again. */
  endFill(acpThreadId: string, options: AdapterOptions): void {
    const history = this.logs.get(acpThreadId);
    if (!history) return;
    history.filling = false;
    history.options = options;
  }

  /** Forgets a thread's log, for a thread the adapter does not hold. */
  dropLog(acpThreadId: string): void {
    this.logs.delete(acpThreadId);
  }

  /**
   * Opens a log for a thread the adapter has just minted.
   *
   * @param from The thread it was forked from, whose log the new one starts
   *   as a copy of. The adapter writes a fork no transcript until its first
   *   prompt.
   */
  openLog(acpThreadId: string, options: AdapterOptions, from?: string): void {
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
   * A `_boxes/replay` notification goes first. It says whether the updates
   * are a tail after the browser's anchor or the whole thread, and whether
   * the log still holds the start of the thread. A thread with no log is sent
   * as empty.
   *
   * @param anchor The last message the browser holds, if any.
   */
  open(handle: DownstreamHandle, acpThreadId: string, anchor?: string): AdapterOptions {
    const history = this.logs.get(acpThreadId);
    const opening = history?.opening(anchor) ?? {
      resumed: false,
      truncated: false,
      updates: [],
      options: { modes: null, configOptions: [] },
    };
    const params: ReplayParams = {
      sessionId: acpThreadId,
      resumed: opening.resumed,
      truncated: opening.truncated,
    };
    this.send([handle], REPLAY_METHOD, params);
    for (const update of opening.updates) this.deliver([handle], update);
    return opening.options;
  }

  /**
   * Sends a thread's updates to one browser only, until {@link endRelay}.
   * The browser is told first that the whole thread follows.
   *
   * This is for the adapter replaying the full history, which must not reach
   * the log or the other browsers.
   */
  beginRelay(handle: DownstreamHandle, acpThreadId: string): void {
    const params: ReplayParams = { sessionId: acpThreadId, resumed: false, truncated: false };
    this.send([handle], REPLAY_METHOD, params);
    this.relays.set(acpThreadId, handle);
  }

  /** Ends the relay: the thread's updates go to the log and its browsers again. */
  endRelay(acpThreadId: string): void {
    this.relays.delete(acpThreadId);
  }

  /** Whether the adapter is replaying a thread's full history to one browser. */
  isRelaying(acpThreadId: string): boolean {
    return this.relays.has(acpThreadId);
  }

  /**
   * Echoes a prompt to the browsers watching its thread and to the log, and
   * counts it as in flight.
   *
   * ACP does not require the adapter to echo a prompt live.
   */
  beginPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    const before = this.promptsInFlight.get(thread) ?? 0;
    this.promptsInFlight.set(thread, before + 1);
    // Only the first prompt in flight starts a turn.
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

  /** Counts a prompt on a thread as done, and sends the new state after the last one. */
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
   * Sends the browsers watching a thread its state.
   *
   * A browser cannot tell on its own that a turn it did not start is still
   * running, or that the thread has background work.
   */
  threadState(acpThreadId: string): void {
    this.send(this.byRecency(acpThreadId), TURN_STATE_METHOD, this.stateOf(acpThreadId));
  }

  /** Sends one browser the state of its thread, after it opens the thread. */
  threadStateTo(handle: DownstreamHandle): void {
    if (!handle.acpThreadId) return;
    this.send([handle], TURN_STATE_METHOD, this.stateOf(handle.acpThreadId));
  }

  /**
   * Sends the state of every watched thread again, for example after an
   * adapter exited or the box stopped.
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
        log.box(this.boxId).warn('broadcast failed', {
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
