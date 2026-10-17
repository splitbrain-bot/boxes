import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { WebSocket } from 'ws';
import { parseTerminalControl } from '../../../shared/terminal.ts';
import type { BoxManager } from '../boxes.ts';
import { log } from '../log.ts';
import { runtime } from '../runtime/runtime.ts';

/**
 * How many bytes one browser's socket may have waiting on it.
 *
 * Past this the pty is paused, which blocks the program writing into it.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Columns the pty opens at, until the browser reports its own width. */
const DEFAULT_COLS = 80;

/** Rows the pty opens at, until the browser reports its own height. */
const DEFAULT_ROWS = 24;

/**
 * How often the server pings the browser, in milliseconds.
 *
 * An open terminal keeps its box running, so a dead socket must be found
 * sooner than TCP would find it.
 */
const PING_MS = 30_000;

/** How many pings the browser may leave unanswered before it is dropped. */
const MISSED_PINGS = 2;

/**
 * How long to wait for the browser's size before the pty opens at the
 * default size, in milliseconds. The dashboard sends its size first.
 */
const SIZE_WAIT_MS = 2_000;

/**
 * How long to wait after the pty's exec ended before the terminal attaches
 * to its tmux session again, in milliseconds.
 */
const REATTACH_DELAY_MS = 1_000;

/** How long to wait before the second try of a reattach that failed, in milliseconds. */
const REATTACH_RETRY_MS = 5_000;

/** Where the pty of a terminal runs. */
type Target = Awaited<ReturnType<BoxManager['execTarget']>>;

/**
 * A pty inside a box, as the terminal endpoint holds one. It carries the raw
 * bytes in both directions.
 */
interface TerminalExec {
  /** The name of this connection's own tmux session. */
  client: string;
  /** The output of the pty. */
  output: Readable;
  /** The input of the pty, which the browser types into. */
  input: Writable;
  /** Tells the pty how large the window onto it is. */
  resize(cols: number, rows: number): Promise<void>;
  /** Resolves when the stream ends, with the exit code if known. */
  exited: Promise<number | null>;
  /** Ends this terminal's shell and drops the stream. */
  close(): Promise<void>;
}

/** The tmux session every terminal on a box shares, and which outlives them. */
const SHARED_TMUX_SESSION = 'boxes';

/**
 * The shell one terminal connection runs.
 *
 * `client` is this connection's own tmux session, grouped with the shared one
 * so both show the same windows. The shared session keeps the windows when
 * every client has gone, so a build carries on with nobody watching.
 *
 * The own session lets close() end the client by name, as the runtime cannot
 * signal a running exec. Without tmux, the shell is a plain login shell.
 */
function terminalShell(client: string): string {
  return [
    'if ! command -v tmux >/dev/null 2>&1; then exec bash -l; fi',
    `tmux new-session -d -s ${SHARED_TMUX_SESSION} 2>/dev/null`,
    `exec tmux new-session -s ${client} -t ${SHARED_TMUX_SESSION}`,
  ].join('; ');
}

/** The exit code of a reattach that found no client session to attach to. */
export const NO_TERMINAL_SESSION = 3;

/**
 * The shell that attaches one terminal connection to its own tmux session
 * again. The session is gone when the user ended the shell, or when the box
 * has no tmux.
 */
function reattachShell(client: string): string {
  return [
    `tmux has-session -t =${client} 2>/dev/null || exit ${NO_TERMINAL_SESSION}`,
    `exec tmux attach-session -t =${client}`,
  ].join('; ');
}

/**
 * Opens a pty in a box, running the shell a reader types into.
 *
 * The pty runs inside the box's isolation, so it reaches no further than the
 * agent does. The command is an argument vector, and the only part this
 * process composes is a name it generated itself.
 *
 * With `reattach`, the pty attaches to that client session of an earlier
 * exec. The exec then ends with {@link NO_TERMINAL_SESSION} when the session
 * is gone.
 */
async function openTerminal(
  target: Target,
  cols: number,
  rows: number,
  reattach?: string,
): Promise<TerminalExec> {
  // Random rather than a counter, so the name cannot collide with a session
  // that an earlier orchestrator process left behind.
  const client = reattach ?? `web-${randomBytes(4).toString('hex')}`;
  const pty = await runtime().spawn(
    target.boxId,
    ['bash', '-lc', reattach ? reattachShell(client) : terminalShell(client)],
    {
      workingDir: target.workingDir,
      // Without this an editor, a pager and everything else that draws degrade
      // to plain scrolling text.
      env: { TERM: 'xterm-256color' },
      tty: { cols, rows },
    },
  );
  return {
    client,
    output: pty.stdout,
    input: pty.stdin,
    resize: (nextCols, nextRows) => pty.resize(nextCols, nextRows),
    exited: pty.exited,
    close: async () => {
      // The stream is dropped either way: a box that stopped under the
      // terminal answers nothing, and has no client left to end.
      try {
        await runtime().run(target.boxId, ['tmux', 'kill-session', '-t', client]);
      } catch (err) {
        log.debug('could not end a terminal session', { error: (err as Error).message });
      }
      pty.kill();
    },
  };
}

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** WebSocket close codes this endpoint uses besides 1000. */
const CLOSE = {
  /** Policy violation, such as a browser that stopped answering pings. */
  policy: 1008,
  /** Internal error, such as a box or pty that could not be reached. */
  unavailable: 1011,
} as const;

/**
 * Attaches one browser to a pty in the box's container.
 *
 * Binary frames carry the pty's bytes in both directions. Text frames carry
 * control messages from the browser, such as the window size. Every browser
 * that opens a terminal on a box gets the same shell.
 *
 * The box is started first, which can take seconds, so input that arrives
 * meanwhile is queued. The socket closing ends the shell, and the shell
 * ending closes the socket.
 *
 * When the pty's exec ends while the socket stays open, the terminal
 * attaches to its tmux session again, and input is queued in the meantime.
 * A reattach never starts a stopped box.
 */
export function attachTerminal(ws: WebSocket, boxId: string, manager: BoxManager): void {
  const slog = log.box(boxId);
  const release = manager.holdTerminal(boxId);

  /** The last pty that was opened. Null while the box is still being started. */
  let terminal: TerminalExec | null = null;
  /** True while the exec of the pty runs. */
  let live = false;
  /** Bytes the browser sent before the pty was there. */
  const queued: Buffer[] = [];
  /** The width the browser last reported. */
  let cols = DEFAULT_COLS;
  /** The height the browser last reported. */
  let rows = DEFAULT_ROWS;
  /** True once the browser has reported its size. */
  let sized = false;
  /** True once the teardown has run. */
  let closed = false;

  /** Ends the size wait early. */
  let resolveSize: () => void = () => {};
  /** Resolves once the size is known, so the pty opens at the right width. */
  const knownSize = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SIZE_WAIT_MS);
    timer.unref?.();
    resolveSize = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  /** Tears down both ends once, whichever goes first. */
  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    release();
    // Not awaited, so the socket closes without waiting on the box.
    void terminal?.close();
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };

  // --- the browser's side -----------------------------------------------

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Typing marks the box as used, which holds off the reaper later.
      manager.touchThrottled(boxId);
      if (live) terminal?.input.write(data);
      else queued.push(Buffer.from(data));
      return;
    }
    const control = parseTerminalControl(data.toString('utf8'));
    if (!control) {
      slog.warn('dropping an unreadable terminal control frame');
      return;
    }
    cols = control.cols;
    rows = control.rows;
    if (!sized) {
      sized = true;
      resolveSize();
      return;
    }
    if (live) void terminal?.resize(cols, rows);
  });

  ws.on('close', () => close(1000, 'closed'));
  ws.on('error', (err: Error) => {
    slog.debug('terminal socket error', { error: err.message });
    close(CLOSE.unavailable, 'socket error');
  });

  // The browser answers pings itself, so a busy page cannot stall the reply.
  let missed = 0;
  ws.on('pong', () => {
    missed = 0;
  });
  const pings = setInterval(() => {
    if (missed >= MISSED_PINGS) {
      slog.info('dropping a terminal whose browser stopped answering');
      // Nobody is there to complete a closing handshake.
      ws.terminate();
      close(CLOSE.policy, 'gone');
      return;
    }
    missed++;
    ws.ping();
  }, PING_MS);
  pings.unref?.();
  ws.on('close', () => clearInterval(pings));

  // --- the box's side ---------------------------------------------------

  /** Connects an opened pty to the browser, and acts on the end of its exec. */
  const wire = (opened: TerminalExec, target: Target): void => {
    terminal = opened;
    live = true;
    for (const chunk of queued) opened.input.write(chunk);
    queued.length = 0;

    opened.output.on('data', (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) return;
      // Pauses the pty until the browser has caught up.
      opened.output.pause();
      const resume = (): void => {
        if (closed) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          setTimeout(resume, 50).unref?.();
          return;
        }
        opened.output.resume();
      };
      setTimeout(resume, 50).unref?.();
    });

    void opened.exited.then((code) => {
      live = false;
      if (closed) return;
      if (code === NO_TERMINAL_SESSION) {
        slog.info('terminal shell ended');
        close(1000, 'shell ended');
        return;
      }
      void reattach(opened.client, target);
    });
  };

  /**
   * Attaches to the tmux client session again after its exec ended. A spawn
   * that fails is tried once more.
   */
  const reattach = async (client: string, target: Target): Promise<void> => {
    for (const wait of [REATTACH_DELAY_MS, REATTACH_RETRY_MS]) {
      await delay(wait);
      if (closed) return;
      const state = await runtime().state(target.boxId);
      if (state === 'stopped') {
        slog.info('terminal ended with its box');
        close(1000, 'box stopped');
        return;
      }
      let opened: TerminalExec;
      try {
        opened = await openTerminal(target, cols, rows, client);
      } catch (err) {
        slog.warn('could not attach a terminal again', { error: (err as Error).message });
        if (wait === REATTACH_RETRY_MS) close(CLOSE.unavailable, (err as Error).message);
        continue;
      }
      // The socket closed while the pty was opening, before close() could end it.
      if (closed) {
        void opened.close();
        return;
      }
      slog.info('terminal attached again');
      wire(opened, target);
      return;
    }
  };

  void (async () => {
    let target: Target;
    try {
      target = await manager.execTarget(boxId);
    } catch (err) {
      slog.warn('could not reach the box for a terminal', { error: (err as Error).message });
      close(CLOSE.unavailable, (err as Error).message);
      return;
    }
    await knownSize;
    if (closed) return;

    let opened: TerminalExec;
    try {
      opened = await openTerminal(target, cols, rows);
    } catch (err) {
      slog.warn('could not open a terminal', { error: (err as Error).message });
      close(CLOSE.unavailable, (err as Error).message);
      return;
    }
    // The socket closed while the pty was opening, before close() could end it.
    if (closed) {
      void opened.close();
      return;
    }
    slog.info('terminal attached');
    wire(opened, target);
  })();
}
