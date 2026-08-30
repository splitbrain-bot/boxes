/**
 * The slice of the ACP schema the browser speaks, written out rather than
 * imported.
 *
 * The orchestrator depends on @agentclientprotocol/sdk because it runs a real
 * ACP client; the browser only reads notification payloads and builds two
 * request bodies, and pulling a Node-shaped SDK into the bundle to name a
 * dozen object types would cost more than it explains. These match the
 * generated schema field for field.
 */

/** A displayable block: text, an image, a link or an embedded resource. */
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
  path: string;
  line?: number | null;
}

/** What a tool call produced: content, a diff, or a terminal handle. */
export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

/** A tool call the model asked for. */
export interface ToolCall {
  toolCallId: string;
  title: string;
  name?: string | null;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** A change to a tool call. Every field but the id is optional. */
export type ToolCallUpdate = Partial<ToolCall> & { toolCallId: string };

/** One mode the adapter can operate in. */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

/** The modes an adapter advertises, and the one it is in. */
export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

/** One selectable value of a session configuration option. */
export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

/**
 * One thing about a thread the adapter lets a client set — the model, the
 * effort level, the permission mode — together with its current value.
 *
 * `category` says what the option is for, so a client can place a known one
 * deliberately rather than depend on the adapter's own id for it.
 */
export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  /** `model`, `mode`, `model_config`, `thought_level`, or an unknown label. */
  category?: string | null;
  /** `select` carries an options list; other kinds carry none. */
  type?: string;
  currentValue?: string;
  options?: SessionConfigSelectOption[];
}

/** One slash command the adapter accepts at the start of a prompt. */
export interface AvailableCommand {
  name: string;
  description?: string | null;
  /** What the command expects after its name, when it takes anything. */
  input?: { hint?: string } | null;
}

/** A step of the agent's plan. */
export interface PlanEntry {
  content: string;
  priority?: string;
  status?: string;
}

/** A chunk of a streamed message. Chunks sharing a messageId are one message. */
interface ContentChunk {
  content: ContentBlock;
  messageId?: string | null;
}

/** Everything the adapter can push through session/update. */
export type SessionUpdate =
  | (ContentChunk & { sessionUpdate: 'user_message_chunk' })
  | (ContentChunk & { sessionUpdate: 'agent_message_chunk' })
  | (ContentChunk & { sessionUpdate: 'agent_thought_chunk' })
  | (ToolCall & { sessionUpdate: 'tool_call' })
  | (ToolCallUpdate & { sessionUpdate: 'tool_call_update' })
  | { sessionUpdate: 'plan'; entries?: PlanEntry[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'available_commands_update'; availableCommands?: AvailableCommand[] }
  | { sessionUpdate: 'config_option_update'; configOptions?: SessionConfigOption[] }
  // Forward compatibility: an adapter may send a kind this build predates.
  | { sessionUpdate: string; [key: string]: unknown };

/** The params of a session/update notification. */
export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

/** What a permission option would do if chosen. */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/** One answer the user may give to a permission request. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/** The adapter asking whether a tool call may proceed. It blocks until answered. */
export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/** The answer to a permission request. */
export interface RequestPermissionResponse {
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };
}

/** What session/new answers with. Modes are absent when the adapter has none. */
export interface NewSessionResponse {
  sessionId: string;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

/** What session/load answers with. */
export interface LoadSessionResponse {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

/** Reads a content block as plain text, for the blocks that carry any. */
export function blockText(block: ContentBlock | undefined): string {
  if (!block) return '';
  if (block.type === 'text') return block.text;
  if (block.type === 'resource') return block.resource?.text ?? '';
  if (block.type === 'resource_link') return block.title ?? block.name ?? block.uri;
  return '';
}
