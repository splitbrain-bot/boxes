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
 * One box's thread: the ACP connection, the message model built from it,
 * and the actions the view can take.
 *
 * Framework-free on purpose. React reads it through useSyncExternalStore and
 * everything here is unit-testable without a renderer.
 */

/**
 * What the thread is blocked on the user for.
 *
 * `permission` is the gate: may this tool call proceed. `question` is the
 * agent asking which of several courses to take — leaving plan mode is the
 * one Boxes meets most, since a fork starts there. The two are one ACP
 * mechanism and two different things to a reader, which is why the tab says
 * which it is rather than only that something is waiting.
 */
export type Awaiting = 'permission' | 'question';

/** What the view renders. Every field is replaced, never mutated. */
export interface ThreadSnapshot {
  messages: readonly Message[];
  /**
   * True while the agent is producing output: text, thinking, a tool call of
   * its own.
   *
   * Not whether a prompt is open. The adapter holds a prompt open until the
   * subagents a turn spawned settle, so a thread can be waiting for its
   * reader for an hour with a prompt still in flight, and a thread the
   * harness wakes to report a task has no prompt open while it works. The
   * gateway decides this.
   */
  isRunning: boolean;
  /**
   * What this conversation has left running in its box — a command still
   * going, a monitor watching something. Usually empty, and while it is not,
   * a quiet thread is quiet with something still going on.
   */
  background: readonly BackgroundProcess[];
  /** What the thread is waiting for an answer to, or null. */
  awaiting: Awaiting | null;
  connection: ConnectionState;
  modes: ThreadModeState | null;
  /** The options the adapter lets a client set, such as the model. */
  configOptions: readonly ThreadConfigOption[];
  plan: PlanEntry[] | null;
  /** The slash commands the adapter accepts, for the composer to complete. */
  commands: AvailableCommand[];
  /** The last send or connection error, or null. */
  error: string | null;
  /**
   * True until a replay has been read into this store.
   *
   * What the view shows meanwhile is a placeholder, not an empty thread: a
   * composer over a greeting is a claim that there is nothing here to read,
   * and on arrival at a box with a conversation in it that claim is wrong and
   * about to be replaced.
   */
  loading: boolean;
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
};

/** A permission request that has been shown but not yet answered. */
interface OpenApproval {
  toolCallId: string;
  /**
   * What the request offered, so the card can be drawn again on the tool call
   * a refetch rebuilt.
   */
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
}

/** How the store reaches the outside world; swapped wholesale in tests. */
export interface ThreadStoreDeps {
  /** Builds the client. Present so a test can supply a fake. */
  createClient: (handlers: ConstructorParameters<typeof AcpClient>[2]) => AcpClient;
  /** The box this thread belongs to. */
  boxId: string;
  /**
   * The thread within it, and null on the route that means whichever thread
   * the box has current.
   */
  threadId: string | null;
}

/** The live thread for one box. */
export class ThreadStore {
  private model: ThreadModel = emptyModel();
  private snapshot: ThreadSnapshot;
  /** The snapshot's copy of each message, refreshed only when it changes. */
  private views = new Map<Message, Message>();
  private readonly listeners = new Set<() => void>();
  private readonly approvals = new Map<string, OpenApproval>();
  private client: AcpClient | null = null;
  /**
   * What the gateway says this thread is doing, which is not the same
   * question as what this browser sent.
   *
   * A store lives for as long as the view is on screen, so stepping into the
   * review and back builds a fresh one with nothing in flight — while the
   * turn it left behind is still going, because the orchestrator is the ACP
   * client of record. This is what the gateway tells it after the replay, and
   * again on every transition.
   */
  private speakingUpstream = false;
  private backgroundUpstream: readonly BackgroundProcess[] = [];
  private nextApprovalId = 1;
  /**
   * True from the moment a connection says it is about to replay until the
   * replay has been read.
   *
   * A replay arrives as one notification per chunk of what was said — the
   * whole conversation, in the order it happened, as fast as the socket
   * delivers it. Publishing each one meant the view rebuilt itself dozens of
   * times on arrival: every message appearing on its own line, the viewport
   * chasing the bottom, the reading position landing wherever the last render
   * left it. So the model is built up in here and published once, which is
   * also what lets the view show one placeholder instead of a conversation
   * assembling itself.
   */
  private replaying = false;
  /**
   * The message this store last asked a replay to be picked up after, or null
   * when it asked for the thread whole.
   *
   * Held because the question and its answer are two messages: the load
   * carries the point, and the gateway says in its own notification whether
   * it could be honoured.
   */
  private resumeAnchor: string | null = null;

  constructor(private readonly deps: ThreadStoreDeps) {
    this.snapshot = INITIAL_SNAPSHOT;
  }

  // --- React glue ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

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
   * Whether the agent is saying anything.
   *
   * The gateway's answer rather than this browser's: it marks a thread as
   * working the moment it forwards a prompt, so the browser that sent one has
   * its spinner in a single hop, and stops when the agent has gone quiet,
   * which only something watching the whole stream can see. A prompt this
   * browser still has in flight proves nothing either way, so it is not
   * consulted here.
   *
   * A turn blocked on a permission request is not running, it is waiting for
   * the user — which is the whole point of the request. Saying otherwise
   * would also hide the question: the runtime derives a message's
   * requires-action status from its unresolved approval only while the
   * thread is not running, so a permanently-running thread would render a
   * spinner where the buttons belong and deadlock the turn.
   */
  private get running(): boolean {
    return this.speakingUpstream && this.approvals.size === 0;
  }

  /**
   * What the oldest open request is asking for, or null when none is open.
   *
   * The oldest rather than the newest: it is the one that has been holding
   * the turn up, and it is the one the reader is being taken to.
   */
  private get awaiting(): Awaiting | null {
    for (const approval of this.approvals.keys()) {
      return isQuestion(this.optionsFor(approval)) ? 'question' : 'permission';
    }
    return null;
  }

  /**
   * The snapshot's copy of every message the model holds, with `touched`
   * taken again.
   *
   * The model is mutated in place while a message streams, so the snapshot
   * holds a separate copy of each message and replaces only the one that
   * changed. Without that, a re-render would see the same object identity and
   * could show text that has already moved on.
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
      // Nothing is published mid-replay, and nothing needs to be kept either:
      // flushReplay takes every message again.
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
        // Everything the replay said is in the model by now; this is where it
        // reaches the view.
        this.flushReplay();
      },
      // A state the snapshot already holds is not news, and a publish
      // re-renders the whole thread. The client reports 'reconnecting' twice
      // on every attempt, which is two of them for nothing.
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
      onReplay: (resumed) => (resumed ? this.resume() : this.reset()),
    });
    this.client.start();
  }

  /** Closes the connection and forgets everything. */
  dispose(): void {
    this.client?.dispose();
    this.client = null;
    this.failOpenApprovals();
  }

  /**
   * Throws away the model because a replay of the whole thread is about to
   * rebuild it.
   *
   * The gateway says so before the first of that replay arrives. Keeping what
   * was there would double every message in it.
   *
   * What the view is showing is left alone until the replay has been read:
   * the model is what is stale, and blanking a conversation somebody is
   * reading — because the socket dropped and came back — says the thread is
   * empty when what is true is that it is being re-read.
   *
   * `keepApprovals` is for a replay on a connection that is still up, where
   * cancelling an open question would reach the agent and refuse the tool
   * call it is about. See {@link refetch}.
   */
  private reset(opts: { keepApprovals?: boolean } = {}): void {
    const { modes, configOptions } = this.model;
    this.model = emptyModel();
    this.model.modes = modes;
    this.model.configOptions = configOptions;
    this.views = new Map();
    // Whatever was said about the thread belonged to the connection that is
    // being replaced. The gateway says it again after this replay — including
    // what is still running in the background, which is the only way this
    // browser can learn it.
    this.speakingUpstream = false;
    this.backgroundUpstream = [];
    if (!opts.keepApprovals) this.failOpenApprovals();
    this.replaying = true;
    // A snapshot with no patch: what the thread is doing is re-derived — the
    // turn claim is gone and so are the open questions — while the messages,
    // the plan and the commands stay as they were until the replay lands.
    this.emit();
  }

  /**
   * The last message the adapter named, which is where a replay can be picked
   * up. Null when there is none, and then the thread has to come whole.
   *
   * The adapter's own id and no other: a message this model numbered itself,
   * one that opens with a tool call, carries a name only this browser knows,
   * and a replay never says it back.
   */
  private lastNamedMessage(): string | null {
    for (let i = this.model.messages.length - 1; i >= 0; i--) {
      const message = this.model.messages[i]!;
      if (message.named) return message.id;
    }
    return null;
  }

  /**
   * Takes the thread back to the resume point, because the replay about to
   * arrive starts there.
   *
   * The message the point names goes, and everything after it, to be built
   * again from what arrives. What is in front of it stays: that is the part
   * the gateway is not sending, and re-reading a conversation the reader
   * already has is what a resume exists to avoid.
   *
   * Folding the tail onto what is left produces the same model as folding the
   * whole thread would, because the model is nothing but the updates applied
   * in order and this is a cut across that order.
   *
   * A point nothing answers to leaves no place to join the tail to, so the
   * thread is thrown away and rebuilt from what comes.
   */
  private resume(): void {
    const dropped = this.resumeAnchor ? truncateFrom(this.model, this.resumeAnchor) : [];
    if (dropped.length === 0) {
      this.reset();
      return;
    }
    // The questions this store was showing were asked over the connection
    // that has gone, and nobody is listening for the answers. The gateway
    // puts the ones still open back after the replay.
    this.failOpenApprovals();
    for (const { part } of this.model.tools.values()) delete part.approval;
    // Whatever was said about the thread belonged to that connection too; the
    // gateway says it again after this replay.
    this.speakingUpstream = false;
    this.backgroundUpstream = [];
    this.replaying = true;
    this.emit();
  }

  /**
   * Publishes what a replay built, in one snapshot.
   *
   * Called when the connection reports itself ready, which for a browser that
   * asked for a replay is the moment session/load answered — after the last
   * of the history has arrived. A replay that never finishes publishes
   * nothing: the connection is reconnecting, the view keeps saying so, and a
   * half-read conversation is not a better answer than the placeholder or
   * than what was there before.
   */
  private flushReplay(): void {
    if (!this.replaying) return;
    this.replaying = false;
    // One snapshot, so the view renders the conversation once rather than
    // once per message in it.
    this.emit({
      messages: this.messageViews(null),
      plan: this.model.plan,
      commands: this.model.commands,
      loading: false,
    });
  }

  /**
   * Gives up the approvals this store can no longer show, answering each as
   * cancelled on the way out.
   *
   * Every caller is a connection that is gone: one that died and is being
   * replayed, one whose resume point could not be found, or a store being
   * disposed. The answer reaches nobody, and the gateway puts a question that
   * is still waiting back after the replay. A refetch runs on a live
   * connection and keeps its questions instead — see {@link restoreApprovals}.
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
   * A question whose tool call the replay did not bring back has nowhere to
   * be shown and so nowhere to be answered from; it is answered cancelled,
   * which is what keeps the agent moving.
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

  private onUpdate(params: ThreadNotification): void {
    const touched = applyUpdate(this.model, params.update);
    // A replay's own notifications say nothing on their way past; flushReplay
    // publishes what they built.
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
   * The promise resolves when the user picks, which is what unblocks the
   * agent's turn. A request the adapter cancels resolves as cancelled, and so
   * does one the gateway withdraws because another browser answered it: the
   * card comes off the tool call either way.
   */
  private onPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const toolCallId = params.toolCall?.toolCallId;
    // A request naming no call is a question with nothing to ask it about.
    // Answering it cancelled leaves the turn moving; drawing it would leave a
    // card with no title and no call behind it in the transcript.
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
   * The composer's own failures — an upload that was refused, a file that
   * could not be read — never reach the socket, so nothing here would
   * otherwise know they happened, and the send button does not await the
   * promise that would have carried them.
   */
  reportError(message: string): void {
    this.emit({ error: message });
  }

  /**
   * Sends a prompt and tracks the turn while it runs.
   *
   * Content blocks rather than a string, because a prompt is not always
   * prose: an attachment puts an image and the note saying where it was
   * saved into the same message. What the blocks are is the view's business,
   * and this only carries them.
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
      // Nothing here is counted: whether the agent is working is the
      // gateway's answer, and a prompt of this browser's own coming back says
      // only that the request is over.
      this.emit();
    }
  }

  /** Cancels the running turn. The prompt request resolves on its own after. */
  cancel(): void {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    client.notify(ACP_METHOD.sessionCancel, { sessionId });
    // The prompt request resolves on its own afterwards; this only stops the
    // view from claiming the agent is still talking, without waiting for the
    // gateway to say so — the turn being cancelled may be one another browser
    // started. What was running in the background is left as it stands: the
    // gateway says what became of it, and guessing here would be this browser
    // inventing an ending.
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
   * options; its absence cancels, which is what the adapter expects when the
   * user declines to choose.
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
   * The publish is here rather than in `onReady`, which is the handshake's
   * own: this load happens on a connection that is already up, so nothing
   * would report itself ready afterwards — and `reset()` has stopped the model
   * from reaching the view until something does. A failed load publishes what
   * arrived before it gave up, which is the same bargain a reconnect makes,
   * because leaving the view frozen on a stale thread is the worse answer.
   */
  async refetch(): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    // The questions open here are open on a live connection, so cancelling
    // them would reach the agent and refuse the tool calls they are about.
    // They are put back on the transcript the replay rebuilds instead.
    this.reset({ keepApprovals: true });
    try {
      await client.request(ACP_METHOD.sessionLoad, loadParams(sessionId));
    } finally {
      this.restoreApprovals();
      this.flushReplay();
    }
  }
}

/**
 * Whether an open request is a question rather than a permission gate.
 *
 * ACP carries both as a permission request, and the options are what tell
 * them apart. A gate offers one way to say yes and one to say no, sometimes
 * doubled by scope — allow once, allow always. A question offers several ways
 * to say yes, because each is a different thing to do: leaving plan mode asks
 * whether to continue in auto, to auto-accept edits, or to approve each one,
 * and none of those is "the same yes, for longer".
 *
 * So: two or more answers of the same kind means the reader is being asked to
 * choose between courses of action, not to permit one.
 *
 * (The adapter's own AskUserQuestion tool would be the other source of these.
 * It is disabled while the client advertises no elicitation support, which
 * this one does not — a form is a surface Boxes has not built.)
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
