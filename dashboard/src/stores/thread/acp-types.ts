import { UPDATE_KIND } from '../../../../shared/acp.ts';

/**
 * The part of the ACP schema the browser reads and sends, written out by hand
 * so the SDK stays out of the bundle.
 */

/** A displayable block: text, an image, audio, a link or an embedded resource. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType?: string; data?: string; uri?: string }
  | { type: 'audio'; mimeType?: string; data?: string }
  | { type: 'resource_link'; uri: string; name?: string; title?: string }
  | { type: 'resource'; resource?: { uri?: string; text?: string } };

/** How far along a tool call is. */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** The category of a tool, which picks its icon and treatment. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/** A file the tool touched, and where in it. */
export interface ToolCallLocation {
  /** The file's path. */
  path: string;
  /** The line in the file, when the tool names one. */
  line?: number | null;
}

/** What a tool call produced: content, a diff, or a terminal handle. */
export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

/** A tool call the model asked for. */
interface ToolCall {
  /** The adapter's id for the call. */
  toolCallId: string;
  /** The human-readable title. */
  title: string;
  /** The programmatic tool name, when the adapter sends one. */
  name?: string | null;
  /** The category of the tool. */
  kind?: ToolKind;
  /** How far along the call is. */
  status?: ToolCallStatus;
  /** What the call produced so far. */
  content?: ToolCallContent[] | null;
  /** The files the call touches. */
  locations?: ToolCallLocation[] | null;
  /** The arguments the tool received. */
  rawInput?: unknown;
  /** The tool's raw result. */
  rawOutput?: unknown;
}

/** A change to a tool call. Every field but the id is optional. */
export type ToolCallUpdate = Partial<ToolCall> & { toolCallId: string };

/** One mode the adapter can operate in. */
interface ThreadMode {
  /** The mode's id. */
  id: string;
  /** The display name. */
  name: string;
  /** A longer explanation, when the adapter sends one. */
  description?: string | null;
}

/** The modes an adapter advertises, and the one it is in. */
export interface ThreadModeState {
  /** The id of the mode the adapter is in. */
  currentModeId: string;
  /** Every mode the adapter offers. */
  availableModes: ThreadMode[];
}

/** One selectable value of a thread configuration option. */
interface ThreadConfigSelectOption {
  /** The value sent when this option is chosen. */
  value: string;
  /** The display name. */
  name: string;
  /** A longer explanation, when the adapter sends one. */
  description?: string | null;
}

/**
 * One setting of a thread that the adapter lets a client change, such as the
 * model, the effort level or the permission mode, with its current value.
 */
export interface ThreadConfigOption {
  /** The adapter's id for the option. */
  id: string;
  /** The display name. */
  name: string;
  /** A longer explanation, when the adapter sends one. */
  description?: string | null;
  /**
   * What the option is for: `model`, `mode`, `model_config`, `thought_level`,
   * or an unknown label. A client can place a known option by it without
   * relying on the adapter's id.
   */
  category?: string | null;
  /** `select` carries an options list; other kinds carry none. */
  type?: string;
  /** The value in effect. */
  currentValue?: string;
  /** The values a `select` offers. */
  options?: ThreadConfigSelectOption[];
}

/** One slash command the adapter accepts at the start of a prompt. */
export interface AvailableCommand {
  /** The command name. */
  name: string;
  /** What the command does. */
  description?: string | null;
  /** What the command expects after its name, when it takes anything. */
  input?: { hint?: string } | null;
}

/** A step of the agent's plan. */
export interface PlanEntry {
  /** What the step does. */
  content: string;
  /** The step's priority, as the adapter labels it. */
  priority?: string;
  /** How far along the step is, as the adapter labels it. */
  status?: string;
}

/** A chunk of a streamed message. Chunks sharing a messageId are one message. */
interface ContentChunk {
  /** The block this chunk carries. */
  content: ContentBlock;
  /** The message the chunk belongs to, when the adapter names one. */
  messageId?: string | null;
}

/** Everything the adapter can push through session/update. */
export type ThreadUpdate =
  | (ContentChunk & { sessionUpdate: typeof UPDATE_KIND.userMessageChunk })
  | (ContentChunk & { sessionUpdate: typeof UPDATE_KIND.agentMessageChunk })
  | (ContentChunk & { sessionUpdate: typeof UPDATE_KIND.agentThoughtChunk })
  | (ToolCall & { sessionUpdate: typeof UPDATE_KIND.toolCall })
  | (ToolCallUpdate & { sessionUpdate: typeof UPDATE_KIND.toolCallUpdate })
  | { sessionUpdate: typeof UPDATE_KIND.plan; entries?: PlanEntry[] }
  | { sessionUpdate: typeof UPDATE_KIND.currentMode; currentModeId: string }
  | { sessionUpdate: typeof UPDATE_KIND.availableCommands; availableCommands?: AvailableCommand[] }
  | { sessionUpdate: typeof UPDATE_KIND.configOption; configOptions?: ThreadConfigOption[] }
  // Forward compatibility: an adapter may send a kind this build predates.
  | { sessionUpdate: string; [key: string]: unknown };

/** The params of a session/update notification. */
export interface ThreadNotification {
  /** The ACP thread the update is about. */
  sessionId: string;
  /** The update itself. */
  update: ThreadUpdate;
}

/** What a permission option would do if chosen. */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/** One answer the user may give to a permission request. */
export interface PermissionOption {
  /** The id sent back when the user picks this option. */
  optionId: string;
  /** The button label. */
  name: string;
  /** What the option would do. */
  kind: PermissionOptionKind;
}

/** The adapter asking whether a tool call may proceed. It blocks until answered. */
export interface RequestPermissionRequest {
  /** The ACP thread that asks. */
  sessionId: string;
  /** The tool call the request is about. */
  toolCall: ToolCallUpdate;
  /** The answers the user may give. */
  options: PermissionOption[];
}

/** The answer to a permission request. */
export interface RequestPermissionResponse {
  /** The option the user picked, or a cancellation. */
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };
}

/** What session/new answers with: the thread the connection is pinned to. */
export interface NewThreadResponse {
  /** The id of the ACP thread. */
  sessionId: string;
}

/** What session/load answers with. */
export interface LoadThreadResponse {
  /** The modes the adapter offers, if any. */
  modes?: ThreadModeState | null;
  /** The settings the adapter lets a client change, if any. */
  configOptions?: ThreadConfigOption[] | null;
}

/** Reads a content block as plain text, for the blocks that carry any. */
export function blockText(block: ContentBlock | undefined): string {
  if (!block) return '';
  if (block.type === 'text') return block.text;
  if (block.type === 'resource') return block.resource?.text ?? '';
  if (block.type === 'resource_link') return block.title ?? block.name ?? block.uri;
  return '';
}

/**
 * An image block as a `src` the browser can load, or null when it has none.
 *
 * A block with data and a mime type becomes a data URL. The adapter sends
 * both empty for a remote image, so that block falls through to its `uri`.
 * A `uri` passes only as https or blob, because assistant-ui drops an image
 * with any other src. A null result lets the caller show the link instead.
 */
export function imageSrc(block: ContentBlock | undefined): string | null {
  if (block?.type !== 'image') return null;
  if (block.data && block.mimeType) return `data:${block.mimeType};base64,${block.data}`;
  if (block.uri && /^(https:|blob:)/i.test(block.uri)) return block.uri;
  return null;
}

/**
 * The text shown in place of an image that cannot render: the link when there
 * is one, otherwise a bare marker.
 *
 * The wording matches the ACP adapter's own for the same case.
 */
export function imageFallbackText(block: ContentBlock | undefined): string {
  if (block?.type !== 'image') return '';
  return block.uri ? `[image: ${block.uri}]` : '[image]';
}
