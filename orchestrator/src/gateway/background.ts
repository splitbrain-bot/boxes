import { isTerminalStatus, parseTaskNotifications } from '../../../shared/task-notifications.ts';

/**
 * The background work one session has started and not seen finish, so the
 * idle reaper does not stop a box with work going on inside it.
 *
 * A turn that leaves something running in the background ends like any other:
 * the agent says it will report back, the thread goes quiet, and — with the
 * browser closed — every test the reaper makes says the session is idle. Half
 * an hour later the container is stopped, and with it the build, the crawl or
 * the monitor watching them. Nothing says so afterwards: the thread's last
 * line is still the agent promising to report, and the report never comes.
 *
 * Two things already cover some of this and neither covers it all. A
 * background *subagent* holds its turn open — the adapter defers the prompt's
 * result until the subagents it spawned settle — so the session counts as
 * running a turn for as long as one is alive. And a task that keeps talking
 * keeps its box awake by talking: every adapter update marks the session
 * active. What is left is the quiet task: a command compiling for two hours,
 * or a monitor watching a log that says nothing.
 *
 * So this watches the same updates the browsers get, and holds the reaper off
 * while it believes something is still running. Held off, not disabled: an
 * entry expires after `maxAgeMs` whatever happens, because both ends of this
 * are the harness's own conventions rather than anything ACP promises, and a
 * missed ending must cost a box that stops later than it should rather than
 * one that never stops at all.
 *
 * The state is deliberately in memory. A background task is a child of the
 * adapter, the adapter is a docker exec this process owns, and both die with
 * it — so an orchestrator that has forgotten a task is an orchestrator whose
 * task is already gone.
 */

/** Claude Code tools that run in the background whatever their input says. */
const ALWAYS_BACKGROUND = new Set(['Monitor', 'Workflow']);

export class BackgroundWork {
  /** When each live background call was started, by its tool call id. */
  private readonly live = new Map<string, number>();

  /**
   * @param maxAgeMs How long one entry may hold the reaper off.
   * @param now Present so a test can move time without waiting for it.
   */
  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reads one `session/update` for what it says about background work.
   *
   * Two things say it, and both are Claude Code's rather than ACP's: a tool
   * call whose input asks for the background or whose tool is only ever run
   * there, and the notification the harness sends when a task is over. An
   * adapter that says neither leaves this empty, which is the behaviour Boxes
   * had before any of it.
   */
  observe(update: unknown): void {
    if (!update || typeof update !== 'object') return;
    const u = update as {
      sessionUpdate?: string;
      toolCallId?: string;
      name?: string;
      rawInput?: unknown;
      content?: unknown;
      _meta?: { claudeCode?: { toolName?: string } };
    };

    switch (u.sessionUpdate) {
      case 'tool_call':
      case 'tool_call_update':
        // Only the first sighting of a call counts: the adapter re-announces
        // one as its input streams in, and replay sends every one again.
        if (u.toolCallId && !this.live.has(u.toolCallId) && startsBackgroundWork(u)) {
          this.live.set(u.toolCallId, this.now());
        }
        return;
      case 'user_message_chunk':
        this.settle(u);
        return;
      default:
        return;
    }
  }

  /** Drops the calls the notifications in this chunk say are finished. */
  private settle(update: { content?: unknown }): void {
    const content = update.content as { type?: string; text?: string } | undefined;
    if (content?.type !== 'text' || !content.text) return;
    const segments = parseTaskNotifications(content.text);
    if (!segments) return;

    for (const segment of segments) {
      if (segment.type !== 'notification') continue;
      const { toolUseId, status } = segment.notification;
      // Only a report that names its own call ends anything: a monitor's and
      // a subagent's name none, and guessing which entry a nameless one meant
      // would stop a box for the sake of tidying a map. Those expire instead.
      if (toolUseId && isTerminalStatus(status)) this.live.delete(toolUseId);
    }
  }

  /** Forgets everything, for a session whose adapter is gone. */
  clear(): void {
    this.live.clear();
  }

  /**
   * Whether this session is believed to have background work in it, which is
   * what holds the reaper off. Expired entries are dropped as it is asked.
   */
  get active(): boolean {
    const oldest = this.now() - this.maxAgeMs;
    for (const [toolCallId, started] of this.live) {
      if (started <= oldest) this.live.delete(toolCallId);
    }
    return this.live.size > 0;
  }
}

/** Whether a tool call leaves something running after the turn that made it. */
function startsBackgroundWork(update: {
  name?: string;
  rawInput?: unknown;
  _meta?: { claudeCode?: { toolName?: string } };
}): boolean {
  const input = update.rawInput;
  if (
    input &&
    typeof input === 'object' &&
    (input as { run_in_background?: unknown }).run_in_background === true
  ) {
    return true;
  }
  // The programmatic name, which this adapter carries in its own metadata and
  // a future one may carry where the ACP schema has it.
  const tool = update._meta?.claudeCode?.toolName ?? update.name;
  return typeof tool === 'string' && ALWAYS_BACKGROUND.has(tool);
}
