import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
} from './acp-types.ts';
import type { TurnStateParams } from '../../../../shared/types.ts';
import type { AcpClient, AcpClientHandlers } from './acp-client.ts';
import { ThreadStore, type ThreadStoreDeps } from './thread-store.ts';
import { convertMessage } from './convert.ts';
import { resetIds, type Message } from './translate.ts';

/**
 * The store against a fake client, which is the whole protocol surface it
 * touches: notifications in, requests out.
 */

/** A stand-in AcpClient that records what the store asks of it. */
class FakeClient {
  sessionId: string | null = 'acp-1';
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  /** Resolvers for requests the test wants to hold open. */
  private readonly held: Array<(v: unknown) => void> = [];
  hold = false;
  fail: string | null = null;
  disposed = false;

  constructor(readonly handlers: AcpClientHandlers) {}

  start(): void {
    this.load();
    this.handlers.onState('ready');
    this.handlers.onReady(this.modes, this.configOptions);
  }

  /**
   * A session/load, as the handshake and a reconnect run one: the store is
   * asked how much it has, and the gateway answers whether the replay picks
   * up there. `resumes` is that answer.
   */
  load(): void {
    const from = this.handlers.resumePoint();
    this.resumePoints.push(from);
    this.handlers.onReplay(this.resumes && from !== null);
  }

  /** The replay is over, which is what publishes what it built. */
  finish(): void {
    this.handlers.onReady(this.modes, this.configOptions);
  }

  /** Whether the next load is answered as a resume rather than a full replay. */
  resumes = false;
  /** The resume point each load asked for, in order. */
  readonly resumePoints: Array<string | null> = [];

  modes: SessionModeState | null = null;
  configOptions: SessionConfigOption[] = [];

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.fail) return Promise.reject(new Error(this.fail));
    if (this.hold) return new Promise((resolve) => this.held.push(resolve));
    return Promise.resolve({});
  }

  /** Finishes the oldest held request. */
  settle(): void {
    this.held.shift()?.({});
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A store wired to a fake client, already started. */
function makeStore(
  configure?: (c: FakeClient) => void,
  deps?: Partial<ThreadStoreDeps>,
): { store: ThreadStore; client: FakeClient } {
  resetIds();
  let client!: FakeClient;
  const store = new ThreadStore({
    sessionId: 'box-1',
    threadId: 'thread-1',
    createClient: (handlers) => {
      client = new FakeClient(handlers);
      configure?.(client);
      return client as unknown as AcpClient;
    },
    ...deps,
  });
  store.start();
  return { store, client };
}

/**
 * Puts a permission request to the store, as the gateway would.
 *
 * `withdrawn` is the signal the gateway aborts when somebody else answers the
 * question first; a test that does not care about that gets one nobody
 * aborts.
 */
function ask(
  client: FakeClient,
  params: RequestPermissionRequest,
  withdrawn: AbortSignal = new AbortController().signal,
): Promise<RequestPermissionResponse> {
  return client.handlers.onPermission(params, withdrawn);
}

/** Pushes one session/update at the store, as the gateway would. */
function push(client: FakeClient, update: SessionUpdate): void {
  client.handlers.onUpdate({ sessionId: 'acp-1', update });
}

/**
 * The converted parts of one message. ThreadMessageLike allows a bare string
 * for content; convertMessage never produces one, so the tests read parts.
 */
function partsOf(message: Message): ConvertedPart[] {
  const content = convertMessage(message).content;
  assert.ok(Array.isArray(content), 'convertMessage always produces parts');
  return content as ConvertedPart[];
}

/** The single text part a shell run writes into the thread. */
function outputOf(message: Message): string {
  const parts = partsOf(message);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, 'text');
  return String((parts[0] as unknown as { text: string }).text);
}

/** One converted part, in the shape the assertions read it. */
type ConvertedPart = {
  type: string;
  text?: string;
  toolName?: string;
  /** Absent while a call is unfinished, which includes awaiting permission. */
  result?: unknown;
  approval?: {
    id: string;
    options?: Array<{ id: string; kind: string; label?: string }>;
    approved?: boolean;
    resolution?: string;
  };
  /** The src of an image part, which is a data URL or a remote https one. */
  image?: string;
};

test('a snapshot changes identity when a streamed message grows', () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hel' },
  } as SessionUpdate);
  const first = store.getSnapshot().messages;

  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'lo' },
  } as SessionUpdate);
  const second = store.getSnapshot().messages;

  // A view that memoised on identity has to see a new object, or it would
  // keep rendering "Hel" after the rest arrived.
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(partsOf(second[0]!), [{ type: 'text', text: 'Hello' }]);
});

test('subscribers are woken on every update', () => {
  const { store, client } = makeStore();
  const listener = vi.fn();
  store.subscribe(listener);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'x' },
  } as SessionUpdate);
  expect(listener).toHaveBeenCalled();
});

/** One command still running, as the gateway reads it out of the box. */
const BUILD = { id: 'aabbccdd', command: 'npm run build', startedAt: null };

/** What the gateway says about a thread, defaulting to a quiet one. */
function threadState(patch: Partial<TurnStateParams> = {}): TurnStateParams {
  return { sessionId: 'acp-1', active: false, speaking: false, background: [], ...patch };
}

test('a prompt of this browser\'s own does not claim the agent is talking', async () => {
  const { store, client } = makeStore((c) => {
    c.hold = true;
  });
  assert.equal(store.getSnapshot().isRunning, false);

  const sent = store.send([{ type: 'text', text: 'hello' }]);
  assert.deepEqual(client.requests[0], {
    method: 'session/prompt',
    params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hello' }] },
  });
  // A request being open says nothing about the agent: the adapter holds one
  // open for as long as the background work a turn started takes to settle.
  // The gateway marks the thread as working when it forwards the prompt, and
  // that is what the view goes by.
  assert.equal(store.getSnapshot().isRunning, false);
  client.handlers.onTurnState(threadState({ active: true, speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  client.settle();
  await sent;
  // Still talking: the prompt coming back is not the agent stopping, and the
  // gateway has not said it has.
  assert.equal(store.getSnapshot().isRunning, true);
  client.handlers.onTurnState(threadState());
  assert.equal(store.getSnapshot().isRunning, false);
});

test("the gateway's turn state runs the thread a browser did not prompt", () => {
  const { store, client } = makeStore();
  assert.equal(store.getSnapshot().isRunning, false);

  // What a browser is told after its replay when it re-opens a thread that
  // is mid-turn: nothing is in flight from here, and the turn is real.
  client.handlers.onTurnState(threadState({ speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  client.handlers.onTurnState(threadState());
  assert.equal(store.getSnapshot().isRunning, false);
});

test('a thread that has stopped talking with work still in it is not running', () => {
  const { store, client } = makeStore();
  // The state this whole vocabulary exists for: the agent has finished, the
  // composer is yours, and a build is still going in the box.
  client.handlers.onTurnState(
    threadState({ active: true, speaking: false, background: [BUILD] }),
  );
  assert.equal(store.getSnapshot().isRunning, false);
  assert.deepEqual(store.getSnapshot().background, [BUILD]);
});

test('a replay drops the turn state it was told before it', () => {
  const { store, client } = makeStore();
  client.handlers.onTurnState(
    threadState({ speaking: true, background: [BUILD] }),
  );
  assert.equal(store.getSnapshot().isRunning, true);

  // A reconnect: the gateway re-states the thread after the replay, so
  // holding the old answer over one would claim a turn nobody has confirmed
  // and a task nobody has said is still running.
  client.handlers.onReplay(false);
  assert.equal(store.getSnapshot().isRunning, false);
  assert.deepEqual(store.getSnapshot().background, []);
});

test('cancel stops a turn this browser did not start', () => {
  const { store, client } = makeStore();
  client.handlers.onTurnState(threadState({ speaking: true }));
  store.cancel();
  assert.deepEqual(client.notifications, [
    { method: 'session/cancel', params: { sessionId: 'acp-1' } },
  ]);
  assert.equal(store.getSnapshot().isRunning, false);
});

test('an open permission request is reported as one', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Write a file',
    status: 'pending',
  } as SessionUpdate);
  void ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ],
  } as RequestPermissionRequest);
  // One way to say yes, doubled by scope, and one to say no: a gate.
  assert.equal(store.getSnapshot().awaiting, 'permission');
});

test('several ways to say yes is a question, not a gate', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Leave plan mode',
    status: 'pending',
  } as SessionUpdate);
  void ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    // What leaving plan mode asks: three different things to do next.
    options: [
      { optionId: 'auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
      { optionId: 'acceptEdits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
      { optionId: 'default', name: 'Yes, and approve each edit', kind: 'allow_once' },
      { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
    ],
  } as RequestPermissionRequest);
  assert.equal(store.getSnapshot().awaiting, 'question');
});

test('answering a request leaves nothing waiting', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Write a file',
    status: 'pending',
  } as SessionUpdate);
  void ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
  } as RequestPermissionRequest);
  assert.equal(store.getSnapshot().awaiting, 'permission');

  store.respondToApproval('approval-1', 'once');
  assert.equal(store.getSnapshot().awaiting, null);
});

test('a failed prompt clears the running state and reports the reason', async () => {
  const { store } = makeStore((c) => {
    c.fail = 'upstream not connected';
  });
  await assert.rejects(() => store.send([{ type: 'text', text: 'hello' }]));
  assert.equal(store.getSnapshot().isRunning, false);
  assert.equal(store.getSnapshot().error, 'upstream not connected');
});

test('cancel notifies the adapter and stops the running state', () => {
  const { store, client } = makeStore((c) => {
    c.hold = true;
  });
  void store.send([{ type: 'text', text: 'long one' }]);
  store.cancel();
  assert.deepEqual(client.notifications, [
    { method: 'session/cancel', params: { sessionId: 'acp-1' } },
  ]);
  assert.equal(store.getSnapshot().isRunning, false);
});

test('a reconnect replay rebuilds the thread instead of doubling it', () => {
  const { store, client } = makeStore();
  const script: SessionUpdate[] = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } as SessionUpdate,
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } as SessionUpdate,
  ];
  for (const u of script) push(client, u);
  assert.equal(store.getSnapshot().messages.length, 2);

  // What a fresh connection with nothing to resume from does: the gateway
  // says the thread is coming whole, and the same history follows.
  client.handlers.onReplay(false);
  // The conversation somebody is reading is not blanked to do that: the model
  // is what went stale, and the socket dropping is not news about the thread.
  assert.equal(store.getSnapshot().messages.length, 2);

  // Nor is the rebuild published on its way past, message by message.
  const during = store.getSnapshot().messages;
  for (const u of script) push(client, u);
  assert.equal(store.getSnapshot().messages, during);

  // The replay answered: what is on screen is what it said, once, and not
  // both copies of it.
  client.handlers.onReady(null, []);
  assert.equal(store.getSnapshot().messages.length, 2);
  assert.notEqual(store.getSnapshot().messages, during);
});

test('a refetch publishes what the replay it asked for rebuilt', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'hi' },
  } as SessionUpdate);
  assert.equal(store.getSnapshot().messages.length, 1);

  // A refetch is a session/load on a connection that is already up, so nothing
  // reports itself ready afterwards the way a handshake does. The store has to
  // end its own replay window, or the model never reaches the view again.
  const done = store.refetch();
  push(client, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'hi' },
  } as SessionUpdate);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello again' },
  } as SessionUpdate);
  await done;

  assert.deepEqual(
    store.getSnapshot().messages.map((m) => m.role),
    ['user', 'assistant'],
    'the replay is published once, and not doubled onto what was there',
  );

  // And the thread is live again: an update after the refetch still lands.
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' and again' },
  } as SessionUpdate);
  assert.match(JSON.stringify(store.getSnapshot().messages), /and again/);
});

test('a refetch keeps an open question rather than refusing the call it is about', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write a file' });
  let settled = false;
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  void answered.then(() => {
    settled = true;
  });

  // The connection is up, so an answer sent here reaches the agent: a refetch
  // that cancelled would refuse the tool call the user is being asked about.
  const done = store.refetch();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write a file' });
  await done;

  assert.equal(settled, false, 'the question is still open for the agent');
  const part = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(part.type, 'tool-call');
  assert.ok(part.approval, 'and it is back on the call the replay rebuilt');

  store.respondToApproval(part.approval.id, 'yes');
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('a question the gateway withdraws stops waiting', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write a file' });
  const withdrawn = new AbortController();
  const answered = ask(
    client,
    {
      sessionId: 'acp-1',
      toolCall: { toolCallId: 't1' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    },
    withdrawn.signal,
  );

  // Another browser on the thread answered first, so this card has nothing
  // left to decide.
  withdrawn.abort();

  assert.deepEqual(await answered, { outcome: { outcome: 'cancelled' } });
  assert.equal(store.getSnapshot().awaiting, null);
});

test('a refetch whose load fails still gives the view back what arrived', async () => {
  const { store, client } = makeStore();
  client.fail = 'adapter is gone';
  await store.refetch().catch(() => undefined);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'still here' },
  } as SessionUpdate);
  assert.equal(store.getSnapshot().messages.length, 1, 'not frozen behind a replay that failed');
});

test('a permission request attaches to its tool call and its answer unblocks the turn', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Write main.ts',
    kind: 'edit',
  });

  const request: RequestPermissionRequest = {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  };
  const answered: Promise<RequestPermissionResponse> = ask(client, request);

  // The options render on the tool call, mapped into approval vocabulary.
  const part = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(part.type, 'tool-call');
  const approval = part.approval;
  assert.ok(approval);
  assert.deepEqual(approval.options, [
    { id: 'yes', kind: 'allow-once', label: 'Allow' },
    { id: 'no', kind: 'reject-once', label: 'Reject' },
  ]);

  store.respondToApproval(approval.id, 'yes');
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('a call awaiting permission reports no result, so the question can render', async () => {
  const { store, client } = makeStore();
  // The shape a real edit arrives in: the adapter sends the diff it proposes
  // before it is allowed to write it.
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 'td',
    title: 'Write hello.txt',
    kind: 'edit',
  });
  push(client, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'td',
    content: [{ type: 'diff', path: '/workspace/hello.txt', oldText: null, newText: 'hello' }],
  });

  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'td' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  // A result of any kind reads to the runtime as a finished call, and a
  // finished call is never the one being asked about.
  const asked = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(asked.type, 'tool-call');
  assert.equal(asked.result, undefined);
  assert.ok(asked.approval);
  assert.equal(asked.approval.approved, undefined);
  assert.equal(asked.approval.resolution, undefined);

  store.respondToApproval(asked.approval.id, 'yes');
  await answered;

  // Once answered the diff is a result again, so the call renders as done.
  const done = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(done.type, 'tool-call');
  assert.match(String(done.result), /\+hello/);
});

test('declining to choose cancels the request rather than answering it', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Delete file' });
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't2' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  store.respondToApproval('approval-1', undefined);
  assert.deepEqual(await answered, { outcome: { outcome: 'cancelled' } });
});

test('a permission request for an unannounced call makes a place for itself', async () => {
  const { store, client } = makeStore();
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'tX', title: 'Run rm -rf' },
    options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }],
  });

  const part = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(part.type, 'tool-call');
  assert.equal(part.toolName, 'Run rm -rf');

  store.respondToApproval('approval-1', 'no');
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'no' } });
});

test('answering the same approval twice does nothing the second time', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Edit' });
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't3' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  store.respondToApproval('approval-1', 'yes');
  store.respondToApproval('approval-1', undefined);
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('the mode switcher sets the mode optimistically and rolls back on failure', async () => {
  const modes: SessionModeState = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'auto', name: 'Auto' },
    ],
  };
  const { store, client } = makeStore((c) => {
    c.modes = modes;
  });
  assert.equal(store.getSnapshot().modes?.currentModeId, 'default');

  await store.setMode('auto');
  assert.deepEqual(client.requests.at(-1), {
    method: 'session/set_mode',
    params: { sessionId: 'acp-1', modeId: 'auto' },
  });
  assert.equal(store.getSnapshot().modes?.currentModeId, 'auto');

  client.fail = 'mode not supported';
  await store.setMode('default');
  assert.equal(store.getSnapshot().modes?.currentModeId, 'auto');
  assert.equal(store.getSnapshot().error, 'mode not supported');
});

test('the model selector sets the option optimistically and rolls back on failure', async () => {
  const configOptions: SessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
  ];
  const { store, client } = makeStore((c) => {
    c.configOptions = configOptions;
  });
  const valueOf = (): string | undefined =>
    store.getSnapshot().configOptions.find((o) => o.id === 'model')?.currentValue;
  assert.equal(valueOf(), 'sonnet');

  await store.setConfigOption('model', 'opus');
  assert.deepEqual(client.requests.at(-1), {
    method: 'session/set_config_option',
    params: { sessionId: 'acp-1', configId: 'model', value: 'opus' },
  });
  assert.equal(valueOf(), 'opus');

  client.fail = 'no such model';
  await store.setConfigOption('model', 'sonnet');
  assert.equal(valueOf(), 'opus');
  assert.equal(store.getSnapshot().error, 'no such model');
});

test('a config_option_update from the adapter moves the model selector', () => {
  const { store, client } = makeStore((c) => {
    c.configOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'opus', name: 'Opus' },
        ],
      },
    ];
  });
  push(client, {
    sessionUpdate: 'config_option_update',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'opus', name: 'Opus' },
        ],
      },
    ],
  });
  assert.equal(
    store.getSnapshot().configOptions.find((o) => o.id === 'model')?.currentValue,
    'opus',
  );
});

test('a current_mode_update from the adapter moves the switcher', () => {
  const { store, client } = makeStore((c) => {
    c.modes = {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    };
  });
  push(client, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  assert.equal(store.getSnapshot().modes?.currentModeId, 'auto');
});

test('disposing closes the client', () => {
  const { store, client } = makeStore();
  store.dispose();
  assert.equal(client.disposed, true);
});

test('a turn blocked on a permission request is not reported as running', async () => {
  const { store, client } = makeStore((c) => {
    c.hold = true;
  });
  void store.send([{ type: 'text', text: 'edit the file' }]);
  client.handlers.onTurnState(threadState({ active: true, speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write main.ts' });
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  // The turn is paused for the user, not progressing. Saying otherwise
  // would hide the very question that is holding it up.
  assert.equal(store.getSnapshot().isRunning, false);

  store.respondToApproval('approval-1', 'yes');
  await answered;
  assert.equal(store.getSnapshot().isRunning, true);

  client.settle();
});

test('a bang command runs locally, streams, and never reaches the adapter', async () => {
  const chunks: string[] = [];
  const { store, client } = makeStore(undefined, {
    runExec: async (sessionId, threadId, command, _after, onChunk) => {
      assert.equal(sessionId, 'box-1');
      // The command is run against the thread it was typed in, not the box.
      assert.equal(threadId, 'thread-1');
      assert.equal(command, 'echo hi');
      onChunk('hi');
      chunks.push('hi');
      onChunk('hi\nthere');
      chunks.push('hi\nthere');
      return { exitCode: 0, truncated: false, timedOut: false };
    },
  });

  await store.runCommand('echo hi');

  // Nothing was sent upstream: a bang line costs no tokens.
  assert.deepEqual(client.requests, []);
  assert.equal(chunks.length, 2);

  const messages = store.getSnapshot().messages;
  // The line as typed, then the output it produced.
  assert.equal(messages[0]!.role, 'user');
  assert.deepEqual(partsOf(messages[0]!), [{ type: 'text', text: '!echo hi' }]);
  assert.equal(outputOf(messages[1]!), '```console\nhi\nthere\n[exit 0]\n```');
});

test('a fence in the output is escaped by a longer one, however it arrives', async () => {
  // The fence is measured as the output grows, so a run of backticks split
  // across two chunks still has to be beaten by the fence around it.
  const { store } = makeStore(undefined, {
    runExec: async (_id, _thread, _cmd, _after, onChunk) => {
      onChunk('start ``');
      onChunk('start ````` end');
      return { exitCode: 0, truncated: false, timedOut: false };
    },
  });

  await store.runCommand('cat notes.md');
  const output = outputOf(store.getSnapshot().messages[1]!);
  // Five backticks in the body, so the fence is six.
  assert.ok(output.startsWith('``````console\n'), output.slice(0, 20));
  assert.ok(output.endsWith('\n``````'), output.slice(-20));
});

test('a non-zero exit shows the code under the output', async () => {
  const { store } = makeStore(undefined, {
    runExec: async (_id, _thread, _cmd, _after, onChunk) => {
      onChunk('bash: nope: command not found');
      return { exitCode: 127, truncated: false, timedOut: false };
    },
  });

  await store.runCommand('nope');
  const output = outputOf(store.getSnapshot().messages[1]!);
  assert.match(output, /bash: nope: command not found/);
  assert.match(output, /\[exit 127\]/);
});

test('a killed or truncated run says so beside its exit code', async () => {
  const { store } = makeStore(undefined, {
    runExec: async (_id, _thread, _cmd, _after, onChunk) => {
      onChunk('a lot of output');
      return { exitCode: null, truncated: true, timedOut: true };
    },
  });

  await store.runCommand('yes');
  assert.match(
    outputOf(store.getSnapshot().messages[1]!),
    /\[exit killed\] · timed out · output truncated/,
  );
});

test('output carrying a fence of its own cannot break out of the block', async () => {
  const { store } = makeStore(undefined, {
    runExec: async (_id, _thread, _cmd, _after, onChunk) => {
      onChunk('```\nnot a fence\n```');
      return { exitCode: 0, truncated: false, timedOut: false };
    },
  });

  await store.runCommand('cat readme.md');
  const output = outputOf(store.getSnapshot().messages[1]!);
  assert.ok(output.startsWith('````console\n'), output);
  assert.ok(output.endsWith('\n````'), output);
});

test('a failed exec request is reported in the thread rather than thrown away', async () => {
  const { store } = makeStore(undefined, {
    runExec: async () => {
      throw new Error('503 exec unavailable');
    },
  });

  await store.runCommand('ls');
  assert.match(outputOf(store.getSnapshot().messages[1]!), /503 exec unavailable/);
});

test('previously run commands are appended once, however often they are loaded', async () => {
  const { store } = makeStore(undefined, {
    listExec: async () => [
      {
        id: 7,
        sessionId: 'box-1',
        command: 'git status',
        output: 'clean\n',
        exitCode: 0,
        truncated: false,
        timedOut: false,
        startedAt: 1,
        finishedAt: 2,
        after: null,
      },
    ],
  });

  await store.loadExecHistory();
  await store.loadExecHistory();
  assert.equal(store.getSnapshot().messages.length, 2);
  assert.deepEqual(partsOf(store.getSnapshot().messages[0]!), [
    { type: 'text', text: '!git status' },
  ]);
});

test('a run names the tool call or message the transcript ended with', async () => {
  const anchors: Array<string | null> = [];
  const { store, client } = makeStore(undefined, {
    runExec: async (_id, _thread, _cmd, after) => {
      anchors.push(after);
      return { exitCode: 0, truncated: false, timedOut: false };
    },
  });

  // Before the agent has said anything there is nothing to come after.
  await store.runCommand('ls');
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'one' },
    messageId: 'msg_1',
  });
  await store.runCommand('ls');
  // A tool call in the message wins over the message's own id: a message
  // that opens with a tool call has none the adapter gave it.
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'two' },
    messageId: 'msg_2',
  });
  push(client, { sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Read', status: 'completed' });
  await store.runCommand('ls');
  // The user's own prompt is echoed without an id a replay would repeat.
  push(client, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'and?' } });
  await store.runCommand('ls');

  assert.deepEqual(anchors, [null, 'msg_1', 'toolu_1', 'toolu_1']);
});

test('replayed runs go back after the message or tool call they followed', async () => {
  const record = (id: number, command: string, after: string | null) => ({
    id,
    sessionId: 'box-1',
    command,
    output: `${command}\n`,
    exitCode: 0,
    truncated: false,
    timedOut: false,
    startedAt: id,
    finishedAt: id,
    after,
  });
  const { store, client } = makeStore(undefined, {
    listExec: async () => [
      record(1, 'first', 'msg_1'),
      record(2, 'second', 'msg_1'),
      record(3, 'third', 'toolu_1'),
      record(4, 'lost', 'msg_gone'),
      record(5, 'old', null),
    ],
  });
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'one' },
    messageId: 'msg_1',
  });
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'two' },
    messageId: 'msg_2',
  });
  push(client, { sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Read', status: 'completed' });
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'three' },
    messageId: 'msg_3',
  });

  await store.loadExecHistory();

  // Two runs after the same message keep their order; one whose anchor the
  // replay did not bring back, and one from before anchors were recorded,
  // go at the end.
  assert.deepEqual(
    store.getSnapshot().messages.map((m) => m.id),
    [
      'msg_1',
      'bang-log-1-command',
      'bang-log-1',
      'bang-log-2-command',
      'bang-log-2',
      'msg_2',
      'bang-log-3-command',
      'bang-log-3',
      'msg_3',
      'bang-log-4-command',
      'bang-log-4',
      'bang-log-5-command',
      'bang-log-5',
    ],
  );
  assert.equal(outputOf(store.getSnapshot().messages[2]!), '```console\nfirst\n[exit 0]\n```');
});

test("a tool call's image is converted as a part beside the card, not inside it", () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't-shot',
    title: 'Read .playwright-cli/page.png',
    kind: 'read',
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
    ],
  } as SessionUpdate);

  const message = store.getSnapshot().messages.at(-1)!;
  const parts = partsOf(message);
  assert.deepEqual(
    parts.map((p) => p.type),
    ['tool-call', 'image'],
  );
  // The card still says a finished call produced something, so it does not
  // render as a tool that returned nothing.
  assert.equal(parts[0]!.result, '[image]');
  assert.equal(parts[1]!.image, 'data:image/png;base64,AAAA');
});

test("an update that replaces a call's content replaces its images with it", () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't-shot2',
    title: 'Screenshot',
    content: [
      { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
    ],
  } as SessionUpdate);
  push(client, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't-shot2',
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'image', data: 'BBBB', mimeType: 'image/png' } },
    ],
  } as SessionUpdate);

  const parts = partsOf(store.getSnapshot().messages.at(-1)!);
  assert.deepEqual(
    parts.map((p) => p.image).filter(Boolean),
    ['data:image/png;base64,BBBB'],
  );
});


/** One named message of a transcript, as the adapter replays it. */
function said(
  role: 'user' | 'agent',
  messageId: string,
  text: string,
): SessionUpdate {
  return {
    sessionUpdate: `${role}_message_chunk`,
    messageId,
    content: { type: 'text', text },
  } as SessionUpdate;
}

/** The whole conversation these resume tests replay. */
const TRANSCRIPT: SessionUpdate[] = [
  said('user', 'msg_1', 'the first question'),
  said('agent', 'msg_2', 'the first answer'),
  said('user', 'msg_3', 'and while you were away'),
  said('agent', 'msg_4', 'this came back'),
];

/** Every message as its id, role and text, which is what a reader sees. */
function shapeOf(store: ThreadStore): Array<[string, string, string]> {
  return store.getSnapshot().messages.map((m) => [
    m.id,
    m.role,
    partsOf(m)
      .map((p) => p.text ?? '')
      .join(''),
  ]);
}

test('a reconnect resumes from the last message the adapter named', () => {
  const { store, client } = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(client, u);

  client.resumes = true;
  client.load();
  // What the browser holds up to is what it names, so the gateway can send
  // the rest and nothing before it.
  assert.deepEqual(client.resumePoints, [null, 'msg_2']);

  // The tail as the gateway sends it: the message named, then what followed.
  for (const u of TRANSCRIPT.slice(1)) push(client, u);
  client.finish();

  assert.deepEqual(shapeOf(store), [
    ['msg_1', 'user', 'the first question'],
    ['msg_2', 'assistant', 'the first answer'],
    ['msg_3', 'user', 'and while you were away'],
    ['msg_4', 'assistant', 'this came back'],
  ]);
});

test('a resumed thread reads the same as one replayed whole', () => {
  const resumed = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(resumed.client, u);
  resumed.client.resumes = true;
  resumed.client.load();
  for (const u of TRANSCRIPT.slice(1)) push(resumed.client, u);
  resumed.client.finish();

  const whole = makeStore();
  for (const u of TRANSCRIPT) push(whole.client, u);

  // The model is the updates applied in order, and a resume is a cut across
  // that order rather than a different way of reading it.
  assert.deepEqual(shapeOf(resumed.store), shapeOf(whole.store));
});

test('a resume the gateway cannot honour rebuilds the thread from the top', () => {
  const { store, client } = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(client, u);

  // The gateway looked for the point and did not find it — the transcript was
  // compacted under this browser — so it sends the whole thread instead.
  client.resumes = false;
  client.load();
  for (const u of TRANSCRIPT) push(client, u);
  client.finish();

  assert.deepEqual(shapeOf(store), [
    ['msg_1', 'user', 'the first question'],
    ['msg_2', 'assistant', 'the first answer'],
    ['msg_3', 'user', 'and while you were away'],
    ['msg_4', 'assistant', 'this came back'],
  ]);
});

test('a reconnect mid-turn takes in what was said while the socket was down', () => {
  const { store, client } = makeStore();
  push(client, said('user', 'msg_1', 'the first question'));
  push(client, said('agent', 'msg_2', 'half an ans'));

  client.resumes = true;
  client.load();
  // The transcript holds the whole of the message the socket dropped in the
  // middle of, and the browser takes that message again rather than keeping
  // the half it has.
  push(client, said('agent', 'msg_2', 'half an answer, and the rest'));
  push(client, said('agent', 'msg_3', 'then this'));
  client.finish();

  assert.deepEqual(shapeOf(store), [
    ['msg_1', 'user', 'the first question'],
    ['msg_2', 'assistant', 'half an answer, and the rest'],
    ['msg_3', 'assistant', 'then this'],
  ]);
});

test('nothing is published while a resumed replay is being read', () => {
  const { store, client } = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(client, u);
  const before = store.getSnapshot().messages;

  client.resumes = true;
  client.load();
  // What is on screen stays on screen: the socket dropping is not news about
  // the conversation, and the tail is published in one go at the end.
  assert.equal(store.getSnapshot().messages, before);
  for (const u of TRANSCRIPT.slice(1)) push(client, u);
  assert.equal(store.getSnapshot().messages, before);

  client.finish();
  assert.equal(store.getSnapshot().messages.length, 4);
});

test('a resume names an adapter message rather than a local run', async () => {
  const { store, client } = makeStore(undefined, {
    runExec: async () => ({ exitCode: 0, truncated: false, timedOut: false }),
  });
  push(client, said('agent', 'msg_1', 'the first answer'));
  await store.runCommand('ls');
  assert.equal(store.getSnapshot().messages.length, 3);

  client.resumes = true;
  client.load();

  // A run's echo carries an id only this browser knows, so a replay would
  // never say it back. The runs go out of the thread with the resume and the
  // view asks for them again once the connection is ready.
  assert.deepEqual(client.resumePoints.at(-1), 'msg_1');
  push(client, said('agent', 'msg_1', 'the first answer'));
  client.finish();
  assert.deepEqual(shapeOf(store), [['msg_1', 'assistant', 'the first answer']]);
});

test('a resume gives up the questions the dead connection was showing', async () => {
  const { store, client } = makeStore();
  push(client, said('agent', 'msg_1', 'about to read a file'));
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_1',
    title: 'Read',
    status: 'pending',
  } as SessionUpdate);
  push(client, said('agent', 'msg_2', 'and then this'));
  const answer = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'toolu_1' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  assert.equal(store.getSnapshot().awaiting, 'permission');

  client.resumes = true;
  client.load();
  push(client, said('agent', 'msg_2', 'and then this'));
  client.finish();

  // Nobody is listening for the answer on the socket that has gone, and the
  // gateway puts a question that is still open back after the replay.
  assert.deepEqual(await answer, { outcome: { outcome: 'cancelled' } });
  assert.equal(store.getSnapshot().awaiting, null);
  const tool = partsOf(store.getSnapshot().messages[0]!).find((p) => p.type === 'tool');
  assert.equal(tool?.approval, undefined);
});

test('a resume puts the runs back without reading the exec log again', async () => {
  let listed = 0;
  const { store, client } = makeStore(undefined, {
    runExec: async (_id, _thread, _cmd, _after, onChunk) => {
      onChunk('two files\n');
      return { exitCode: 0, truncated: false, timedOut: false };
    },
    listExec: async () => {
      listed++;
      return [];
    },
  });
  push(client, said('agent', 'msg_1', 'the first answer'));
  await store.runCommand('ls');

  client.resumes = true;
  client.load();
  push(client, said('agent', 'msg_1', 'the first answer'));
  client.finish();
  // What the view does on every ready connection. The runs were taken out by
  // the resume, and this is where they go back.
  await store.loadExecHistory();

  // The store held them, so the server was never asked — which is the whole
  // point: every run's output would come back over the wire otherwise.
  assert.equal(listed, 0);
  assert.deepEqual(
    store.getSnapshot().messages.map((m) => m.id),
    ['msg_1', 'bang-1-command', 'bang-1'],
  );
  assert.match(outputOf(store.getSnapshot().messages[2]!), /two files\n\[exit 0\]/);
});

test('a thread replayed whole reads its runs back off the log', async () => {
  let listed = 0;
  const { store, client } = makeStore(undefined, {
    runExec: async (_id, _thread, _cmd, _after, onChunk) => {
      onChunk('two files\n');
      return { exitCode: 0, truncated: false, timedOut: false };
    },
    listExec: async () => {
      listed++;
      return [
        {
          id: 7,
          sessionId: 'box-1',
          command: 'ls',
          output: 'two files\n',
          exitCode: 0,
          truncated: false,
          timedOut: false,
          startedAt: 1,
          finishedAt: 2,
          after: 'msg_1',
        },
      ];
    },
  });
  push(client, said('agent', 'msg_1', 'the first answer'));
  await store.runCommand('ls');

  // No resume point to pick up from, so the thread comes whole — and the runs
  // come with it from the log, which is also how a run another tab made
  // arrives here.
  client.resumes = false;
  client.load();
  push(client, said('agent', 'msg_1', 'the first answer'));
  client.finish();
  await store.loadExecHistory();

  assert.equal(listed, 1);
  assert.deepEqual(
    store.getSnapshot().messages.map((m) => m.id),
    ['msg_1', 'bang-log-7-command', 'bang-log-7'],
  );
});
