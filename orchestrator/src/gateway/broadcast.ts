import { ACP_METHOD, UPDATE_KIND } from '../../../shared/acp.ts';
import {
  REPLAY_METHOD,
  TURN_STATE_METHOD,
  type ReplayParams,
  type TurnStateParams,
} from '../../../shared/types.ts';
import { log } from '../log.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * What a browser asked its replay to be picked up from, and how far the
 * replay has got towards it.
 */
interface ResumeState {
  /** The adapter's id for the last message that browser holds. */
  after: string;
  /** True once an update naming that message has come past. */
  found: boolean;
  /**
   * The updates held back while it has not.
   *
   * A resume point the replay never names cannot be honoured, and the
   * browser is owed the thread whole rather than a tail with a hole in front
   * of it. Holding them is what makes that answer available at the end.
   */
  held: unknown[];
}

/**
 * A browser one thread's replay is going to, and the thread id to put on what
 * it is sent. `as` is set only when the replay is borrowed — see beginReplay.
 */
interface ReplayTarget {
  handle: DownstreamHandle;
  as?: string;
  /** Set only when this replay is a resume — see beginReplay. */
  resume?: ResumeState;
  /** True once the browser has been told how its replay turned out. */
  settled: boolean;
}

/**
 * Who each adapter update goes to.
 *
 * Broadcasting everything to everyone is wrong in three places, all of which
 * need more than one browser attached to show up: a phone and a desktop on
 * one session, or two tabs on two threads of one box.
 *
 * Every rule here is scoped to a thread, because every rule is about one
 * conversation. A connection is pinned to a thread and an update carries the
 * thread it is about, so routing is a lookup rather than a guess: a replay of
 * one thread leaves another thread's live updates alone, and a prompt echoed
 * on one thread is not suppressed on another.
 */
export class Broadcast {
  private readonly downstreams = new Set<DownstreamHandle>();
  /**
   * Browsers a session/load is replaying to right now, by the thread being
   * replayed. While a thread has any, its updates go only to them: a replay
   * is by definition a re-send of history, so broadcasting it would duplicate
   * that thread into every other tab watching it.
   */
  private readonly replayTargets = new Map<string, Set<ReplayTarget>>();
  /**
   * How many prompts the gateway is forwarding and has echoed itself, per
   * thread. While a thread's count is above zero the gateway, not the
   * adapter, is the authority on what the user just said on it, so an adapter
   * that echoes the prompt back does not produce a second copy.
   */
  private readonly echoingPrompts = new Map<string, number>();

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

  /** Drops a browser, including from a replay it will never finish reading. */
  remove(handle: DownstreamHandle): void {
    this.downstreams.delete(handle);
    for (const [thread, targets] of this.replayTargets) {
      for (const target of targets) {
        if (target.handle === handle) targets.delete(target);
      }
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
      updateKind(params) === UPDATE_KIND.userMessageChunk
    ) {
      return;
    }
    // A replay goes to the browsers reading it and to nobody else, each
    // under the thread id it asked about — which is the source's own for an
    // ordinary replay, and the fork's for a borrowed one.
    if (replaying) {
      for (const target of replaying) this.replayTo(target, thread, params);
      return;
    }
    // With nobody on this thread the update is dropped rather than broadcast,
    // which is what stops a background thread's stream reaching the wrong tab.
    this.deliver(this.byRecency(thread), params);
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
    const before = this.echoingPrompts.get(thread) ?? 0;
    this.echoingPrompts.set(thread, before + 1);
    // The first prompt on a thread is what starts its turn; a second one
    // arriving while that runs does not start a second turn.
    if (before === 0) this.threadState(thread);
    const blocks = (params as { prompt?: unknown })?.prompt;
    if (!Array.isArray(blocks)) return;
    for (const content of blocks) {
      this.deliver(this.byRecency(thread), {
        sessionId: thread,
        update: { sessionUpdate: UPDATE_KIND.userMessageChunk, content },
      });
    }
  }

  /** Ends the window in which the gateway owns what the user said on a thread. */
  endPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    const left = (this.echoingPrompts.get(thread) ?? 0) - 1;
    if (left > 0) {
      this.echoingPrompts.set(thread, left);
      return;
    }
    this.echoingPrompts.delete(thread);
    this.threadState(thread);
  }

  /** Whether the gateway is carrying a prompt on a thread right now. */
  isPrompting(acpThreadId: string): boolean {
    return (this.echoingPrompts.get(acpThreadId) ?? 0) > 0;
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

  /** The same, to one browser: what a fresh connection is told after its replay. */
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

  /**
   * Starts routing one thread's updates to one browser only, for the length
   * of its replay. Another thread's updates are untouched, which is what lets
   * a second tab keep streaming while this one rebuilds.
   *
   * `as` re-tags what is replayed with another thread's id: a fork with no
   * transcript of its own is shown the source's, and the browser reading it
   * is pinned to the fork, so an update naming the source would be dropped as
   * some other conversation's.
   *
   * `resumeFrom` names the last message that browser holds. Everything the
   * replay says before that message is held back, so a reconnect costs the
   * tail rather than the conversation — see {@link settleReplay} for what
   * happens when the replay never names it.
   */
  beginReplay(
    handle: DownstreamHandle,
    acpThreadId: string,
    opts: { as?: string; resumeFrom?: string } = {},
  ): void {
    let targets = this.replayTargets.get(acpThreadId);
    if (!targets) {
      targets = new Set();
      this.replayTargets.set(acpThreadId, targets);
    }
    const target: ReplayTarget = {
      handle,
      as: opts.as,
      resume: opts.resumeFrom
        ? { after: opts.resumeFrom, found: false, held: [] }
        : undefined,
      settled: false,
    };
    targets.add(target);
    // A replay with no point to look for is whole from its first update, so
    // the browser can be told now. One that has a point to look for is told
    // when the point turns up, or at the end when it does not.
    if (!opts.resumeFrom) this.announce(target, acpThreadId, false);
  }

  /**
   * Sends one replayed update on, or holds it back while the browser is
   * waiting for the point it asked to resume from.
   *
   * The update that names the point goes out with the tail rather than being
   * held: the browser drops the message it names and takes it again from
   * here, which is what makes the result the model a whole replay would have
   * built.
   */
  private replayTo(target: ReplayTarget, acpThreadId: string, params: unknown): void {
    const shaped = target.as ? retag(params, target.as) : params;
    const resume = target.resume;
    if (resume && !resume.found) {
      if (messageOf(params) !== resume.after) {
        resume.held.push(shaped);
        return;
      }
      resume.found = true;
      resume.held = [];
      this.announce(target, acpThreadId, true);
    }
    this.deliver([target.handle], shaped);
  }

  /**
   * Says how a thread's replay turned out, once the adapter has sent all of
   * it.
   *
   * A resume point the replay never named is not honoured: the browser is
   * told the thread is coming whole, and everything held back for it goes out
   * behind that. Called before anything else the load leads to reaches that
   * browser — a borrowed replay, or the questions flushed when the load
   * answers — because a browser told to rebuild after those had arrived would
   * throw them away.
   */
  settleReplay(handle: DownstreamHandle, acpThreadId: string): void {
    const target = this.targetFor(handle, acpThreadId);
    if (!target || target.settled) return;
    this.announce(target, acpThreadId, false);
    const resume = target.resume;
    if (!resume) return;
    const held = resume.held;
    resume.found = true;
    resume.held = [];
    for (const params of held) this.deliver([target.handle], params);
  }

  /**
   * Tells one browser how its replay turned out, once.
   *
   * A borrowed replay says nothing of its own: it is the second half of a
   * load the browser has already been told about, and a second answer would
   * have it throw away what the first one brought.
   */
  private announce(target: ReplayTarget, acpThreadId: string, resumed: boolean): void {
    if (target.settled) return;
    target.settled = true;
    if (target.as) return;
    const params: ReplayParams = { sessionId: acpThreadId, resumed };
    this.send([target.handle], REPLAY_METHOD, params);
  }

  /** The replay one browser has open on a thread, or undefined for none. */
  private targetFor(
    handle: DownstreamHandle,
    acpThreadId: string,
  ): ReplayTarget | undefined {
    for (const target of this.replayTargets.get(acpThreadId) ?? []) {
      if (target.handle === handle) return target;
    }
    return undefined;
  }

  /**
   * Ends one of those, returning the thread to its watchers once the last one
   * is over.
   *
   * One target rather than every target of that browser: a browser with two
   * loads open on one thread ends them one at a time, and the second is still
   * replaying when the first comes back.
   */
  endReplay(handle: DownstreamHandle, acpThreadId: string): void {
    // A load that failed or was cut short still owes its browser the answer,
    // and whatever was held back waiting for it.
    this.settleReplay(handle, acpThreadId);
    const targets = this.replayTargets.get(acpThreadId);
    if (!targets) return;
    for (const target of targets) {
      if (target.handle === handle) {
        targets.delete(target);
        break;
      }
    }
    if (targets.size === 0) this.replayTargets.delete(acpThreadId);
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

/** The same update, said to be about another thread. */
function retag(params: unknown, acpThreadId: string): unknown {
  return { ...(params as Record<string, unknown>), sessionId: acpThreadId };
}

/** The ACP thread a message is about, or undefined when it names none. */
export function threadOf(params: unknown): string | undefined {
  const sessionId = (params as { sessionId?: unknown })?.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

/** The message a session/update belongs to, or undefined when it names none. */
function messageOf(params: unknown): string | undefined {
  const messageId = (params as { update?: { messageId?: unknown } })?.update?.messageId;
  return typeof messageId === 'string' && messageId ? messageId : undefined;
}

/** The kind of a session/update notification, or undefined for anything else. */
function updateKind(params: unknown): string | undefined {
  const update = (params as { update?: { sessionUpdate?: unknown } })?.update;
  return typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}
