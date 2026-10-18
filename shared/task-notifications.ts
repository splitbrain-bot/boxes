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
 * The block is part of the message text, and the transcript of the adapter
 * keeps it unchanged. So the same parser reads the live stream and the replay.
 */

/** Opening tag of one notification block. */
const OPEN = '<task-notification>';

/** Closing tag of one notification block. */
const CLOSE = '</task-notification>';

/** The cost of a finished task, when the harness reports it. */
export interface TaskUsage {
  /** The tokens that the task used. The harness reports them for a subagent. */
  tokens?: number;
  /** The number of tool calls that the task made. */
  toolUses?: number;
  /** The run time of the task, in milliseconds. */
  durationMs?: number;
}

/** One background task reporting in. */
export interface TaskNotification {
  /** The id of the task from the harness. It is the same in all notifications of the task. */
  taskId: string;
  /**
   * The status from the harness, such as `completed`, `failed`, `killed`, `blocked` or `stopped`. Absent while
   * the task runs, as with the event of a monitor.
   */
  status?: string;
  /** One line about what happened. */
  summary: string;
  /** The output of the task, such as the answer of a subagent or the event of a monitor. */
  body?: string;
  /** The cost of the task, when the harness reports it. */
  usage?: TaskUsage;
}

/**
 * One part of a message text. A `text` part holds the text around the notifications in `text`. A
 * `notification` part holds one parsed block in `notification`.
 */
export type NotificationSegment =
  | { type: 'text'; text: string }
  | { type: 'notification'; notification: TaskNotification };

/**
 * Reads the trimmed content of one `<tag>`.
 *
 * @param body The text to search.
 * @param name The name of the tag.
 * @returns The content, or undefined when the tag is missing or empty.
 */
function field(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * Reads one `<tag>` that holds a number.
 *
 * @param body The text to search.
 * @param name The name of the tag.
 * @returns The number, or undefined when the tag is missing or holds no number.
 */
function count(body: string, name: string): number | undefined {
  const value = field(body, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reads the `<usage>` block.
 *
 * @param body The content of one notification block.
 * @returns The usage, or undefined when the block is missing or has no known values.
 */
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
 * Reads the content of one block as a notification.
 *
 * @param body The content between the opening and the closing tag.
 * @returns The notification, or null when the block has no task id or no summary.
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
 * Splits message text into the notifications in it and the text around them.
 *
 * A block that cannot be read stays in the text, and the parser still reads
 * the blocks next to it. The parser also reads a notification inside a
 * `<system-reminder>` wrapper, and the lines of the wrapper stay as text.
 *
 * @param text The message text.
 * @returns The segments in their order, or null when the text holds no notification.
 */
export function parseTaskNotifications(text: string): NotificationSegment[] | null {
  if (!text.includes(OPEN)) return null;

  const segments: NotificationSegment[] = [];
  // Start of the next text segment, and start of the next block search. The two
  // differ after an unreadable block, which then stays part of the text.
  let read = 0;
  let scan = 0;

  for (;;) {
    const open = text.indexOf(OPEN, scan);
    if (open === -1) break;
    const close = text.indexOf(CLOSE, open);
    // An opening tag without a closing tag is text about the format, not a block.
    // The harness sends a notification in one content block, so a block cannot be split here.
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
