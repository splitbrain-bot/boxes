/**
 * Parser for the blocks the harness sends when a background task reports in.
 *
 * A background task, such as a command left running, a subagent or a monitor,
 * reports after its turn has ended. The harness then wakes the agent with a
 * user-role message that holds a block like this:
 *
 *     <task-notification>
 *     <task-id>bnztwmmw5</task-id>
 *     <summary>Monitor event: "crawl progress"</summary>
 *     <event>2200/30321 ok=2193 bad=7 — rate limited, pausing 61s</event>
 *     </task-notification>
 *
 * The block travels as message text, which the adapter's transcript keeps
 * unchanged, so one parser serves the live stream and the replay.
 */

/** Opening tag of one notification block. */
const OPEN = '<task-notification>';

/** Closing tag of one notification block. */
const CLOSE = '</task-notification>';

/** What a finished task cost, when the harness says. */
export interface TaskUsage {
  /** Tokens the task spent; the harness reports these for a subagent. */
  tokens?: number;
  /** Tool calls the task made. */
  toolUses?: number;
  /** How long the task ran, in milliseconds. */
  durationMs?: number;
}

/** One background task reporting in. */
export interface TaskNotification {
  /** The harness's id for the task, which outlives any one notification. */
  taskId: string;
  /**
   * `completed`, `failed`, `killed` or `blocked`. Absent while the task is
   * still running, as with a monitor's event.
   */
  status?: string;
  /** One line saying what happened. Always present. */
  summary: string;
  /** What the task said: a subagent's answer, or a monitor's event. */
  body?: string;
  /** What the task cost, when the harness reports it. */
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
 * One block's contents as a notification, or null when the block lacks the
 * task id or the summary.
 */
function notificationOf(body: string): TaskNotification | null {
  const taskId = field(body, 'task-id');
  const summary = field(body, 'summary');
  if (!taskId || !summary) return null;

  // A subagent answers with `result`, a monitor with an `event`.
  const said = [field(body, 'result'), field(body, 'event')].filter(Boolean).join('\n\n');
  const status = field(body, 'status');
  const usage = usageOf(body);

  return {
    taskId,
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
 * A block that cannot be read stays in the text, and the blocks beside it are
 * still read. A notification inside a `<system-reminder>` wrapper is read too,
 * and the wrapper's lines stay as text around it.
 */
export function parseTaskNotifications(text: string): NotificationSegment[] | null {
  if (!text.includes(OPEN)) return null;

  const segments: NotificationSegment[] = [];
  // Start of the next text segment, and start of the next block search. They
  // differ after an unreadable block, which then stays part of the text.
  let read = 0;
  let scan = 0;

  for (;;) {
    const open = text.indexOf(OPEN, scan);
    if (open === -1) break;
    const close = text.indexOf(CLOSE, open);
    // An unclosed opening tag is prose about the format rather than a block,
    // and is left as text. The harness sends a notification as one content
    // block, so a block cannot be cut in half here.
    if (close === -1) break;
    scan = close + CLOSE.length;

    const notification = notificationOf(text.slice(open + OPEN.length, close));
    if (!notification) continue;

    const before = text.slice(read, open).trim();
    if (before) segments.push({ type: 'text', text: before });
    segments.push({ type: 'notification', notification });
    read = scan;
  }

  if (segments.length === 0) return null;

  const after = text.slice(read).trim();
  if (after) segments.push({ type: 'text', text: after });
  return segments;
}
