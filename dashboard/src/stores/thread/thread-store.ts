import type {
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModeState,
  SessionNotification,
} from './acp-types.ts';
import { AcpClient, type ConnectionState } from './acp-client.ts';
import {
  applyUpdate,
  emptyModel,
  findTool,
  type Message,
  type ThreadModel,
} from './translate.ts';

/**
 * One session's thread: the ACP connection, the message model built from it,
 * and the actions the view can take.
 *
 * Framework-free on purpose. React reads it through useSyncExternalStore and
 * everything here is unit-testable without a renderer.
 */

/** What the view renders. Every field is replaced, never mutated. */
export interface ThreadSnapshot {
  messages: readonly Message[];
  /** True while a prompt is in flight upstream. */
  isRunning: boolean;
  connection: ConnectionState;
  modes: SessionModeState | null;
  plan: PlanEntry[] | null;
  /** The last send or connection error, or null. */
  error: string | null;
}

/** A permission request that has been shown but not yet answered. */
interface OpenApproval {
  toolCallId: string;
  resolve: (response: RequestPermissionResponse) => void;
}

/** How the store reaches the outside world; swapped wholesale in tests. */
export interface ThreadStoreDeps {
  /** Builds the client. Present so a test can supply a fake. */
  createClient: (handlers: ConstructorParameters<typeof AcpClient>[2]) => AcpClient;
}

/** The live thread for one Boxes session. */
export class ThreadStore {
  private model: ThreadModel = emptyModel();
  private snapshot: ThreadSnapshot;
  /** The snapshot's copy of each message, refreshed only when it changes. */
  private views = new Map<Message, Message>();
  private readonly listeners = new Set<() => void>();
  private readonly approvals = new Map<string, OpenApproval>();
  private client: AcpClient | null = null;
  private promptsInFlight = 0;
  private nextApprovalId = 1;

  constructor(private readonly deps: ThreadStoreDeps) {
    this.snapshot = {
      messages: [],
      isRunning: false,
      connection: 'connecting',
      modes: null,
      plan: null,
      error: null,
    };
  }

  // --- React glue ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ThreadSnapshot => this.snapshot;

  /** Publishes a new snapshot and wakes every subscriber. */
  private emit(patch: Partial<ThreadSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  /**
   * Refreshes the snapshot's messages.
   *
   * The model is mutated in place while a message streams, so the snapshot
   * holds a separate copy of each message and replaces only the one that
   * changed. Without that, a re-render would see the same object identity and
   * could show text that has already moved on.
   */
  private refreshMessages(touched: Message | null): void {
    if (touched) this.views.set(touched, { ...touched, parts: [...touched.parts] });
    const messages = this.model.messages.map((m) => {
      const view = this.views.get(m);
      if (view) return view;
      const fresh = { ...m, parts: [...m.parts] };
      this.views.set(m, fresh);
      return fresh;
    });
    this.emit({ messages });
  }

  // --- lifecycle -----------------------------------------------------------

  /** Connects and starts the handshake. */
  start(): void {
    this.client = this.deps.createClient({
      onUpdate: (params) => this.onUpdate(params),
      onPermission: (params) => this.onPermission(params),
      onReady: (modes) => {
        this.model.modes = modes;
        this.emit({ modes, error: null });
      },
      onState: (connection) => this.emit({ connection }),
      onResetThread: () => this.reset(),
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
   * Throws away the model because a replay is about to rebuild it.
   *
   * A reconnect repeats the handshake, and session/load re-sends the whole
   * history as notifications. Keeping what was there would double it.
   */
  private reset(): void {
    const modes = this.model.modes;
    this.model = emptyModel();
    this.model.modes = modes;
    this.views = new Map();
    this.failOpenApprovals();
    this.emit({ messages: [], plan: null });
  }

  /**
   * Drops approvals whose JSON-RPC request died with the connection. The
   * adapter re-asks on the new one, so answering the old ids would answer
   * nothing.
   */
  private failOpenApprovals(): void {
    this.approvals.clear();
  }

  // --- incoming ------------------------------------------------------------

  private onUpdate(params: SessionNotification): void {
    const touched = applyUpdate(this.model, params.update);
    if (this.snapshot.modes !== this.model.modes || this.snapshot.plan !== this.model.plan) {
      this.emit({ modes: this.model.modes, plan: this.model.plan });
    }
    this.refreshMessages(touched);
  }

  /**
   * Attaches an incoming permission request to the tool call it is about, so
   * the options render inside that call rather than as a separate prompt.
   *
   * The promise resolves when the user picks, which is what unblocks the
   * agent's turn. A request the adapter cancels resolves as cancelled.
   */
  private onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const toolCallId = params.toolCall?.toolCallId ?? '';
    const id = `approval-${this.nextApprovalId++}`;

    // The call may not have been announced yet; make a placeholder so the
    // question has somewhere to live.
    let part = findTool(this.model, toolCallId);
    if (!part) {
      const touched = applyUpdate(this.model, {
        ...params.toolCall,
        sessionUpdate: 'tool_call_update',
      });
      part = findTool(this.model, toolCallId);
      this.refreshMessages(touched);
    }
    if (!part) return Promise.resolve({ outcome: { outcome: 'cancelled' } });

    part.approval = { id, options: params.options ?? [] };

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.approvals.set(id, { toolCallId, resolve });
      this.refreshMessages(this.messageOfTool(toolCallId));
    });
  }

  /** The message holding a tool call, for a targeted snapshot refresh. */
  private messageOfTool(toolCallId: string): Message | null {
    return (
      this.model.messages.find((m) =>
        m.parts.some((p) => p.type === 'tool' && p.toolCallId === toolCallId),
      ) ?? null
    );
  }

  // --- actions -------------------------------------------------------------

  /** Sends a prompt and tracks the turn while it runs. */
  async send(text: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('not connected');
    const sessionId = client.sessionId;
    if (!sessionId) throw new Error('no ACP thread yet');

    this.promptsInFlight++;
    this.emit({ isRunning: true, error: null });
    try {
      await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    } catch (err) {
      this.emit({ error: (err as Error).message });
      throw err;
    } finally {
      this.promptsInFlight--;
      if (this.promptsInFlight === 0) this.emit({ isRunning: false });
    }
  }

  /** Cancels the running turn. The prompt request resolves on its own after. */
  cancel(): void {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    client.notify('session/cancel', { sessionId });
    this.emit({ isRunning: false });
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
      await client.request('session/set_mode', { sessionId, modeId });
    } catch (err) {
      this.model.modes = before;
      this.emit({ modes: before, error: (err as Error).message });
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

  /** Re-runs the handshake, which rebuilds the thread from the adapter's replay. */
  async refetch(): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    this.reset();
    await client.request('session/load', {
      sessionId,
      cwd: '/workspace',
      mcpServers: [],
    });
  }
}
