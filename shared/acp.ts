/**
 * ACP names shared by the orchestrator and the dashboard. The module holds
 * plain strings only, so the dashboard can bundle it without the ACP SDK.
 */

/**
 * The WebSocket subprotocol that the gateway selects.
 *
 * A browser also offers a `bearer.<token>` entry, which holds the credential and is not a protocol.
 */
export const ACP_SUBPROTOCOL = 'acp.v1';

/** Every ACP method Boxes sends, forwards or answers. */
export const ACP_METHOD = {
  /** Opens a connection and exchanges capabilities. */
  initialize: 'initialize',
  /** Gives the adapter a credential it asked for. */
  authenticate: 'authenticate',
  /** Creates a conversation and returns its id. */
  sessionNew: 'session/new',
  /** Opens a conversation again and replays it as `session/update` notifications. */
  sessionLoad: 'session/load',
  /** Lists the conversations the adapter holds. */
  sessionList: 'session/list',
  /** Creates a conversation with the context of another conversation. */
  sessionFork: 'session/fork',
  /** Opens a conversation again without a replay. */
  sessionResume: 'session/resume',
  /** Tells the adapter to close a conversation that it holds open. */
  sessionClose: 'session/close',
  /** Removes a conversation and its transcript. */
  sessionDelete: 'session/delete',
  /** Sends a prompt and runs a turn. */
  sessionPrompt: 'session/prompt',
  /** Stops the running turn. It is a notification and gets no answer. */
  sessionCancel: 'session/cancel',
  /** Sets a conversation to one of the modes that the adapter advertises. */
  sessionSetMode: 'session/set_mode',
  /** Sets the model of a conversation. */
  sessionSetModel: 'session/set_model',
  /** Sets one of the options that a client can change. */
  sessionSetConfigOption: 'session/set_config_option',
  /** A method outside the ACP schema. The gateway forwards it to the adapter unchanged. */
  sessionSelectProvider: 'session/select_provider',
  /** Sends a change of a conversation from the adapter. It is a notification. */
  sessionUpdate: 'session/update',
  /** Asks the client if a tool call can continue. The tool call waits for the answer. */
  sessionRequestPermission: 'session/request_permission',
} as const;

/** One of the values of {@link ACP_METHOD}. */
export type AcpMethod = (typeof ACP_METHOD)[keyof typeof ACP_METHOD];

/**
 * The kinds of `session/update` notification that Boxes knows, as named in the `update.sessionUpdate` field.
 *
 * An adapter can send other kinds, so a reader must expect unknown kinds.
 */
export const UPDATE_KIND = {
  /** A chunk of a user-role message. The harness also sends user-role messages, such as a task notification. */
  userMessageChunk: 'user_message_chunk',
  /** A chunk of the agent's answer. */
  agentMessageChunk: 'agent_message_chunk',
  /** A chunk of the agent's thoughts. */
  agentThoughtChunk: 'agent_thought_chunk',
  /** A tool call the agent has started. */
  toolCall: 'tool_call',
  /** A change to a tool call, such as its status, its output or its title. */
  toolCallUpdate: 'tool_call_update',
  /** The full plan of the agent. It replaces the last plan. */
  plan: 'plan',
  /** The full list of slash commands that the adapter accepts. */
  availableCommands: 'available_commands_update',
  /** The current mode of the conversation. */
  currentMode: 'current_mode_update',
  /** All configuration options of the adapter and their values. */
  configOption: 'config_option_update',
  /** Facts about the conversation, such as the title that the adapter gave it. */
  sessionInfo: 'session_info_update',
  /**
   * The tokens in the context window and the size of the window. The adapter can also send the total cost of
   * the conversation so far.
   */
  usage: 'usage_update',
} as const;

/** One of the values of {@link UPDATE_KIND}. */
export type UpdateKind = (typeof UPDATE_KIND)[keyof typeof UPDATE_KIND];
