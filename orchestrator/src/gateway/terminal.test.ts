import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { parseTerminalControl } from '../../../shared/terminal.ts';
import * as dk from '../docker.ts';
import { setLogLevel } from '../log.ts';
import type { SessionManager } from '../sessions.ts';
import { attachTerminal } from './terminal.ts';

/**
 * One terminal connection end to end: what reaches the pty, what reaches the
 * browser, what happens when either end goes, and how long the box is held.
 *
 * Docker is a stand-in, so what is under test is the connection's own rules
 * rather than anything a real shell does with the bytes.
 */

// These tests drive the paths the connection narrates, so only failures are
// written.
setLogLevel('error');

/** The ceiling the endpoint puts on one socket's unsent bytes. */
const MAX_BUFFERED = 1024 * 1024;

/**
 * A browser socket that records what it was sent and how it was closed.
 *
 * Nothing drains it, so a send leaves its bytes buffered the way a socket
 * whose browser has stopped reading does.
 */
class FakeSocket extends EventEmitter {
  /** The readyState of a socket that can take frames. */
  readonly OPEN = 1;
  readyState = 1;
  /** Bytes written to the socket and not taken. */
  bufferedAmount = 0;
  /** Every binary frame written to the socket. */
  readonly sent: Buffer[] = [];
  /** The code and reason of each close asked for, in order. */
  readonly closes: Array<{ code: number; reason: string }> = [];
  /** How many times the socket was pinged. */
  pings = 0;
  /** True once the connection was dropped without a closing handshake. */
  terminated = false;

  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
    this.bufferedAmount += data.length;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code: code ?? 1000, reason: reason ?? '' });
    this.readyState = 3;
  }

  ping(): void {
    this.pings++;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers typed bytes, the way a browser sends them. */
  type(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'), true);
  }

  /** Delivers one control frame. */
  control(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message), 'utf8'), false);
  }

  /** Everything the endpoint sent back, as one string. */
  get received(): string {
    return Buffer.concat(this.sent).toString('utf8');
  }
}

/** What a test's fake pty recorded, and the handles to drive it by. */
interface FakePty {
  /** Bytes written into the pty by the endpoint. */
  readonly typed: () => string;
  /** The size the pty was opened at, and every resize since. */
  readonly sizes: Array<{ cols: number; rows: number }>;
  /** Writes from the shell, which the endpoint should pass to the browser. */
  say: (text: string) => void;
  /** Ends the shell, as exiting it does. */
  end: () => void;
  /** True once the endpoint killed the pty. */
  killed: () => boolean;
  /** True while the endpoint has stopped reading the pty. */
  paused: () => boolean;
  /** The argv of every short exec the box was asked to run, in order. */
  readonly ran: string[][];
  /** The tmux session the terminal's own shell was started under. */
  client: () => string;
}

/** Installs a Docker client whose exec is a pty a test can drive. */
function fakeDocker(): FakePty {
  const stream = new PassThrough();
  const written: Buffer[] = [];
  const sizes: Array<{ cols: number; rows: number }> = [];
  const ran: string[][] = [];
  let killed = false;
  let client = '';

  // What the endpoint writes into the pty, which a PassThrough would otherwise
  // echo straight back out as if the shell had said it.
  const pty = Object.assign(stream, {
    write: (chunk: Buffer | string): boolean => {
      written.push(Buffer.from(chunk as Buffer));
      return true;
    },
  });

  dk.setDockerForTests({
    // The real modem reads the exec's stream; without something draining it,
    // a short exec here would never report that it had finished.
    modem: { demuxStream: (from: PassThrough) => from.resume() },
    getContainer: () => ({
      exec: async (opts: { Cmd: string[]; Tty?: boolean; ConsoleSize?: [number, number] }) => {
        if (!opts.Tty) {
          // Every short exec the endpoint runs against the box, which is how
          // it ends the client it started.
          ran.push(opts.Cmd);
          const done = new PassThrough();
          queueMicrotask(() => done.end());
          return { start: async () => done, inspect: async () => ({ ExitCode: 0 }) };
        }
        const [rows, cols] = opts.ConsoleSize ?? [0, 0];
        sizes.push({ cols, rows });
        client = /-s (web-[0-9a-f]+) /.exec(opts.Cmd.at(-1) ?? '')?.[1] ?? '';
        return {
          start: async () => pty,
          inspect: async () => ({ ExitCode: 0 }),
          resize: async (size: { h: number; w: number }) => {
            sizes.push({ cols: size.w, rows: size.h });
          },
        };
      },
    }),
  } as unknown as Parameters<typeof dk.setDockerForTests>[0]);

  stream.on('close', () => {
    killed = true;
  });

  return {
    typed: () => Buffer.concat(written).toString('utf8'),
    sizes,
    say: (text) => stream.push(Buffer.from(text, 'utf8')),
    end: () => stream.push(null),
    killed: () => killed,
    paused: () => stream.isPaused(),
    ran,
    client: () => client,
  };
}

/** What a test's fake manager recorded about the box being held. */
interface FakeManager {
  manager: SessionManager;
  /** How many terminals the manager currently counts on the session. */
  held: () => number;
  /** How many times the session was marked active by typing. */
  touches: () => number;
}

/** A manager that answers with a container and counts the holds on it. */
function fakeManager(opts: { fail?: string } = {}): FakeManager {
  let open = 0;
  let touches = 0;
  const manager = {
    holdTerminal: () => {
      open++;
      return () => {
        open--;
      };
    },
    touchThrottled: () => {
      touches++;
    },
    execTarget: async () => {
      if (opts.fail) throw new Error(opts.fail);
      return { containerId: 'c1', workingDir: '/workspace' };
    },
  } as unknown as SessionManager;
  return { manager, held: () => open, touches: () => touches };
}

/** Opens a terminal and waits for the pty behind it to be there. */
async function attach(
  ws: FakeSocket,
  manager: SessionManager,
  size: { cols: number; rows: number } | null = { cols: 100, rows: 40 },
): Promise<void> {
  attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
  if (size) ws.control({ type: 'resize', ...size });
  // The pty opens across two awaits: the box being reached, and the size
  // being known.
  await vi.waitFor(() => assert.ok(true));
  await new Promise((resolve) => setImmediate(resolve));
}

test('a control frame is read as a size, and anything else is not', () => {
  assert.deepEqual(parseTerminalControl('{"type":"resize","cols":80,"rows":24}'), {
    type: 'resize',
    cols: 80,
    rows: 24,
  });
  assert.equal(parseTerminalControl('not json'), null);
  assert.equal(parseTerminalControl('{"type":"something"}'), null);
  assert.equal(parseTerminalControl('{"type":"resize","cols":"80","rows":24}'), null);
});

test('a size past what a pty can hold is brought back to the ceiling', () => {
  // The daemon takes two 16-bit numbers, so a browser reporting nonsense
  // would be passed straight through to it.
  assert.deepEqual(parseTerminalControl('{"type":"resize","cols":99999,"rows":0}'), {
    type: 'resize',
    cols: 500,
    rows: 1,
  });
});

test('the pty opens at the size the browser reported', async () => {
  const pty = fakeDocker();
  const { manager } = fakeManager();
  const ws = new FakeSocket();

  await attach(ws, manager, { cols: 120, rows: 50 });

  assert.deepEqual(pty.sizes[0], { cols: 120, rows: 50 });
  dk.setDockerForTests(null);
});

test('typing reaches the pty and its output reaches the browser', async () => {
  const pty = fakeDocker();
  const { manager, touches } = fakeManager();
  const ws = new FakeSocket();

  await attach(ws, manager);
  ws.type('ls\r');
  pty.say('a.txt  b.txt\r\n');
  await vi.waitFor(() => assert.match(ws.received, /a\.txt/));

  assert.equal(pty.typed(), 'ls\r');
  // Typing is what says the box is in use, and what holds the reaper off once
  // the terminal is closed again.
  assert.equal(touches(), 1);
  dk.setDockerForTests(null);
});

test('bytes typed before the shell is there are kept, not dropped', async () => {
  // Starting a reaped box takes seconds, and a reader who types into the
  // window before the prompt appears means it.
  const pty = fakeDocker();
  const { manager } = fakeManager();
  const ws = new FakeSocket();

  attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
  ws.type('echo early\r');
  ws.control({ type: 'resize', cols: 80, rows: 24 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  await vi.waitFor(() => assert.equal(pty.typed(), 'echo early\r'));
  dk.setDockerForTests(null);
});

test('a resize after the shell is open is passed to the pty', async () => {
  const pty = fakeDocker();
  const { manager } = fakeManager();
  const ws = new FakeSocket();

  await attach(ws, manager, { cols: 80, rows: 24 });
  ws.control({ type: 'resize', cols: 132, rows: 43 });

  await vi.waitFor(() => assert.deepEqual(pty.sizes.at(-1), { cols: 132, rows: 43 }));
  dk.setDockerForTests(null);
});

test('a browser that cannot keep up holds the pty up rather than being dropped', async () => {
  // A terminal that produces faster than it is drawn is ordinary — a test
  // run, a `find /`. The pty stops being read, which is the back pressure a
  // real terminal applies, and the connection stays.
  const pty = fakeDocker();
  const { manager } = fakeManager();
  const ws = new FakeSocket();

  await attach(ws, manager);
  pty.say('x'.repeat(MAX_BUFFERED + 1));
  await vi.waitFor(() => assert.equal(pty.paused(), true));

  assert.deepEqual(ws.closes, []);
  dk.setDockerForTests(null);
});

test('the shell ending closes the browser socket', async () => {
  const pty = fakeDocker();
  const { manager, held } = fakeManager();
  const ws = new FakeSocket();

  await attach(ws, manager);
  pty.end();

  await vi.waitFor(() => assert.equal(ws.closes.length, 1));
  // And the box is let go of, so the reaper can have it back.
  assert.equal(held(), 0);
  dk.setDockerForTests(null);
});

test('the browser closing ends this terminal shell and lets the box go', async () => {
  // Docker offers no way to signal a running exec, so dropping the stream on
  // its own would leave a tmux client attached to the box for good — one more
  // with every tab anybody ever closed. The session it was started under is
  // what gets ended, so no other terminal on the box is touched.
  const pty = fakeDocker();
  const { manager, held } = fakeManager();
  const ws = new FakeSocket();

  await attach(ws, manager);
  assert.equal(held(), 1);
  const client = pty.client();
  assert.match(client, /^web-[0-9a-f]+$/);
  ws.emit('close');

  await vi.waitFor(() => assert.deepEqual(pty.ran.at(-1), ['tmux', 'kill-session', '-t', client]));
  await vi.waitFor(() => assert.equal(pty.killed(), true));
  assert.equal(held(), 0);
  dk.setDockerForTests(null);
});

test('two terminals on one box get shells of their own to end', async () => {
  const first = fakeDocker();
  const ws1 = new FakeSocket();
  await attach(ws1, fakeManager().manager);
  const one = first.client();

  const second = fakeDocker();
  const ws2 = new FakeSocket();
  await attach(ws2, fakeManager().manager);
  const two = second.client();

  assert.notEqual(one, two);
  dk.setDockerForTests(null);
});

test('a box that cannot be reached closes the socket and says why', async () => {
  const { manager, held } = fakeManager({ fail: 'Session has no container' });
  const ws = new FakeSocket();

  attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
  await vi.waitFor(() => assert.equal(ws.closes.length, 1));

  assert.equal(ws.closes[0]?.reason, 'Session has no container');
  // The hold went up before the box was started, so it has to come down on
  // the way that never reaches a shell.
  assert.equal(held(), 0);
});

test('a browser that stops answering pings is dropped and the box let go', async () => {
  // A phone that locked or a laptop that slept leaves a socket TCP will hold
  // open for far longer than anyone expects, and with it the container.
  vi.useFakeTimers();
  try {
    const pty = fakeDocker();
    const { manager, held } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);

    // Two pings go unanswered, and the third check gives up.
    await vi.advanceTimersByTimeAsync(30_000 * 3);

    assert.equal(ws.terminated, true);
    assert.equal(held(), 0);
    assert.equal(pty.killed(), true);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});

test('a browser that answers its pings is left alone', async () => {
  vi.useFakeTimers();
  try {
    fakeDocker();
    const { manager, held } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      ws.emit('pong');
    }

    assert.equal(ws.terminated, false);
    assert.equal(held(), 1);
    expect(ws.pings).toBeGreaterThan(0);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});
