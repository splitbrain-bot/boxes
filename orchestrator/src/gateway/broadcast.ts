import { ACP_METHOD, UPDATE_KIND } from '../../../shared/acp.ts';
import {
  REPLAY_METHOD,
  type ReplayParams,
  type ThreadConfigOption,
  TURN_STATE_METHOD,
  type TurnStateParams,
} from '../../../shared/types.ts';
import { log } from '../log.ts';
import { type AdapterOptions, ThreadLog } from './thread-log.ts';
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
   * The number of prompts that the gateway forwards and has echoed itself, per
   * thread. While a thread's count is above zero, the gateway drops the
   * adapter's own echo of the prompt.
   */
  private readonly promptsInFlight = new Map<string, number>();
  /**
   * The log of each thread that the adapter holds, by the adapter's id for the thread.
   *
   * A browser that opens a thread gets only the log. The adapter's replay goes into the log once, when the thread
   * comes up.
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

  /** Number of attached browsers, across every thread. */
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

  /**
   * The browsers watching one thread.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @returns The browsers, most recently active first.
   */
  byRecency(acpThreadId: string): DownstreamHandle[] {
    return [...this.downstreams]
      .filter((d) => d.acpThreadId === acpThreadId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Adds a browser. Until its thread is resolved, it counts as attached but
   * nothing is routed to it.
   *
   * @param handle The browser connection.
   */
  add(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
  }

  /**
   * Drops a browser.
   *
   * @param handle The browser connection.
   */
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
   * Routes one adapter update into its thread's log, and on to the browsers
   * watching that thread.
   *
   * @param params The params of the `session/update` notification.
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
    // Logged even with nobody watching, for a browser that opens the thread later.
    history?.append(params);
    this.deliver(this.byRecency(thread), params);
  }

  /**
   * Starts reading a thread's transcript into a fresh log, which replaces any
   * earlier one. Until {@link Broadcast.endFill}, the thread's updates are logged and
   * sent to nobody.
   *
   * @param acpThreadId The adapter's id for the thread.
   */
  beginFill(acpThreadId: string): void {
    const history = new ThreadLog();
    history.filling = true;
    this.logs.set(acpThreadId, history);
  }

  /**
   * Ends the fill and stores the adapter options. The thread's updates go to its browsers again.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @param options The modes and options the adapter answered the load with.
   */
  endFill(acpThreadId: string, options: AdapterOptions): void {
    const history = this.logs.get(acpThreadId);
    if (!history) return;
    history.filling = false;
    history.options = options;
  }

  /**
   * Forgets a thread's log, for a thread the adapter does not hold.
   *
   * @param acpThreadId The adapter's id for the thread.
   */
  dropLog(acpThreadId: string): void {
    this.logs.delete(acpThreadId);
  }

  /**
   * Sets the current mode in a thread's log.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @param modeId The mode that is now current.
   * @returns The mode that was current before, or null when the log has none.
   */
  logMode(acpThreadId: string, modeId: string): string | null {
    return this.logs.get(acpThreadId)?.setMode(modeId) ?? null;
  }

  /**
   * The current mode in a thread's log.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @returns The mode, or null when the log has none.
   */
  modeOf(acpThreadId: string): string | null {
    return this.logs.get(acpThreadId)?.options.modes?.currentModeId ?? null;
  }

  /**
   * Sets one option's value in a thread's log.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @param configId The option's id.
   * @param value The value it is now set to.
   * @param answered The options the adapter answered the change with, if any.
   */
  logConfig(
    acpThreadId: string,
    configId: string,
    value: string,
    answered?: ThreadConfigOption[],
  ): void {
    this.logs.get(acpThreadId)?.setConfig(configId, value, answered);
  }

  /**
   * Opens a log for a thread the adapter has just minted.
   *
   * @param acpThreadId The adapter's id for the new thread.
   * @param options The modes and options the adapter answered with.
   * @param from The thread that the new thread is a fork of. The new log starts as a copy of its log, because the
   *   adapter writes no transcript for a fork until its first prompt.
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
   * @param handle The browser connection.
   * @param acpThreadId The adapter's id for the thread.
   * @param anchor The last message the browser holds, if any.
   * @returns The modes and options for the answer to the load.
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
   * Sends a thread's updates to one browser only, until {@link Broadcast.endRelay}.
   * The browser is told first that the whole thread follows.
   *
   * The adapter replays the full history through the relay, so the history does not reach the log or the other
   * browsers.
   *
   * @param handle The browser that gets the replay.
   * @param acpThreadId The adapter's id for the thread.
   */
  beginRelay(handle: DownstreamHandle, acpThreadId: string): void {
    const params: ReplayParams = { sessionId: acpThreadId, resumed: false, truncated: false };
    this.send([handle], REPLAY_METHOD, params);
    this.relays.set(acpThreadId, handle);
  }

  /**
   * Ends the relay. The thread's updates go to the log and its browsers again.
   *
   * @param acpThreadId The adapter's id for the thread.
   */
  endRelay(acpThreadId: string): void {
    this.relays.delete(acpThreadId);
  }

  /**
   * Checks if the adapter replays a thread's full history to one browser.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @returns True while the relay runs.
   */
  isRelaying(acpThreadId: string): boolean {
    return this.relays.has(acpThreadId);
  }

  /**
   * Echoes a prompt to the browsers watching its thread and to the log, and
   * counts it as in flight.
   *
   * ACP does not require the adapter to echo a prompt live.
   *
   * @param params The params of the `session/prompt` request.
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

  /**
   * Counts a prompt on a thread as done, and sends the new state after the last one.
   *
   * @param params The params of the `session/prompt` request.
   */
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

  /**
   * Checks if the gateway carries a prompt on a thread.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @returns True while a prompt is in flight.
   */
  isPrompting(acpThreadId: string): boolean {
    return (this.promptsInFlight.get(acpThreadId) ?? 0) > 0;
  }

  /**
   * Sends the browsers watching a thread its state.
   *
   * A browser cannot tell on its own that a turn it did not start is still
   * running, or that the thread has background work.
   *
   * @param acpThreadId The adapter's id for the thread.
   */
  threadState(acpThreadId: string): void {
    this.send(this.byRecency(acpThreadId), TURN_STATE_METHOD, this.stateOf(acpThreadId));
  }

  /**
   * Sends one browser the state of its thread, after it opens the thread.
   *
   * @param handle The browser connection.
   */
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

  /**
   * Sends one update to a set of browsers, surviving any one of them failing.
   *
   * @param targets The browsers.
   * @param params The params of the `session/update` notification.
   */
  private deliver(targets: Iterable<DownstreamHandle>, params: unknown): void {
    this.send(targets, ACP_METHOD.sessionUpdate, params);
  }

  /**
   * Sends one notification to a set of browsers, surviving any one failing.
   *
   * @param targets The browsers.
   * @param method The method of the notification.
   * @param params The params of the notification.
   */
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

/**
 * The ACP thread a message is about.
 *
 * @param params The params of the message.
 * @returns The adapter's id for the thread, or undefined when the message names none.
 */
export function threadOf(params: unknown): string | undefined {
  const sessionId = (params as { sessionId?: unknown })?.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

/**
 * The kind of a session/update notification.
 *
 * @param params The params of the message.
 * @returns The update kind, or undefined for anything else.
 */
function updateKind(params: unknown): string | undefined {
  const update = (params as { update?: { sessionUpdate?: unknown } })?.update;
  return typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}
