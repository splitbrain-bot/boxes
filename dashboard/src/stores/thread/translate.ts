import { UPDATE_KIND, type UpdateKind } from '../../../../shared/acp.ts';
import {
  blockText,
  imageFallbackText,
  imageSrc,
  type AvailableCommand,
  type ContentBlock,
  type PermissionOption,
  type PlanEntry,
  type ThreadConfigOption,
  type ThreadModeState,
  type ThreadUpdate,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolKind,
} from './acp-types.ts';
import { parseEnvelope } from '../../lib/attachments.ts';
import {
  parseTaskNotifications,
  type TaskNotification,
} from '../../../../shared/task-notifications.ts';

/** Folds ACP session/update notifications into the thread's message model. */

/** The member of the update union that carries one kind. */
type UpdateOf<K extends UpdateKind> = Extract<ThreadUpdate, { sessionUpdate: K }>;

/** A run of assistant or user prose. */
interface TextPart {
  /** The part's kind. */
  type: 'text';
  /** The text so far. */
  text: string;
}

/** The agent thinking out loud, rendered collapsed. */
interface ReasoningPart {
  /** The part's kind. */
  type: 'reasoning';
  /** The text so far. */
  text: string;
}

/**
 * An image, as a src the browser can load.
 *
 * `imageSrc` settles the src on arrival. A block without a src becomes text
 * instead.
 */
interface ImagePart {
  /** The part's kind. */
  type: 'image';
  /** A data URL, or an https or blob URL. */
  src: string;
}

/**
 * A file the user attached, shown as a chip under the message.
 *
 * Built from the envelope text the composer put in the prompt. Text survives
 * a transcript unchanged, so live and replayed threads show the same chip.
 */
export interface AttachmentPart {
  /** The part's kind. */
  type: 'attachment';
  /** The file's name, which is what the chip shows. */
  name: string;
  /** The workspace-relative path the agent was given to open. */
  path: string;
  /** The file's media type. */
  mimeType: string;
}

/**
 * A background task's report, shown as a row of its own.
 *
 * Built from the XML block the harness wakes the agent with, so live and
 * replayed threads show the same row.
 */
export interface TaskPart extends TaskNotification {
  /** The part's kind. */
  type: 'task';
}

/** A permission request attached to the tool call it is about. */
export interface ApprovalState {
  /** Correlates the user's answer with the JSON-RPC request that is blocked. */
  id: string;
  /** The answers the request offers. */
  options: PermissionOption[];
  /** The option the user picked, once answered. */
  optionId?: string;
  /** Set when the request was cancelled instead of answered. */
  resolution?: 'cancelled';
}

/** One tool call, and everything known about it so far. */
export interface ToolPart {
  /** The part's kind. */
  type: 'tool';
  /** The adapter's id for the call. */
  toolCallId: string;
  /** The adapter's human-readable title, which is what the header shows. */
  title: string;
  /** The programmatic name when the adapter sends one. */
  name?: string;
  /** The category of the tool. */
  kind?: ToolKind;
  /** How far along the call is. */
  status: ToolCallStatus;
  /** The arguments the tool received. */
  rawInput?: unknown;
  /** Content blocks, diffs and terminal handles, rendered in order. */
  content: ToolCallContent[];
  /** The files the call touches. */
  locations: ToolCallLocation[];
  /** The permission request on this call, while one exists. */
  approval?: ApprovalState;
}

/** A part of a message. */
export type Part = TextPart | ReasoningPart | ImagePart | AttachmentPart | TaskPart | ToolPart;

/** One message in the thread. */
export interface Message {
  /** The adapter's message id, or one this model made up. */
  id: string;
  /** Who speaks. */
  role: 'user' | 'assistant';
  /** The message content, in order. */
  parts: Part[];
  /**
   * True when the id is the adapter's own.
   *
   * A replay repeats the adapter's ids, so a reconnect can resume from such
   * a message.
   */
  named?: boolean;
}

/** Everything the thread view reads. */
export interface ThreadModel {
  messages: Message[];
  /** The adapter's advertised modes, or null when it advertises none. */
  modes: ThreadModeState | null;
  /** The options the adapter lets a client set, such as the model. */
  configOptions: ThreadConfigOption[];
  /** The agent's current plan, or null when it has published none. */
  plan: PlanEntry[] | null;
  /** The slash commands the adapter accepts, for the composer to complete. */
  commands: AvailableCommand[];
  /**
   * Kinds of update this build does not know, by name.
   *
   * Only the names are kept, because a thread can carry hundreds of thousands
   * of updates.
   */
  unknown: Set<string>;
  /**
   * Every tool call in the thread with the message that holds it, by the
   * adapter's id for the call.
   *
   * A long thread holds thousands of calls, so lookups use this index.
   */
  tools: Map<string, { part: ToolPart; message: Message }>;
}

/** A model with nothing in it. */
export function emptyModel(): ThreadModel {
  return {
    messages: [],
    modes: null,
    configOptions: [],
    plan: null,
    commands: [],
    unknown: new Set(),
    tools: new Map(),
  };
}

/** Source of message ids for chunks that arrive without one. */
let nextId = 1;

/** Resets the id counter, so each test gets predictable ids. */
export function resetIds(): void {
  nextId = 1;
}

/** A new empty message in the given role, named when `id` is given. */
function newMessage(role: Message['role'], id?: string | null): Message {
  if (id) return { id, role, parts: [], named: true };
  return { id: `m${nextId++}`, role, parts: [] };
}

/**
 * The message a chunk belongs to.
 *
 * ACP marks message boundaries with messageId: chunks sharing one are the
 * same message, and a change starts a new one. Without a messageId, a role
 * change starts a new message.
 */
function messageFor(
  model: ThreadModel,
  role: Message['role'],
  messageId: string | null | undefined,
): Message {
  const last = model.messages.at(-1);
  if (last) {
    if (messageId) {
      if (last.id === messageId) return last;
    } else if (last.role === role) {
      return last;
    }
  }
  const created = newMessage(role, messageId);
  model.messages.push(created);
  return created;
}

/** Appends text to the trailing part of that kind, or starts a new one. */
function appendText(message: Message, kind: 'text' | 'reasoning', text: string): void {
  if (!text) return;
  const last = message.parts.at(-1);
  if (last?.type === kind) {
    last.text += text;
    return;
  }
  message.parts.push({ type: kind, text });
}

/**
 * Appends one content block to a message, as a part of the kind it is.
 *
 * An image becomes its own part between the text parts around it.
 * Everything else is read as text and appended, so a run of chunks
 * collapses into one part. All three chunk kinds use this path, thoughts
 * included.
 */
function appendBlock(message: Message, kind: 'text' | 'reasoning', content: ContentBlock): void {
  if (content?.type === 'image') {
    const src = imageSrc(content);
    if (src) {
      message.parts.push({ type: 'image', src });
      return;
    }
    appendText(message, kind, imageFallbackText(content));
    return;
  }

  const text = blockText(content);

  // The harness wakes the agent in the user role when a background task
  // reports. Only that role is checked, so an agent quoting the format stays
  // text.
  const segments = kind === 'text' && message.role === 'user' ? parseTaskNotifications(text) : null;
  if (segments) {
    for (const segment of segments) {
      if (segment.type === 'text') appendText(message, kind, segment.text);
      else message.parts.push({ type: 'task', ...segment.notification });
    }
    return;
  }

  // The composer's envelope tells the agent what was attached. The reader sees
  // the attached files in its place.
  const envelope = kind === 'text' ? parseEnvelope(text) : null;
  if (envelope) {
    appendText(message, kind, envelope.before);
    for (const entry of envelope.entries) {
      message.parts.push({
        type: 'attachment',
        name: entry.name,
        path: entry.path,
        mimeType: entry.mimeType,
      });
    }
    appendText(message, kind, envelope.after);
    return;
  }

  appendText(message, kind, text);
}

/**
 * Drops the message an id names and everything after it, so a replay that
 * starts there builds them again.
 *
 * Returns what went, which is empty when no message answers to the id — and
 * then the model is left exactly as it was.
 */
export function truncateFrom(model: ThreadModel, messageId: string): Message[] {
  const from = model.messages.findIndex((m) => m.id === messageId);
  if (from < 0) return [];
  const dropped = model.messages.splice(from);
  // The tool index loses the calls of the dropped messages.
  for (const message of dropped) {
    for (const part of message.parts) {
      if (part.type === 'tool') model.tools.delete(part.toolCallId);
    }
  }
  return dropped;
}

/** Finds a tool part anywhere in the thread. */
export function findTool(model: ThreadModel, toolCallId: string): ToolPart | undefined {
  return model.tools.get(toolCallId)?.part;
}

/** The message a tool call sits in, or null when the thread has no such call. */
export function messageOfTool(model: ThreadModel, toolCallId: string): Message | null {
  return model.tools.get(toolCallId)?.message ?? null;
}

/**
 * Applies one update to the model, in place, and returns the message it
 * changed so a caller can refresh just that one.
 *
 * Replay and live streaming both come through here. An unknown kind is
 * noted by name and otherwise ignored, so a newer adapter does not break an
 * older dashboard.
 */
export function applyUpdate(model: ThreadModel, update: ThreadUpdate): Message | null {
  switch (update.sessionUpdate) {
    case UPDATE_KIND.userMessageChunk: {
      const u = update as UpdateOf<typeof UPDATE_KIND.userMessageChunk>;
      const message = messageFor(model, 'user', u.messageId);
      appendBlock(message, 'text', u.content);
      return message;
    }
    case UPDATE_KIND.agentMessageChunk: {
      const u = update as UpdateOf<typeof UPDATE_KIND.agentMessageChunk>;
      const message = messageFor(model, 'assistant', u.messageId);
      appendBlock(message, 'text', u.content);
      return message;
    }
    case UPDATE_KIND.agentThoughtChunk: {
      const u = update as UpdateOf<typeof UPDATE_KIND.agentThoughtChunk>;
      const message = messageFor(model, 'assistant', u.messageId);
      appendBlock(message, 'reasoning', u.content);
      return message;
    }
    case UPDATE_KIND.toolCall: {
      const u = update as UpdateOf<typeof UPDATE_KIND.toolCall>;
      // A re-announced call is an update, not a second card: an adapter may
      // resend one, and replay always does.
      return openTool(model, u, u.title);
    }
    case UPDATE_KIND.toolCallUpdate: {
      const u = update as UpdateOf<typeof UPDATE_KIND.toolCallUpdate>;
      // Out of order: an update can arrive before the call it belongs to, and
      // dropping it would lose the tool's result. What it lacks is a title, so
      // the id stands in until the announcement arrives with one.
      return openTool(model, u, u.title ?? u.toolCallId);
    }
    case UPDATE_KIND.plan: {
      const u = update as UpdateOf<typeof UPDATE_KIND.plan>;
      model.plan = u.entries ?? [];
      return null;
    }
    case UPDATE_KIND.availableCommands: {
      const u = update as UpdateOf<typeof UPDATE_KIND.availableCommands>;
      model.commands = u.availableCommands ?? [];
      return null;
    }
    case UPDATE_KIND.configOption: {
      const u = update as UpdateOf<typeof UPDATE_KIND.configOption>;
      // The adapter sends the whole set every time, so this replaces rather
      // than merges.
      model.configOptions = u.configOptions ?? [];
      return null;
    }
    case UPDATE_KIND.currentMode: {
      const u = update as UpdateOf<typeof UPDATE_KIND.currentMode>;
      if (model.modes) model.modes = { ...model.modes, currentModeId: u.currentModeId };
      return null;
    }
    default:
      model.unknown.add(update.sessionUpdate);
      return null;
  }
}

/**
 * Folds a tool_call or a tool_call_update into the thread: merged into the
 * call it is about, or started as a fresh card when there is none yet.
 *
 * An adapter may send either of the two first, so both take this path. The
 * caller passes the title for a new card.
 */
function openTool(model: ThreadModel, u: ToolCallUpdate, title: string): Message | null {
  const indexed = model.tools.get(u.toolCallId);
  if (indexed) {
    mergeTool(indexed.part, u);
    return indexed.message;
  }
  const message = messageFor(model, 'assistant', null);
  const part: ToolPart = {
    type: 'tool',
    toolCallId: u.toolCallId,
    title,
    ...(u.name ? { name: u.name } : {}),
    ...(u.kind ? { kind: u.kind } : {}),
    status: u.status ?? 'pending',
    ...(u.rawInput === undefined ? {} : { rawInput: u.rawInput }),
    content: u.content ?? [],
    locations: u.locations ?? [],
  };
  message.parts.push(part);
  model.tools.set(u.toolCallId, { part, message });
  return message;
}

/**
 * Merges a tool_call or tool_call_update into an existing part.
 *
 * Null and absent both mean "leave it alone", which is what the schema says
 * an omitted field means.
 */
function mergeTool(part: ToolPart, u: ToolCallUpdate): void {
  if (u.title != null) part.title = u.title;
  if (u.name != null) part.name = u.name;
  if (u.kind != null) part.kind = u.kind;
  if (u.status != null) part.status = u.status;
  if (u.rawInput !== undefined) part.rawInput = u.rawInput;
  // content and locations replace rather than merge, which is what the
  // schema says: an update carries the whole collection.
  if (u.content != null) part.content = u.content;
  if (u.locations != null) part.locations = u.locations;
}

/**
 * Renders a tool call's content as the plain text the fallback shows.
 *
 * An image is named rather than rendered here; the picture itself is shown
 * beside the card. Naming it keeps an image result from reading as a tool
 * that produced nothing.
 */
export function toolOutputText(part: ToolPart): string {
  return part.content
    .map((c) => {
      if (c.type === 'content') {
        return c.content?.type === 'image' ? imageFallbackText(c.content) : blockText(c.content);
      }
      if (c.type === 'diff') return diffText(c);
      return `[terminal ${c.terminalId}]`;
    })
    .filter(Boolean)
    .join('\n');
}

/** A diff as a block in unified style: the removed lines, then the added ones. */
function diffText(diff: Extract<ToolCallContent, { type: 'diff' }>): string {
  const removed = (diff.oldText ?? '')
    .split('\n')
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .map((l) => `-${l}`);
  const added = diff.newText
    .split('\n')
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .map((l) => `+${l}`);
  return [`--- ${diff.path}`, ...removed, ...added].join('\n');
}
