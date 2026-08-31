import { log } from '../log.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * Who each adapter update goes to.
 *
 * Broadcasting everything to everyone is almost right, and wrong in three
 * places that only show up with more than one browser attached — which is the
 * normal case for a phone and a desktop watching the same session, and now
 * also for two tabs on two threads of one box.
 *
 * Every rule here is scoped to a thread, because every rule is about one
 * conversation. A connection is pinned to a thread and an update carries the
 * thread it is about, so routing is a lookup rather than a guess: a replay of
 * one thread no longer silences another thread's live updates, and a prompt
 * echoed on one thread is not suppressed on another.
 */
export class Broadcast {
  private readonly downstreams = new Set<DownstreamHandle>();
  /**
   * Browsers a session/load is replaying to right now, by the thread being
   * replayed. While a thread has any, its updates go only to them: a replay
   * is by definition a re-send of history, so broadcasting it would duplicate
   * that thread into every other tab watching it.
   */
  private readonly replayTargets = new Map<string, Set<DownstreamHandle>>();
  /**
   * How many prompts the gateway is forwarding and has echoed itself, per
   * thread. While a thread's count is above zero the gateway, not the
   * adapter, is the authority on what the user just said on it, so an adapter
   * that echoes the prompt back does not produce a second copy.
   */
  private readonly echoingPrompts = new Map<string, number>();

  constructor(private readonly sessionId: string) {}

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

  /** Every attached browser, whichever thread it watches. */
  get all(): DownstreamHandle[] {
    return [...this.downstreams];
  }

  /**
   * Adds a browser. Its thread may still be resolving, in which case it is
   * counted as attached — it is holding a socket open — but nothing is routed
   * to it until it has one.
   */
  add(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
  }

  /** Drops a browser, including from a replay it will never finish reading. */
  remove(handle: DownstreamHandle): void {
    this.downstreams.delete(handle);
    for (const [thread, targets] of this.replayTargets) {
      targets.delete(handle);
      if (targets.size === 0) this.replayTargets.delete(thread);
    }
  }

  clear(): void {
    this.downstreams.clear();
    this.replayTargets.clear();
    this.echoingPrompts.clear();
  }

  /** Routes one adapter update to the browsers watching the thread it is about. */
  update(params: unknown): void {
    const thread = threadOf(params);
    // An update that names no thread cannot be routed. Broadcasting it to
    // everyone is what this class exists to stop.
    if (!thread) return;

    const replaying = this.replayTargets.get(thread);
    // A prompt the gateway has already echoed on this thread: whatever the
    // adapter says the user said is the same thing, and sending it again
    // would double it. Replay is exempt, because there the adapter is reading
    // back history the gateway never saw.
    if (
      !replaying &&
      (this.echoingPrompts.get(thread) ?? 0) > 0 &&
      updateKind(params) === 'user_message_chunk'
    ) {
      return;
    }
    // With nobody on this thread the update is dropped rather than broadcast,
    // which is what stops a background thread's stream reaching the wrong tab.
    this.deliver(replaying ?? this.byRecency(thread), params);
  }

  /**
   * Tells the browsers watching a thread what was just prompted on it, and
   * opens the window in which the gateway owns what the user said.
   *
   * The adapter is not required to echo a prompt live — it only has to replay
   * it later — so without this the browser that sent it sees nothing until
   * its next reload, and a second device on the same thread sees nothing at
   * all.
   */
  beginPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    this.echoingPrompts.set(thread, (this.echoingPrompts.get(thread) ?? 0) + 1);
    const blocks = (params as { prompt?: unknown })?.prompt;
    if (!Array.isArray(blocks)) return;
    for (const content of blocks) {
      this.deliver(this.byRecency(thread), {
        sessionId: thread,
        update: { sessionUpdate: 'user_message_chunk', content },
      });
    }
  }

  /** Ends the window in which the gateway owns what the user said on a thread. */
  endPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    const left = (this.echoingPrompts.get(thread) ?? 0) - 1;
    if (left > 0) this.echoingPrompts.set(thread, left);
    else this.echoingPrompts.delete(thread);
  }

  /**
   * Starts routing one thread's updates to one browser only, for the length
   * of its replay. Another thread's updates are untouched, which is what lets
   * a second tab keep streaming while this one rebuilds.
   */
  beginReplay(handle: DownstreamHandle, acpThreadId: string): void {
    let targets = this.replayTargets.get(acpThreadId);
    if (!targets) {
      targets = new Set();
      this.replayTargets.set(acpThreadId, targets);
    }
    targets.add(handle);
  }

  /** Ends that, returning the thread to its watchers. */
  endReplay(handle: DownstreamHandle, acpThreadId: string): void {
    const targets = this.replayTargets.get(acpThreadId);
    if (!targets) return;
    targets.delete(handle);
    if (targets.size === 0) this.replayTargets.delete(acpThreadId);
  }

  /** Sends one update to a set of browsers, surviving any one of them failing. */
  private deliver(targets: Iterable<DownstreamHandle>, params: unknown): void {
    for (const d of targets) {
      try {
        d.notify('session/update', params);
      } catch (err) {
        log.session(this.sessionId).warn('broadcast failed', {
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
