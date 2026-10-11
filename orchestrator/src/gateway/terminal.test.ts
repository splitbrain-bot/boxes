import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { parseTerminalControl } from '../../../shared/terminal.ts';
import * as dk from '../docker.ts';
import { setLogLevel } from '../log.ts';
import type { BoxManager } from '../boxes.ts';
import { attachTerminal } from './terminal.ts';

// The connection logs every path these tests drive, so only errors are
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
  /** The state the socket is in. A close moves it to closed. */
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

  /** Takes one binary frame and leaves its bytes buffered. */
  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
    this.bufferedAmount += data.length;
  }

  /** Records a close and marks the socket as closed. */
  close(code?: number, reason?: string): void {
    this.closes.push({ code: code ?? 1000, reason: reason ?? '' });
    this.readyState = 3;
  }

  /** Counts a ping. */
  ping(): void {
    this.pings++;
  }

  /** Records that the connection was dropped. */
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
  /** Bytes written into the last pty by the endpoint. */
  readonly typed: () => string;
  /** The size each pty was opened at, and every resize since. */
  readonly sizes: Array<{ cols: number; rows: number }>;
  /** Writes from the shell of the last pty, which the endpoint should pass to the browser. */
  say: (text: string) => void;
  /** Ends the exec of the last pty with an exit code, 0 if not given. */
  end: (exitCode?: number) => void;
  /** True once the endpoint killed the last pty. */
  killed: () => boolean;
  /** True while the endpoint has stopped reading the last pty. */
  paused: () => boolean;
  /** The argv of every short exec the box was asked to run, in order. */
  readonly ran: string[][];
  /** The shell of every pty that was opened, in order. */
  readonly shells: string[];
  /** The tmux session the terminal's own shell was started under. */
  client: () => string;
  /** Sets whether the container runs. */
  setRunning: (running: boolean) => void;
  /** Makes the next opens of a pty fail. */
  failOpens: (count: number) => void;
}

/** One pty of the fake Docker client. */
interface Pty {
  /** The stream the endpoint reads and writes. */
  stream: PassThrough;
  /** Bytes written into the pty by the endpoint. */
  written: Buffer[];
  /** The exit code the exec reports when it ended. */
  exitCode: number;
  /** True once the endpoint killed the pty. */
  killed: boolean;
}

/** Installs a Docker client whose execs are ptys a test can drive. */
function fakeDocker(): FakePty {
  const ptys: Pty[] = [];
  const sizes: Array<{ cols: number; rows: number }> = [];
  const ran: string[][] = [];
  const shells: string[] = [];
  let client = '';
  let running = true;
  let failures = 0;

  /** The last pty that was opened. */
  const last = (): Pty => {
    const pty = ptys.at(-1);
    assert.ok(pty, 'no pty was opened');
    return pty;
  };

  /** Opens a new pty, which records the endpoint's writes. */
  const open = (): Pty => {
    const stream = new PassThrough();
    const pty: Pty = { stream, written: [], exitCode: 0, killed: false };
    // Records the endpoint's writes, so they do not come back out as shell output.
    Object.assign(stream, {
      write: (chunk: Buffer | string): boolean => {
        pty.written.push(Buffer.from(chunk as Buffer));
        return true;
      },
    });
    stream.on('close', () => {
      pty.killed = true;
    });
    ptys.push(pty);
    return pty;
  };

  dk.setDockerForTests({
    // Drains a short exec's stream, so the exec reports that it finished.
    modem: { demuxStream: (from: PassThrough) => from.resume() },
    getContainer: () => ({
      inspect: async () => ({ State: { Running: running } }),
      exec: async (opts: { Cmd: string[]; Tty?: boolean; ConsoleSize?: [number, number] }) => {
        if (!opts.Tty) {
          // A short exec, such as the one that ends this terminal's tmux session.
          ran.push(opts.Cmd);
          const done = new PassThrough();
          queueMicrotask(() => done.end());
          return { start: async () => done, inspect: async () => ({ ExitCode: 0 }) };
        }
        if (failures > 0) {
          failures--;
          throw new Error('exec failed');
        }
        const [rows, cols] = opts.ConsoleSize ?? [0, 0];
        sizes.push({ cols, rows });
        const shell = opts.Cmd.at(-1) ?? '';
        shells.push(shell);
        client ||= /-s (web-[0-9a-f]+) /.exec(shell)?.[1] ?? '';
        const pty = open();
        return {
          start: async () => pty.stream,
          inspect: async () => ({ ExitCode: pty.exitCode }),
          resize: async (size: { h: number; w: number }) => {
            sizes.push({ cols: size.w, rows: size.h });
          },
        };
      },
    }),
  } as unknown as Parameters<typeof dk.setDockerForTests>[0]);

  return {
    typed: () => Buffer.concat(last().written).toString('utf8'),
    sizes,
    say: (text) => last().stream.push(Buffer.from(text, 'utf8')),
    end: (exitCode = 0) => {
      const pty = last();
      pty.exitCode = exitCode;
      pty.stream.push(null);
    },
    killed: () => last().killed,
    paused: () => last().stream.isPaused(),
    ran,
    shells,
    client: () => client,
    setRunning: (next) => {
      running = next;
    },
    failOpens: (count) => {
      failures = count;
    },
  };
}

/** What a test's fake manager recorded about the box being held. */
interface FakeManager {
  /** The stand-in manager to attach terminals with. */
  manager: BoxManager;
  /** How many terminals the manager currently counts on the box. */
  held: () => number;
  /** How many times the box was marked active by typing. */
  touches: () => number;
  /** How many times the box was asked for, which starts a stopped box. */
  targets: () => number;
}

/** A manager that answers with a container and counts the holds on it. */
function fakeManager(opts: { fail?: string } = {}): FakeManager {
  let open = 0;
  let touches = 0;
  let targets = 0;
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
      targets++;
      if (opts.fail) throw new Error(opts.fail);
      return { containerId: 'c1', workingDir: '/workspace' };
    },
  } as unknown as BoxManager;
  return { manager, held: () => open, touches: () => touches, targets: () => targets };
}

/** Opens a terminal and waits for the pty behind it to be there. */
async function attach(
  ws: FakeSocket,
  manager: BoxManager,
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
  assert.equal(touches(), 1);
  dk.setDockerForTests(null);
});

test('bytes typed before the shell is there are kept, not dropped', async () => {
  // Starting a reaped box takes seconds.
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
  // Fast output is ordinary, for example from a test run. The pty stops being
  // read, and the connection stays.
  const pty = fakeDocker();
  const { manager } = fakeManager();
  const ws = new FakeSocket();

  await attach(ws, manager);
  pty.say('x'.repeat(MAX_BUFFERED + 1));
  await vi.waitFor(() => assert.equal(pty.paused(), true));

  assert.deepEqual(ws.closes, []);
  dk.setDockerForTests(null);
});

test('an ended exec attaches to the same tmux session again and keeps the socket', async () => {
  // A stream through the Kubernetes API server can end at any time. tmux
  // keeps the screen, so the browser sees no break.
  vi.useFakeTimers();
  try {
    const pty = fakeDocker();
    const { manager, targets } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);
    const client = pty.client();

    pty.end();
    await vi.advanceTimersByTimeAsync(0);
    ws.type('typed meanwhile\r');
    ws.control({ type: 'resize', cols: 100, rows: 30 });
    await vi.advanceTimersByTimeAsync(1_000);

    assert.equal(pty.shells.length, 2);
    assert.match(pty.shells[1] ?? '', new RegExp(`attach-session -t =${client}$`));
    assert.deepEqual(pty.sizes.at(-1), { cols: 100, rows: 30 });
    assert.equal(pty.typed(), 'typed meanwhile\r');
    pty.say('same screen');
    await vi.advanceTimersByTimeAsync(0);
    assert.match(ws.received, /same screen/);
    assert.deepEqual(ws.closes, []);
    assert.equal(targets(), 1);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});

test('a reattach that finds no tmux session closes the socket as the shell ended', async () => {
  vi.useFakeTimers();
  try {
    const pty = fakeDocker();
    const { manager, held } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);

    pty.end();
    await vi.advanceTimersByTimeAsync(1_000);
    pty.end(dk.NO_TERMINAL_SESSION);
    await vi.advanceTimersByTimeAsync(0);

    assert.deepEqual(ws.closes, [{ code: 1000, reason: 'shell ended' }]);
    assert.equal(held(), 0);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});

test('a reattach never starts a stopped box, and closes the socket as box stopped', async () => {
  vi.useFakeTimers();
  try {
    const pty = fakeDocker();
    const { manager, held, targets } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);

    pty.setRunning(false);
    pty.end();
    await vi.advanceTimersByTimeAsync(1_000);

    assert.deepEqual(ws.closes, [{ code: 1000, reason: 'box stopped' }]);
    assert.equal(pty.shells.length, 1);
    assert.equal(targets(), 1);
    assert.equal(held(), 0);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});

test('a reattach that fails is tried once more after five seconds', async () => {
  vi.useFakeTimers();
  try {
    const pty = fakeDocker();
    const { manager } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);

    pty.failOpens(1);
    pty.end();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(pty.shells.length, 1);
    await vi.advanceTimersByTimeAsync(5_000);

    assert.equal(pty.shells.length, 2);
    assert.deepEqual(ws.closes, []);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});

test('a reattach that fails twice closes the socket with the error', async () => {
  vi.useFakeTimers();
  try {
    const pty = fakeDocker();
    const { manager, held } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);

    pty.failOpens(2);
    pty.end();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(ws.closes, []);
    await vi.advanceTimersByTimeAsync(5_000);

    assert.deepEqual(ws.closes, [{ code: 1011, reason: 'exec failed' }]);
    assert.equal(held(), 0);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});

test('the browser closing while the terminal waits to reattach ends its tmux session', async () => {
  vi.useFakeTimers();
  try {
    const pty = fakeDocker();
    const { manager, held } = fakeManager();
    const ws = new FakeSocket();
    attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
    ws.control({ type: 'resize', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);
    const client = pty.client();

    pty.end();
    await vi.advanceTimersByTimeAsync(0);
    ws.emit('close');
    await vi.advanceTimersByTimeAsync(1_000);

    assert.deepEqual(pty.ran.at(-1), ['tmux', 'kill-session', '-t', client]);
    assert.equal(pty.shells.length, 1);
    assert.equal(held(), 0);
  } finally {
    vi.useRealTimers();
    dk.setDockerForTests(null);
  }
});

test('the browser closing ends this terminal shell and lets the box go', async () => {
  // Docker cannot signal a running exec, so the endpoint ends the tmux session
  // this terminal started under. Other terminals on the box keep theirs.
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

test('two terminals on one box get tmux client sessions of their own', async () => {
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
  const { manager, held } = fakeManager({ fail: 'Box has no container' });
  const ws = new FakeSocket();

  attachTerminal(ws as unknown as WebSocket, 'box-1', manager);
  await vi.waitFor(() => assert.equal(ws.closes.length, 1));

  assert.equal(ws.closes[0]?.reason, 'Box has no container');
  // The hold is taken before the box starts, so this path must release it.
  assert.equal(held(), 0);
});

test('a browser that stops answering pings is dropped and the box let go', async () => {
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
