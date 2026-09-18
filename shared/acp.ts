/**
 * The ACP words Boxes says: the subprotocol, the method names and the
 * `sessionUpdate` kinds.
 *
 * Plain strings and the types over them, and nothing else. The orchestrator
 * runs a real ACP client and has the SDK; the dashboard keeps the SDK out of
 * its bundle and writes the schema out by hand in `acp-types.ts`. Both sides
 * need the same spellings, so the spellings live here and the module stays
 * safe to pull into a browser bundle.
 */

/**
 * The WebSocket subprotocol the gateway negotiates.
 *
 * A browser offers this alongside a `bearer.<token>` entry, which is
 * credentials rather than a protocol, so this is the one the server selects.
 */
export const ACP_SUBPROTOCOL = 'acp.v1';

/** Every ACP method Boxes sends, forwards or answers. */
export const ACP_METHOD = {
  /** Opens a connection and exchanges capabilities. */
  initialize: 'initialize',
  /** Gives the adapter a credential it asked for. */
  authenticate: 'authenticate',
  /** Mints a conversation and answers with its id. */
  sessionNew: 'session/new',
  /** Brings a conversation back and replays it as `session/update` notifications. */
  sessionLoad: 'session/load',
  /** Lists the conversations the adapter holds. */
  sessionList: 'session/list',
  /** Mints a conversation carrying another one's context. */
  sessionFork: 'session/fork',
  /** Takes up a conversation the adapter had set aside. */
  sessionResume: 'session/resume',
  /** Lets the adapter drop a conversation it is holding open. */
  sessionClose: 'session/close',
  /** Removes a conversation and its transcript. */
  sessionDelete: 'session/delete',
  /** Sends a prompt and runs a turn. */
  sessionPrompt: 'session/prompt',
  /** Interrupts the running turn. A notification, so it takes no answer. */
  sessionCancel: 'session/cancel',
  /** Puts a conversation into one of the modes the adapter advertises. */
  sessionSetMode: 'session/set_mode',
  /** Picks the model a conversation answers with. */
  sessionSetModel: 'session/set_model',
  /** Sets one of the options the adapter lets a client change. */
  sessionSetConfigOption: 'session/set_config_option',
  /** Picks which backend the adapter talks to. */
  sessionSelectProvider: 'session/select_provider',
  /** Everything the adapter pushes about a conversation. A notification. */
  sessionUpdate: 'session/update',
  /** The adapter asking whether a tool call may proceed. It blocks until answered. */
  sessionRequestPermission: 'session/request_permission',
} as const;

/** One of the method names above. */
export type AcpMethod = (typeof ACP_METHOD)[keyof typeof ACP_METHOD];

/**
 * Every `sessionUpdate` kind Boxes knows, which is the `update.sessionUpdate`
 * field of a `session/update` notification.
 *
 * An adapter may send a kind this build predates, so a reader treats the list
 * as the kinds it recognises rather than the kinds that exist.
 */
export const UPDATE_KIND = {
  /** A chunk of what the user, or the harness on their behalf, said. */
  userMessageChunk: 'user_message_chunk',
  /** A chunk of the agent's answer. */
  agentMessageChunk: 'agent_message_chunk',
  /** A chunk of the agent thinking out loud. */
  agentThoughtChunk: 'agent_thought_chunk',
  /** A tool call the agent has started. */
  toolCall: 'tool_call',
  /** A change to a tool call: its status, its output, its title. */
  toolCallUpdate: 'tool_call_update',
  /** The agent's plan, whole, replacing whatever it last sent. */
  plan: 'plan',
  /** The slash commands the adapter accepts, whole. */
  availableCommands: 'available_commands_update',
  /** The mode the conversation is now in. */
  currentMode: 'current_mode_update',
  /** The adapter's configuration options and their values, whole. */
  configOption: 'config_option_update',
  /** Facts about the conversation itself, such as the title the adapter gave it. */
  sessionInfo: 'session_info_update',
  /** What the turn has cost so far. */
  usage: 'usage_update',
} as const;

/** One of the update kinds above. */
export type UpdateKind = (typeof UPDATE_KIND)[keyof typeof UPDATE_KIND];
