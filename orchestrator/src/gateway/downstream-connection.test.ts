import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AnyNotification } from '@agentclientprotocol/sdk';
import { expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import { setLogLevel } from '../log.ts';
import type { SessionManager } from '../sessions.ts';
import { attachDownstream, wsStream } from './downstream.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * One browser connection end to end: what the gateway answers on a socket,
 * what it refuses to pass on, and how far behind it lets a browser fall.
 *
 * The upstream is a stand-in, so what is under test is the connection's own
 * rules rather than anything the session does with what it forwards.
 */

// These tests drive the paths the connection narrates, so only failures are
// written.
setLogLevel('error');

/** The thread this connection is pinned to. */
const T1 = 'acp-1';

/** Another thread of the same session, which this connection may not touch. */
const T2 = 'acp-2';

/** The ceiling the gateway puts on one socket's unsent bytes. */
const MAX_BUFFERED = 4 * 1024 * 1024;

/** A session/update, as the gateway writes one out to a browser. */
const UPDATE: AnyNotification = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: T1 },
};

/** How many bytes that update leaves in a socket that takes none of it. */
const UPDATE_BYTES = Buffer.byteLength(JSON.stringify(UPDATE));

/** A JSON-RPC message, in either direction. */
interface Rpc {
  jsonrpc?: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A browser socket that records what it was sent and how it was closed.
 *
 * Nothing drains it, so a send leaves its bytes buffered the way a socket
 * whose browser has stopped reading does.
 */
class FakeSocket extends EventEmitter {
  /** The readyState of a socket that can take frames. */
  readonly OPEN = 1;
  /** Which state the socket is in, settable to take it out of OPEN. */
  readyState = 1;
  /** Bytes written to the socket and not taken. */
  bufferedAmount = 0;
  /** Every frame written to the socket, as text. */
  readonly sent: string[] = [];
  /** The code and reason of each close asked for, in order. */
  readonly closes: Array<{ code: number; reason: string }> = [];

  /** Takes one text frame and leaves its bytes buffered. */
  send(data: string, cb?: () => void): void {
    this.sent.push(data);
    this.bufferedAmount += Buffer.byteLength(data);
    cb?.();
  }

  /** Records a close rather than performing one. */
  close(code?: number, reason?: string): void {
    this.closes.push({ code: code ?? 1000, reason: reason ?? '' });
  }

  /** Delivers one text frame to the gateway, the way a browser sends it. */
  receive(msg: Rpc): void {
    this.emit('message', Buffer.from(JSON.stringify(msg), 'utf8'), false);
  }

  /** Everything the gateway sent back, parsed. */
  get replies(): Rpc[] {
    return this.sent.map((text) => JSON.parse(text) as Rpc);
  }
}

/**
 * The session's upstream, answering everything and recording what the
 * connection asked of it.
 *
 * Its `pin` hands back the promise the test holds, which is the window every
 * forwarded request has to wait out.
 */
class FakeUpstream {
  /** The initialize answer handed to the browser. */
  readonly cachedInitialize: unknown = { protocolVersion: 1, agentCapabilities: {} };
  /** The handles attached, in order. */
  readonly attached: DownstreamHandle[] = [];
  /** The handles detached, in order. */
  readonly detached: DownstreamHandle[] = [];
  /** Every request forwarded, with the browser it came from. */
  readonly forwarded: Array<{ method: string; params: unknown; from?: DownstreamHandle }> = [];
  /** The methods of every notification forwarded, in order. */
  readonly notified: string[] = [];
  /** The handles the queued questions were flushed to, in order. */
  readonly flushed: DownstreamHandle[] = [];
  /** What the upstream was asked for, in order: a method name, or `flush`. */
  readonly calls: string[] = [];

  /** `pinned` settles on the thread this connection is pinned to. */
  constructor(private readonly pinned: Promise<string>) {}

  /** Counts a connection as attached. */
  attach(handle: DownstreamHandle): void {
    this.attached.push(handle);
  }

  /** Drops a connection that has gone. */
  detach(handle: DownstreamHandle): void {
    this.detached.push(handle);
  }

  /** Answers with the thread the test pinned the connection to. */
  pin(_handle: DownstreamHandle, _threadId: string | null): Promise<string> {
    return this.pinned;
  }

  /** The adapter is already up. */
  async ensureStarted(): Promise<void> {}

  /** Records a forwarded request and answers it with nothing. */
  async forwardRequest(
    method: string,
    params: unknown,
    from?: DownstreamHandle,
  ): Promise<unknown> {
    this.forwarded.push({ method, params, from });
    this.calls.push(method);
    return {};
  }

  /** Records a forwarded notification. */
  async forwardNotification(method: string, _params: unknown): Promise<void> {
    this.notified.push(method);
  }

  /** Records the browser the queued questions were sent to. */
  flushPendingTo(handle: DownstreamHandle): void {
    this.flushed.push(handle);
    this.calls.push('flush');
  }
}

/** A browser wired to a stand-in upstream, with the pin the test controls. */
function connect(pinned: Promise<string> = Promise.resolve(T1)): {
  ws: FakeSocket;
  up: FakeUpstream;
} {
  const ws = new FakeSocket();
  const up = new FakeUpstream(pinned);
  const manager = { upstream: () => up } as unknown as SessionManager;
  attachDownstream(ws as unknown as WebSocket, 's1', 't1', manager);
  return { ws, up };
}

/** The answer to one request, once the gateway has sent it. */
async function answer(ws: FakeSocket, id: number): Promise<Rpc> {
  await expect.poll(() => ws.replies.some((m) => m.id === id)).toBe(true);
  return ws.replies.find((m) => m.id === id) as Rpc;
}

/** Lets everything that does not need the pin run, so a test can look. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** One JSON-RPC message written to the socket, as a session's updates are. */
async function write(ws: FakeSocket, msg: AnyNotification): Promise<void> {
  const writer = wsStream(ws as unknown as WebSocket, 's1').writable.getWriter();
  await writer.write(msg);
}

test('a request naming another thread is refused rather than forwarded', async () => {
  const { ws, up } = connect();

  ws.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/prompt',
    params: { sessionId: T2, prompt: [{ type: 'text', text: 'not your thread' }] },
  });
  ws.receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/load',
    params: { sessionId: T2, cwd: '/workspace', mcpServers: [] },
  });

  // Passing either on would route that thread's replay to this browser alone,
  // and echo this browser's prompt where nobody is watching.
  for (const reply of [await answer(ws, 1), await answer(ws, 2)]) {
    assert.equal(reply.error?.code, -32602);
    assert.deepEqual(reply.error?.data, { sessionId: T2 });
    assert.match(reply.error?.message ?? '', /pinned to another thread/);
  }
  assert.deepEqual(up.forwarded, []);
  assert.deepEqual(up.flushed, []);
});

test('a request about the pinned thread, or about none, is forwarded with the handle', async () => {
  const { ws, up } = connect();

  ws.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/prompt',
    params: { sessionId: T1, prompt: [{ type: 'text', text: 'go' }] },
  });
  ws.receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/load',
    params: { sessionId: T1, cwd: '/workspace', mcpServers: [] },
  });
  // A request about the session rather than about one of its conversations.
  ws.receive({ jsonrpc: '2.0', id: 3, method: 'session/list', params: {} });

  for (const id of [1, 2, 3]) assert.deepEqual((await answer(ws, id)).result, {});
  assert.deepEqual(
    up.forwarded.map((call) => call.method),
    ['session/prompt', 'session/load', 'session/list'],
  );
  // The handle goes with each one: a replay belongs to the browser that asked
  // for it, and a prompt is echoed on that browser's behalf.
  for (const call of up.forwarded) assert.equal(call.from, up.attached[0]);
});

test('a request that arrives before the pin waits for it, and is still checked', async () => {
  let settlePin = (_thread: string): void => {};
  const pinned = new Promise<string>((resolve) => {
    settlePin = resolve;
  });
  const { ws, up } = connect(pinned);

  ws.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/prompt',
    params: { sessionId: T1, prompt: [{ type: 'text', text: 'before hello' }] },
  });
  ws.receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId: T2, prompt: [{ type: 'text', text: 'someone else thread' }] },
  });

  // A client that knows a thread id and prompts before saying hello. Answering
  // now would mean forwarding for a handle that has no thread yet.
  await settle();
  assert.deepEqual(
    up.forwarded.map((call) => call.method),
    [],
  );
  assert.deepEqual(ws.replies, []);

  settlePin(T1);

  assert.deepEqual((await answer(ws, 1)).result, {});
  assert.deepEqual((await answer(ws, 2)).error?.data, { sessionId: T2 });
  assert.deepEqual(
    up.forwarded.map((call) => call.method),
    ['session/prompt'],
  );
});

test('session/new answers with the pinned thread', async () => {
  const { ws } = connect();

  ws.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/workspace', mcpServers: [] },
  });

  // The browser is on one conversation of the session, so it is handed that
  // one rather than a second conversation on every reconnect.
  assert.deepEqual((await answer(ws, 1)).result, { sessionId: T1 });
});

test('a load flushes the questions waiting on its thread, once forwarded', async () => {
  const { ws, up } = connect();

  ws.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/load',
    params: { sessionId: T1, cwd: '/workspace', mcpServers: [] },
  });
  await answer(ws, 1);

  // A question delivered before the replay lands is thrown away with
  // everything else the browser had on screen, and it is sent only once.
  assert.deepEqual(up.calls, ['session/load', 'flush']);
  assert.equal(up.flushed[0], up.attached[0]);
});

test('a browser at or under the buffer ceiling is left alone', async () => {
  const keepingUp = new FakeSocket();
  await write(keepingUp, UPDATE);
  assert.deepEqual(keepingUp.sent, [JSON.stringify(UPDATE)]);
  assert.deepEqual(keepingUp.closes, []);

  // Exactly on the ceiling is still a browser the gateway holds bytes for.
  const atTheLimit = new FakeSocket();
  atTheLimit.bufferedAmount = MAX_BUFFERED - UPDATE_BYTES;
  await write(atTheLimit, UPDATE);
  assert.equal(atTheLimit.bufferedAmount, MAX_BUFFERED);
  assert.deepEqual(atTheLimit.closes, []);
});

test('a browser past the buffer ceiling is closed on the send that takes it there', async () => {
  const ws = new FakeSocket();
  ws.bufferedAmount = MAX_BUFFERED - UPDATE_BYTES + 1;

  await write(ws, UPDATE);

  // A phone asleep with the tab open would grow this buffer for as long as the
  // session keeps talking. Closing costs it nothing it cannot get back.
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(ws.closes, [{ code: 1008, reason: 'too far behind' }]);
});

test('a socket that is not open is sent nothing', async () => {
  const ws = new FakeSocket();
  ws.readyState = 3;

  await write(ws, UPDATE);

  // The read side notices a socket that has gone and closes the stream; a
  // write that lands in between is dropped rather than thrown.
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(ws.closes, []);
});
