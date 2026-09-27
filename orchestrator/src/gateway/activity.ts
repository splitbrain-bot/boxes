import { UPDATE_KIND } from '../../../shared/acp.ts';
import { harness, type HarnessId } from '../harness.ts';
import { startsBackgroundWork, type ToolCallUpdate } from './background.ts';

/** Cancels a delayed call, and is safe to run after it has already fired. */
type Cancel = () => void;

/** Runs `fn` after `ms`. Injected, so a test can control time. */
export type Delay = (ms: number, fn: () => void) => Cancel;

/** The timer-based {@link Delay}, which never holds the process open. */
const realDelay: Delay = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Update kinds that show the agent at work.
 *
 * Other kinds, such as a mode change or the command list, are about the
 * thread and do not come from the agent. `user_message_chunk` counts, because
 * the agent has just been given a prompt or a task's report to work on.
 */
const AT_WORK = new Set<string>([
  UPDATE_KIND.userMessageChunk,
  UPDATE_KIND.agentMessageChunk,
  UPDATE_KIND.agentThoughtChunk,
  UPDATE_KIND.toolCall,
  UPDATE_KIND.toolCallUpdate,
  UPDATE_KIND.plan,
]);

/** Tool call statuses that mean the call is over. */
const FINISHED = new Set(['completed', 'failed']);

/** What is known about one thread. */
interface ThreadState {
  /** Whether the agent is producing output. */
  speaking: boolean;
  /** Foreground tool calls announced and not yet finished. */
  open: Set<string>;
  /** Cancels whichever timer is armed: the quiet one, or the settle one. */
  cancel: Cancel | null;
}

/**
 * Whether the agent is producing output on each thread.
 *
 * ACP has no notification that says the agent is done for now, so this reads
 * the stream instead. An update from the agent means it is working. Silence
 * for `quietMs` means it has stopped, unless a foreground tool call is still
 * open: a long test run emits nothing while it runs. A `usage_update` that
 * ends a processing cycle stops the thread at once, without a timer.
 */
export class Activity {
  /** What is known about each thread, by the adapter's thread id. */
  private readonly threads = new Map<string, ThreadState>();
  /**
   * Silence after which the UI shows the agent as stopped. An early flip only
   * shows a send button while the model thinks.
   */
  private readonly quietMs: number;
  /**
   * Silence after which a turn counts as finished for a push notification,
   * which cannot be taken back once sent.
   */
  private readonly settleMs: number;
  /** Schedules the quiet and settle timers. */
  private readonly delay: Delay;
  /** Runs on every change of a thread's speaking state. */
  private readonly onChange: (acpThreadId: string, speaking: boolean) => void;
  /** Runs once a thread has been quiet for `settleMs`. */
  private readonly onSettled: (acpThreadId: string) => void;

  /**
   * @param opts.onChange Runs on every transition, to tell the browsers watching.
   * @param opts.onSettled Runs once a thread has been quiet for `settleMs`, the
   *   point where a "turn finished" notification is worth sending.
   */
  constructor(opts: {
    quietMs: number;
    settleMs: number;
    onChange: (acpThreadId: string, speaking: boolean) => void;
    onSettled: (acpThreadId: string) => void;
    delay?: Delay;
  }) {
    this.quietMs = opts.quietMs;
    this.settleMs = opts.settleMs;
    this.onChange = opts.onChange;
    this.onSettled = opts.onSettled;
    this.delay = opts.delay ?? realDelay;
  }

  /** Whether the agent is producing output on this thread. */
  speaking(acpThreadId: string): boolean {
    return this.threads.get(acpThreadId)?.speaking === true;
  }

  /** The threads where the agent is producing output. */
  get speakingThreads(): string[] {
    return [...this.threads]
      .filter(([, state]) => state.speaking)
      .map(([thread]) => thread);
  }

  /**
   * Marks a thread as working because a prompt has just been forwarded on it.
   *
   * The browser that sent the prompt gets its spinner before the model's first
   * token arrives.
   */
  begin(acpThreadId: string): void {
    this.mark(acpThreadId);
  }

  /**
   * Reads one live `session/update` for what it says about the agent.
   *
   * The caller must not pass replayed updates: a replay would show the agent
   * working for as long as it takes.
   *
   * @param harnessId The harness whose adapter sent the update. It decides
   *   which tool names start background work.
   */
  observe(acpThreadId: string, update: unknown, harnessId: HarnessId): void {
    if (!update || typeof update !== 'object') return;
    const u = update as ToolCallUpdate & {
      sessionUpdate?: string;
      toolCallId?: string;
      status?: string;
      cost?: unknown;
    };
    // The end of a processing cycle also ends every open tool call.
    if (u.sessionUpdate === UPDATE_KIND.usage && endsCycle(u)) {
      this.stop(acpThreadId);
      return;
    }
    if (!u.sessionUpdate || !AT_WORK.has(u.sessionUpdate)) return;

    if (
      u.sessionUpdate === UPDATE_KIND.toolCall ||
      u.sessionUpdate === UPDATE_KIND.toolCallUpdate
    ) {
      this.track(acpThreadId, u, harnessId);
    }
    this.mark(acpThreadId);
  }

  /**
   * Follows one tool call, so that the silence while it runs does not count as
   * the agent having stopped.
   *
   * A call that starts background work is dropped from the open set, because
   * the agent does not wait for it.
   */
  private track(
    acpThreadId: string,
    call: ToolCallUpdate & { toolCallId?: string; status?: string },
    harnessId: HarnessId,
  ): void {
    if (!call.toolCallId) return;
    const state = this.state(acpThreadId);
    const alwaysBackground = harness(harnessId).alwaysBackground;
    if (FINISHED.has(call.status ?? '') || startsBackgroundWork(call, alwaysBackground)) {
      state.open.delete(call.toolCallId);
      return;
    }
    state.open.add(call.toolCallId);
  }

  /** Marks the agent as working on this thread and restarts the quiet timer. */
  private mark(acpThreadId: string): void {
    const state = this.state(acpThreadId);
    state.cancel?.();
    state.cancel = this.delay(this.quietMs, () => this.quiet(acpThreadId));
    if (state.speaking) return;
    state.speaking = true;
    this.onChange(acpThreadId, true);
  }

  /**
   * Marks the agent as stopped because the adapter said so. Clears the open
   * calls and the quiet timer, and arms the full settle timer.
   */
  private stop(acpThreadId: string): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel?.();
    state.cancel = null;
    state.open.clear();
    if (state.speaking) {
      state.speaking = false;
      this.onChange(acpThreadId, false);
    }
    this.armSettle(acpThreadId, this.settleMs);
  }

  /**
   * Runs after `quietMs` of silence. Restarts the wait while a tool call is
   * open, and otherwise marks the agent as stopped.
   */
  private quiet(acpThreadId: string): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel = null;
    if (state.open.size > 0) {
      state.cancel = this.delay(this.quietMs, () => this.quiet(acpThreadId));
      return;
    }
    if (!state.speaking) return;
    state.speaking = false;
    this.onChange(acpThreadId, false);
    // The settle timer counts from the last update, so it waits only for
    // the part of `settleMs` that is left.
    this.armSettle(acpThreadId, Math.max(this.settleMs - this.quietMs, 0));
  }

  /** Arms the timer that forgets a quiet thread and reports it as settled. */
  private armSettle(acpThreadId: string, ms: number): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel = this.delay(ms, () => {
      const current = this.threads.get(acpThreadId);
      if (!current || current.speaking) return;
      // A settled thread is in the same state as an unknown one.
      this.threads.delete(acpThreadId);
      this.onSettled(acpThreadId);
    });
  }

  /**
   * Forgets a thread without calling `onChange`. The caller publishes the new
   * state itself.
   */
  reset(acpThreadId: string): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel?.();
    this.threads.delete(acpThreadId);
  }

  /** Forgets every thread, for a box whose adapter is gone. */
  clear(): void {
    for (const state of this.threads.values()) state.cancel?.();
    this.threads.clear();
  }

  /** The state of one thread, created on first use. */
  private state(acpThreadId: string): ThreadState {
    let state = this.threads.get(acpThreadId);
    if (!state) {
      state = { speaking: false, open: new Set(), cancel: null };
      this.threads.set(acpThreadId, state);
    }
    return state;
  }
}

/**
 * Whether a `usage_update` is the one the adapter sends at the end of a
 * processing cycle.
 *
 * Only that update carries a `cost`. The updates sent while a message streams
 * carry only token counts. Codex sends no such update, so its threads rely on
 * the timers.
 */
function endsCycle(update: { cost?: unknown }): boolean {
  return typeof update.cost === 'object' && update.cost !== null;
}
