import { log } from '../log.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * Who each adapter update goes to.
 *
 * Broadcasting everything to everyone is almost right, and wrong in two
 * places that only show up with more than one browser attached — which is
 * the normal case for a phone and a desktop watching the same session.
 */
export class Broadcast {
  private readonly downstreams = new Set<DownstreamHandle>();
  /**
   * Browsers a session/load is replaying to right now. While this is
   * non-empty, updates go only to them: a replay is by definition a re-send
   * of history, so broadcasting it would duplicate the whole thread into
   * every other open tab.
   */
  private readonly replayTargets = new Set<DownstreamHandle>();
  /**
   * How many prompts the gateway is forwarding and has echoed itself. While
   * this is above zero the gateway, not the adapter, is the authority on what
   * the user just said, so an adapter that echoes the prompt back does not
   * produce a second copy of it.
   */
  private echoingPrompts = 0;

  constructor(private readonly sessionId: string) {}

  /** How many browsers are attached. */
  get size(): number {
    return this.downstreams.size;
  }

  /** Every attached browser, most recently active first. */
  get byRecency(): DownstreamHandle[] {
    return [...this.downstreams].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  add(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
  }

  /** Drops a browser, including from a replay it will never finish reading. */
  remove(handle: DownstreamHandle): void {
    this.downstreams.delete(handle);
    this.replayTargets.delete(handle);
  }

  clear(): void {
    this.downstreams.clear();
    this.replayTargets.clear();
  }

  /** Routes one adapter update to the browsers it is meant for. */
  update(params: unknown): void {
    // A prompt the gateway has already echoed: whatever the adapter says the
    // user said is the same thing, and sending it again would double it.
    // Replay is exempt, because there the adapter is reading back history
    // the gateway never saw.
    if (
      this.replayTargets.size === 0 &&
      this.echoingPrompts > 0 &&
      updateKind(params) === 'user_message_chunk'
    ) {
      return;
    }
    this.deliver(this.replayTargets.size > 0 ? this.replayTargets : this.downstreams, params);
  }

  /**
   * Tells every attached browser what was just prompted, and reports whether
   * the caller must undo it afterwards.
   *
   * The adapter is not required to echo a prompt live — it only has to
   * replay it later — so without this the browser that sent it sees nothing
   * until its next reload, and a second device sees nothing at all.
   */
  beginPrompt(params: unknown): void {
    this.echoingPrompts++;
    const blocks = (params as { prompt?: unknown })?.prompt;
    if (!Array.isArray(blocks)) return;
    const sessionId = (params as { sessionId?: string })?.sessionId;
    for (const content of blocks) {
      this.deliver(this.downstreams, {
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content },
      });
    }
  }

  /** Ends the window in which the gateway owns what the user said. */
  endPrompt(): void {
    this.echoingPrompts = Math.max(0, this.echoingPrompts - 1);
  }

  /** Starts routing updates to one browser only, for the length of its replay. */
  beginReplay(handle: DownstreamHandle): void {
    this.replayTargets.add(handle);
  }

  /** Ends that, returning to the broadcast. */
  endReplay(handle: DownstreamHandle): void {
    this.replayTargets.delete(handle);
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

/** The kind of a session/update notification, or undefined for anything else. */
function updateKind(params: unknown): string | undefined {
  const update = (params as { update?: { sessionUpdate?: unknown } })?.update;
  return typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}
