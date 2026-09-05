/**
 * The block the harness wakes an agent with when a background task reports in.
 *
 * A task started in the background — a command left running, a subagent, a
 * monitor watching something — does not answer into the turn that started it.
 * It reports later, and the way it reports is that the harness wakes the agent
 * with a message in the *user's* role carrying a block of XML:
 *
 *     <task-notification>
 *     <task-id>bnztwmmw5</task-id>
 *     <summary>Monitor event: "crawl progress"</summary>
 *     <event>2200/30321 ok=2193 bad=7 — rate limited, pausing 61s</event>
 *     </task-notification>
 *
 * Which is addressed to the model and is not the user speaking. Both sides of
 * Boxes have to read it, for different reasons — the dashboard draws it as a
 * row instead of a bubble (dashboard/src/lib/task-notifications.ts), and the
 * orchestrator counts what is still running so the idle reaper does not stop a
 * box with work in it (orchestrator/src/gateway/background.ts) — so the format
 * is described once, here, rather than in two places that would drift.
 *
 * It travels as text, which is what makes it readable at all: text is the one
 * thing that survives an adapter's transcript unchanged, so what is read back
 * on replay is exactly what was sent, and one parser serves both the live
 * stream and the reconnect. Same bargain as the attachment envelope in
 * dashboard/src/lib/attachments.ts.
 *
 * Tolerant by design. A block this build cannot make sense of is left as the
 * text it is, because showing the XML is a much better failure than dropping
 * what a task said. The one shape not handled is a notification the harness
 * wrapped in a `<system-reminder>`, which is how the CLI's own transcript
 * carries them: the notification inside is still read, and the wrapper's own
 * lines stay as text around it. Over ACP they arrive bare.
 */

/** Marks a notification, and is what `parseTaskNotifications` looks for. */
const OPEN = '<task-notification>';
const CLOSE = '</task-notification>';

/** What a finished task cost, when the harness says. */
export interface TaskUsage {
  /** Tokens the task spent; the harness reports these for a subagent. */
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** One background task reporting in. */
export interface TaskNotification {
  /** The harness's id for the task, which outlives any one notification. */
  taskId: string;
  /**
   * The tool call that started the task, when the harness names it — which it
   * does for a background command and not for a subagent or a monitor. It is
   * the id ACP calls `toolCallId`, so it is what correlates a report with the
   * call that started the work.
   */
  toolUseId?: string;
  /**
   * `completed`, `failed`, `killed` or `blocked` — and absent on a task that
   * is still going, which is what a monitor's event is.
   */
  status?: string;
  /** One line saying what happened; always present, and what the row shows. */
  summary: string;
  /** What the task said: a subagent's answer, or a monitor's event. */
  body?: string;
  usage?: TaskUsage;
}

/** A run of message text, as notifications and the prose around them. */
export type NotificationSegment =
  | { type: 'text'; text: string }
  | { type: 'notification'; notification: TaskNotification };

/** The contents of one `<tag>`, trimmed, or undefined when there is none. */
function field(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/** One `<tag>` holding a number, or undefined when it holds anything else. */
function count(body: string, name: string): number | undefined {
  const value = field(body, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The `<usage>` block, or undefined when it is absent or says nothing. */
function usageOf(body: string): TaskUsage | undefined {
  const block = field(body, 'usage');
  if (!block) return undefined;
  const tokens = count(block, 'subagent_tokens');
  const toolUses = count(block, 'tool_uses');
  const durationMs = count(block, 'duration_ms');
  const usage: TaskUsage = {
    ...(tokens === undefined ? {} : { tokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * One block's contents as a notification, or null when this build cannot
 * read it.
 *
 * The id and the summary are what a row is made of, so a block missing
 * either is not one of these — which is also what keeps a message *about*
 * the format from being read as an instance of it.
 */
function notificationOf(body: string): TaskNotification | null {
  const taskId = field(body, 'task-id');
  const summary = field(body, 'summary');
  if (!taskId || !summary) return null;

  // A subagent answers with `result` and a monitor reports an `event`; the
  // two never arrive together, and joining them costs nothing if they ever
  // do.
  const said = [field(body, 'result'), field(body, 'event')].filter(Boolean).join('\n\n');
  const toolUseId = field(body, 'tool-use-id');
  const status = field(body, 'status');
  const usage = usageOf(body);

  return {
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(status ? { status } : {}),
    summary,
    ...(said ? { body: said } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * A block of message text as the notifications in it and the prose around
 * them, or null when it holds none.
 *
 * Null rather than a single text segment so a caller can tell "nothing to do
 * here" from "one segment of text", and so the ordinary case — a message the
 * user typed — costs one `indexOf` and nothing else.
 */
export function parseTaskNotifications(text: string): NotificationSegment[] | null {
  if (!text.includes(OPEN)) return null;

  const segments: NotificationSegment[] = [];
  let read = 0;

  for (;;) {
    const open = text.indexOf(OPEN, read);
    if (open === -1) break;
    const close = text.indexOf(CLOSE, open);
    // An opening tag with nothing closing it is somebody talking about the
    // format rather than using it, and is left as the text it is. A block cut
    // in half by a chunk boundary would read the same way, and cannot happen:
    // the harness sends a notification as one content block, live and on
    // replay, because a message in the user's role is not streamed.
    if (close === -1) break;

    const notification = notificationOf(text.slice(open + OPEN.length, close));
    if (!notification) return null;

    const before = text.slice(read, open).trim();
    if (before) segments.push({ type: 'text', text: before });
    segments.push({ type: 'notification', notification });
    read = close + CLOSE.length;
  }

  if (segments.length === 0) return null;

  const after = text.slice(read).trim();
  if (after) segments.push({ type: 'text', text: after });
  return segments;
}


/**
 * Statuses that say the task will not report again.
 *
 * An absent status is a task still going, which is what a monitor's event is.
 * An unknown one is read the same way: a newer harness reporting something
 * this build has not heard of is not proof that anything ended.
 */
const TERMINAL = new Set(['completed', 'failed', 'killed']);

/** Whether a notification's status means the task is over. */
export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}
