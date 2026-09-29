import { ACP_METHOD, UPDATE_KIND } from '../../../../shared/acp.ts';
import type { BackgroundProcess } from '../../../../shared/types.ts';
import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ThreadConfigOption,
  ThreadModeState,
  ThreadNotification,
} from './acp-types.ts';
import { AcpClient, loadParams, type ConnectionState } from './acp-client.ts';
import {
  applyUpdate,
  emptyModel,
  findTool,
  messageOfTool,
  truncateFrom,
  type Message,
  type ThreadModel,
} from './translate.ts';

/**
 * What the thread waits on the user for.
 *
 * `permission` asks whether a tool call may proceed. `question` asks which of
 * several courses to take, such as how to leave plan mode. ACP carries both
 * as a permission request, and the tab names which one waits.
 */
export type Awaiting = 'permission' | 'question';

/** What the view renders. Every field is replaced, never mutated. */
export interface ThreadSnapshot {
  /** The messages of the thread, in order. */
  messages: readonly Message[];
  /**
   * True while the agent is producing output: text, thinking, or a tool call
   * of its own. The gateway decides this.
   *
   * An open prompt does not count. The adapter holds a prompt open until the
   * subagents of a turn settle, and a thread woken by a task report works
   * without any prompt.
   */
  isRunning: boolean;
  /**
   * What this thread has left running in its box, such as a command or a
   * monitor. Usually empty.
   */
  background: readonly BackgroundProcess[];
  /** What the thread is waiting for an answer to, or null. */
  awaiting: Awaiting | null;
  /** The state of the connection to the gateway. */
  connection: ConnectionState;
  /** The modes the adapter offers, or null. */
  modes: ThreadModeState | null;
  /** The options the adapter lets a client set, such as the model. */
  configOptions: readonly ThreadConfigOption[];
  /** The agent's current plan, or null. */
  plan: PlanEntry[] | null;
  /** The slash commands the adapter accepts, for the composer to complete. */
  commands: AvailableCommand[];
  /** The last send or connection error, or null. */
  error: string | null;
  /**
   * True until a replay has been read into this store.
   *
   * The view shows a placeholder meanwhile, not an empty thread.
   */
  loading: boolean;
  /**
   * True when the thread lacks its oldest messages, because the gateway no
   * longer holds them. {@link ThreadStore.loadFullHistory} fetches them.
   */
  truncated: boolean;
  /** True while the full history is loading. */
  loadingHistory: boolean;
  /**
   * How many replays of the whole thread have rebuilt the messages. A
   * rebuild can bring messages back under other ids.
   */
  rebuilds: number;
}

/** What a thread shows before anything has been read into it. */
export const INITIAL_SNAPSHOT: ThreadSnapshot = {
  messages: [],
  isRunning: false,
  background: [],
  awaiting: null,
  connection: 'connecting',
  modes: null,
  configOptions: [],
  plan: null,
  commands: [],
  error: null,
  loading: true,
  truncated: false,
  loadingHistory: false,
  rebuilds: 0,
};

/** A permission request that has been shown but not yet answered. */
interface OpenApproval {
  /** The tool call the request is about. */
  toolCallId: string;
  /**
   * What the request offered, so the card can be drawn again on the tool call
   * a refetch rebuilt.
   */
  options: PermissionOption[];
  /** Sends the answer back to the gateway. */
  resolve: (response: RequestPermissionResponse) => void;
}

/** How the store reaches the outside world; swapped wholesale in tests. */
export interface ThreadStoreDeps {
  /** Builds the client. A test supplies a fake. */
  createClient: (handlers: ConstructorParameters<typeof AcpClient>[2]) => AcpClient;
  /** The box this thread belongs to. */
  boxId: string;
  /** The thread within it. */
  threadId: string;
}

/**
 * The live state of one thread: the ACP connection, the message model built
 * from it, and the actions the view can take.
 *
 * React reads it through useSyncExternalStore. It has no React dependency, so
 * tests run without a renderer.
 */
export class ThreadStore {
  /** The message model, mutated as updates arrive. */
  private model: ThreadModel = emptyModel();
  /** The published state. */
  private snapshot: ThreadSnapshot;
  /** The snapshot's copy of each message, refreshed only when it changes. */
  private views = new Map<Message, Message>();
  /** The subscribers to wake on every publish. */
  private readonly listeners = new Set<() => void>();
  /** The permission requests still open, oldest first, by approval id. */
  private readonly approvals = new Map<string, OpenApproval>();
  /** The connection, or null before `start` and after `dispose`. */
  private client: AcpClient | null = null;
  /**
   * Whether the gateway says the agent is talking.
   *
   * A new store has sent nothing, yet a turn may already run, because the
   * orchestrator is the ACP client of record. The gateway sends this after
   * the replay and on every change.
   */
  private speakingUpstream = false;
  /** What the gateway says the thread has left running. */
  private backgroundUpstream: readonly BackgroundProcess[] = [];
  /** The number for the next approval id. */
  private nextApprovalId = 1;
  /**
   * True from the moment a connection says it is about to replay until the
   * replay has been read.
   *
   * A replay arrives as one notification per chunk. The store builds the
   * model without publishing and publishes it once at the end, so the view
   * renders the conversation once.
   */
  private replaying = false;
  /**
   * The message this store last named as the resume point, or null when it
   * asked for the whole thread.
   *
   * The load carries the point, and a later notification says whether the
   * gateway found it, so the store keeps it until then.
   */
  private resumeAnchor: string | null = null;
  /**
   * Whether the model lacks the oldest messages of the thread. Published with
   * the replay that set it.
   */
  private truncated = false;
  /** The number of rebuilds so far. Published with the replay that did it. */
  private rebuilds = 0;

  /** @param deps The client factory and the ids of the thread. */
  constructor(private readonly deps: ThreadStoreDeps) {
    this.snapshot = INITIAL_SNAPSHOT;
  }

  // --- React glue ----------------------------------------------------------

  /** Adds a subscriber and returns the function that removes it. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The published state. */
  getSnapshot = (): ThreadSnapshot => this.snapshot;

  /** Publishes a new snapshot and wakes every subscriber. */
  private emit(patch: Partial<ThreadSnapshot> = {}): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      isRunning: this.running,
      background: this.backgroundUpstream,
      awaiting: this.awaiting,
    };
    for (const l of this.listeners) l();
  }

  /**
   * Whether the agent is talking, as the gateway reports it.
   *
   * A turn blocked on a permission request counts as not running. The
   * runtime shows an open approval only while the thread is not running, so
   * a running thread would hide the question and block the turn.
   */
  private get running(): boolean {
    return this.speakingUpstream && this.approvals.size === 0;
  }

  /**
   * What the oldest open request asks for, or null when none is open.
   *
   * The oldest request holds the turn up, and the view takes the reader to
   * it.
   */
  private get awaiting(): Awaiting | null {
    for (const approval of this.approvals.keys()) {
      return isQuestion(this.optionsFor(approval)) ? 'question' : 'permission';
    }
    return null;
  }

  /**
   * The snapshot's copy of every message the model holds, with `touched`
   * copied again.
   *
   * The model is mutated in place while a message streams. A new copy of the
   * changed message gives the view a new identity to re-render on.
   */
  private messageViews(touched: Message | null): readonly Message[] {
    if (touched) this.views.set(touched, { ...touched, parts: [...touched.parts] });
    return this.model.messages.map((m) => {
      const view = this.views.get(m);
      if (view) return view;
      const fresh = { ...m, parts: [...m.parts] };
      this.views.set(m, fresh);
      return fresh;
    });
  }

  /** Publishes the messages, unless a replay is still being read. */
  private refreshMessages(touched: Message | null): void {
    if (this.replaying) {
      // flushReplay copies every message at the end of a replay.
      return;
    }
    this.emit({ messages: this.messageViews(touched) });
  }

  // --- lifecycle -----------------------------------------------------------

  /** Connects and starts the handshake. */
  start(): void {
    this.client = this.deps.createClient({
      onUpdate: (params) => this.onUpdate(params),
      onPermission: (params, signal) => this.onPermission(params, signal),
      onReady: (modes, configOptions) => {
        this.model.modes = modes;
        this.model.configOptions = configOptions;
        this.emit({ modes, configOptions, error: null });
        // The replay is in the model by now, and this publishes it.
        this.flushReplay();
      },
      // Skips a repeated state, because a publish re-renders the whole thread
      // and the client reports 'reconnecting' twice per attempt.
      onState: (connection) => {
        if (connection !== this.snapshot.connection) this.emit({ connection });
      },
      onError: (message) => this.emit({ error: message }),
      onTurnState: (state) => {
        this.speakingUpstream = state.speaking;
        this.backgroundUpstream = state.background;
        this.emit();
      },
      resumePoint: () => {
        this.resumeAnchor = this.lastNamedMessage();
        return this.resumeAnchor;
      },
      onReplay: (resumed, truncated) => {
        if (resumed) {
          this.resume();
          return;
        }
        // Only a replay of the whole thread says whether the store is cut.
        this.truncated = truncated;
        this.reset();
      },
    });
    this.client.start();
  }

  /** Closes the connection and answers every open approval as cancelled. */
  dispose(): void {
    this.client?.dispose();
    this.client = null;
    this.failOpenApprovals();
  }

  /**
   * Throws away the model because a replay of the whole thread is about to
   * rebuild it. Keeping it would double every message.
   *
   * The published messages stay until the replay has been read, so a
   * reconnect does not blank the conversation.
   *
   * `keepApprovals` is for a replay on a connection that is still up, where
   * cancelling an open question would reach the agent and refuse the tool
   * call. {@link refetch} uses it.
   */
  private reset(opts: { keepApprovals?: boolean } = {}): void {
    const { modes, configOptions } = this.model;
    this.model = emptyModel();
    this.model.modes = modes;
    this.model.configOptions = configOptions;
    this.views = new Map();
    this.rebuilds++;
    // The gateway states the turn and the background work again after the
    // replay.
    this.speakingUpstream = false;
    this.backgroundUpstream = [];
    if (!opts.keepApprovals) this.failOpenApprovals();
    this.replaying = true;
    // Publishes the derived fields only. The messages, the plan and the
    // commands stay until the replay lands.
    this.emit();
  }

  /**
   * The id of the last message the adapter named, where a replay can resume.
   * Null when there is none, and then the whole thread has to come.
   *
   * A message this model numbered itself, such as one that opens with a tool
   * call, has an id the replay never repeats.
   */
  private lastNamedMessage(): string | null {
    for (let i = this.model.messages.length - 1; i >= 0; i--) {
      const message = this.model.messages[i]!;
      if (message.named) return message.id;
    }
    return null;
  }

  /**
   * Cuts the thread back to the resume point, because the replay about to
   * arrive starts there.
   *
   * The message the point names goes, with everything after it. The replay
   * builds them again. The messages before it stay, because the gateway does
   * not send them again.
   *
   * When no message matches the point, the store resets and rebuilds the
   * thread from the replay.
   */
  private resume(): void {
    const dropped = this.resumeAnchor ? truncateFrom(this.model, this.resumeAnchor) : [];
    if (dropped.length === 0) {
      this.reset();
      return;
    }
    // The questions came over the connection that has gone. The gateway asks
    // the ones still open again after the replay.
    this.failOpenApprovals();
    for (const { part } of this.model.tools.values()) delete part.approval;
    // The gateway states the turn and the background work again after the
    // replay.
    this.speakingUpstream = false;
    this.backgroundUpstream = [];
    this.replaying = true;
    this.emit();
  }

  /**
   * Publishes what a replay built, in one snapshot.
   *
   * The store calls it once session/load has answered, after the last of the
   * history. A replay that never finishes publishes nothing, and the view
   * keeps what it showed before.
   */
  private flushReplay(): void {
    if (!this.replaying) return;
    this.replaying = false;
    this.emit({
      messages: this.messageViews(null),
      plan: this.model.plan,
      commands: this.model.commands,
      loading: false,
      truncated: this.truncated,
      rebuilds: this.rebuilds,
    });
  }

  /**
   * Answers every open approval as cancelled and forgets it.
   *
   * Every caller has lost its connection, so the answer reaches nobody. The
   * gateway asks a question that still waits again after the replay.
   */
  private failOpenApprovals(): void {
    for (const open of this.approvals.values()) {
      open.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.approvals.clear();
  }

  /**
   * Puts the questions that were open before a refetch back on the tool calls
   * the replay rebuilt.
   *
   * A question whose tool call the replay did not bring back is answered
   * cancelled, so the agent can move on.
   */
  private restoreApprovals(): void {
    for (const [id, open] of [...this.approvals]) {
      const part = findTool(this.model, open.toolCallId);
      if (!part) {
        this.respondToApproval(id, undefined);
        continue;
      }
      part.approval = { id, options: open.options };
    }
  }

  // --- incoming ------------------------------------------------------------

  /** Applies one session/update and publishes what changed. */
  private onUpdate(params: ThreadNotification): void {
    const touched = applyUpdate(this.model, params.update);
    // flushReplay publishes what a replay built.
    if (this.replaying) return;
    if (
      this.snapshot.modes !== this.model.modes ||
      this.snapshot.configOptions !== this.model.configOptions ||
      this.snapshot.plan !== this.model.plan ||
      this.snapshot.commands !== this.model.commands
    ) {
      this.emit({
        modes: this.model.modes,
        configOptions: this.model.configOptions,
        plan: this.model.plan,
        commands: this.model.commands,
      });
    }
    this.refreshMessages(touched);
  }

  /**
   * Attaches an incoming permission request to the tool call it is about, so
   * the options render inside that call rather than as a separate prompt.
   *
   * The promise resolves when the user picks, which unblocks the agent's
   * turn. A request the gateway withdraws, for example because another
   * browser answered it, resolves as cancelled.
   */
  private onPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const toolCallId = params.toolCall?.toolCallId;
    // A request that names no call has no card to show on, so it is answered
    // cancelled.
    if (!toolCallId) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const id = `approval-${this.nextApprovalId++}`;

    // The call may not have been announced yet; make a placeholder so the
    // question has somewhere to live.
    let part = findTool(this.model, toolCallId);
    if (!part) {
      const touched = applyUpdate(this.model, {
        ...params.toolCall,
        sessionUpdate: UPDATE_KIND.toolCallUpdate,
      });
      part = findTool(this.model, toolCallId);
      this.refreshMessages(touched);
    }
    if (!part) return Promise.resolve({ outcome: { outcome: 'cancelled' } });

    const options = params.options ?? [];
    part.approval = { id, options };

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.approvals.set(id, { toolCallId, options, resolve });
      signal.addEventListener('abort', () => this.respondToApproval(id, undefined), {
        once: true,
      });
      this.refreshMessages(this.messageOfTool(toolCallId));
    });
  }

  /** The message holding a tool call, for a targeted snapshot refresh. */
  private messageOfTool(toolCallId: string): Message | null {
    return messageOfTool(this.model, toolCallId);
  }

  // --- actions -------------------------------------------------------------

  /**
   * Shows an error that happened on the way to a send.
   *
   * The composer's own failures, such as a refused upload, never reach the
   * socket, and the send button does not await them.
   */
  reportError(message: string): void {
    this.emit({ error: message });
  }

  /**
   * Sends a prompt and tracks the turn while it runs.
   *
   * The prompt is a list of content blocks, because an attachment adds a
   * block beside the prose.
   */
  async send(blocks: readonly ContentBlock[]): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('not connected');
    const sessionId = client.sessionId;
    if (!sessionId) throw new Error('no ACP thread yet');
    if (blocks.length === 0) return;

    this.emit({ error: null });
    try {
      await client.request(ACP_METHOD.sessionPrompt, {
        sessionId,
        prompt: blocks,
      });
    } catch (err) {
      this.emit({ error: (err as Error).message });
      throw err;
    } finally {
      // The gateway's turn state decides whether the agent still works.
      this.emit();
    }
  }

  /** Cancels the running turn. The prompt request resolves on its own after. */
  cancel(): void {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    client.notify(ACP_METHOD.sessionCancel, { sessionId });
    // Stops the spinner without waiting for the gateway, because the turn may
    // be one another browser started. The gateway reports what becomes of the
    // background work.
    this.speakingUpstream = false;
    this.emit();
  }

  /** Switches the adapter into another of its advertised modes. */
  async setMode(modeId: string): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    // Optimistic: current_mode_update confirms it, and a failure puts it back.
    const before = this.model.modes;
    if (before) {
      this.model.modes = { ...before, currentModeId: modeId };
      this.emit({ modes: this.model.modes });
    }
    try {
      await client.request(ACP_METHOD.sessionSetMode, { sessionId, modeId });
    } catch (err) {
      this.model.modes = before;
      this.emit({ modes: before, error: (err as Error).message });
    }
  }

  /**
   * Sets one of the adapter's configuration options, such as the model it
   * answers with.
   */
  async setConfigOption(configId: string, value: string): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    // Optimistic: config_option_update confirms it, and a failure puts it back.
    const before = this.model.configOptions;
    this.model.configOptions = before.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option,
    );
    this.emit({ configOptions: this.model.configOptions });
    try {
      await client.request(ACP_METHOD.sessionSetConfigOption, { sessionId, configId, value });
    } catch (err) {
      this.model.configOptions = before;
      this.emit({ configOptions: before, error: (err as Error).message });
    }
  }

  /**
   * Answers a permission request. `optionId` picks one of the offered
   * options. Without it the request is cancelled, which the adapter expects
   * when the user declines to choose.
   */
  respondToApproval(approvalId: string, optionId: string | undefined): void {
    const open = this.approvals.get(approvalId);
    if (!open) return;
    this.approvals.delete(approvalId);

    const part = findTool(this.model, open.toolCallId);
    if (part?.approval) {
      part.approval = optionId
        ? { ...part.approval, optionId }
        : { ...part.approval, resolution: 'cancelled' };
    }
    this.refreshMessages(this.messageOfTool(open.toolCallId));

    open.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
  }

  /** The options offered for an approval that is still open. */
  optionsFor(approvalId: string): PermissionOption[] {
    const open = this.approvals.get(approvalId);
    if (!open) return [];
    return findTool(this.model, open.toolCallId)?.approval?.options ?? [];
  }

  /**
   * Asks the adapter to replay the thread, rebuilding the model from what it
   * sends back.
   *
   * The load runs on a connection that is already up, so no `onReady` follows
   * and this method publishes the replay itself. A failed load still
   * publishes what arrived, so the view does not stay frozen.
   */
  async refetch(): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    // Keeps the open questions, because a cancel would reach the agent on the
    // live connection. restoreApprovals puts them back on the rebuilt calls.
    this.reset({ keepApprovals: true });
    try {
      await client.request(ACP_METHOD.sessionLoad, loadParams(sessionId));
    } finally {
      this.restoreApprovals();
      this.flushReplay();
    }
  }

  /**
   * Asks for the full history of the thread, which the gateway has the
   * adapter replay again. It replaces the model once it has arrived.
   *
   * The gateway refuses while the thread works. The gateway's replay notice
   * resets the store, so a refusal leaves the thread as it was. The reason
   * shows as an error.
   */
  async loadFullHistory(): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId || this.snapshot.loadingHistory) return;
    this.emit({ loadingHistory: true, error: null });
    try {
      await client.request(ACP_METHOD.sessionLoad, loadParams(sessionId, null, true));
    } catch (err) {
      this.emit({ error: (err as Error).message });
    } finally {
      this.flushReplay();
      this.emit({ loadingHistory: false });
    }
  }
}

/**
 * Whether an open request is a question rather than a permission gate.
 *
 * ACP carries both as a permission request, and the options tell them
 * apart. A gate offers at most one allow option of each kind, such as allow
 * once and allow always. A question offers two or more allow options of the
 * same kind, because each is a different course of action. Leaving plan
 * mode is an example.
 */
function isQuestion(options: readonly PermissionOption[]): boolean {
  const seen = new Set<string>();
  for (const option of options) {
    if (!option.kind?.startsWith('allow')) continue;
    if (seen.has(option.kind)) return true;
    seen.add(option.kind);
  }
  return false;
}
