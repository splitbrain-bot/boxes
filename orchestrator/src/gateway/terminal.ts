import type { WebSocket } from 'ws';
import { parseTerminalControl } from '../../../shared/terminal.ts';
import * as dk from '../docker.ts';
import { log } from '../log.ts';
import type { SessionManager } from '../sessions.ts';

/**
 * The terminal endpoint: one WebSocket, one pty in the session's container.
 *
 * Binary frames are the pty's bytes, in both directions, and nothing else.
 * Text frames are control from the browser — only a window size so far — so
 * the bytes never have to carry an envelope of their own.
 *
 * The connection belongs to the box rather than to a conversation. A thread
 * is where the agent is talked to; a terminal is the same box seen directly,
 * and every browser that opens one lands in the same shell.
 */

/**
 * How many bytes one browser's socket may have waiting on it.
 *
 * A pty produces far faster than a browser draws, and what the socket cannot
 * take is buffered in this process. Past this the pty is paused, which holds
 * up the program writing into it the way a real terminal does.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Columns the pty opens at, until the browser reports its own width. */
const DEFAULT_COLS = 80;

/** Rows the pty opens at, until the browser reports its own height. */
const DEFAULT_ROWS = 24;

/**
 * How often the server asks whether the browser is still there, in
 * milliseconds.
 *
 * An open terminal holds its box running, so a socket nobody is on the other
 * end of — a laptop that slept, a phone that locked — would pin a container
 * until TCP gave up on its own, which takes far longer.
 */
const PING_MS = 30_000;

/** How many pings the browser may leave unanswered before it is dropped. */
const MISSED_PINGS = 2;

/**
 * How long the browser may stay silent about its size before the pty opens
 * anyway, in milliseconds.
 *
 * The dashboard sends its size as its first frame. This is what gets a client
 * that sends none a shell regardless.
 */
const SIZE_WAIT_MS = 2_000;

/** Close codes this endpoint uses, past the ones the standard spends. */
const CLOSE = {
  /** The connection broke a rule of the endpoint rather than hit a fault. */
  policy: 1008,
  /** The box could not be reached, which is the endpoint's own failure. */
  unavailable: 1011,
} as const;

/**
 * Attaches one browser to a pty in the session's container.
 *
 * The box is started first, which runs the same repairs a start does and is
 * what opens a terminal on a session the reaper took. That takes seconds, so
 * frames arriving in the meantime are held and replayed into the pty once it
 * is there.
 *
 * One teardown serves whichever end goes first: the socket closing ends the
 * shell, and the shell ending closes the socket.
 */
export function attachTerminal(ws: WebSocket, sessionId: string, manager: SessionManager): void {
  const slog = log.session(sessionId);
  const release = manager.holdTerminal(sessionId);

  /** The pty, once it is open. Null while the box is still being started. */
  let terminal: dk.TerminalExec | null = null;
  /** Bytes the browser sent before the pty was there. */
  const queued: Buffer[] = [];
  /** The size the browser last reported, which the pty is opened at. */
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  /** True once the browser has said what size it is, or the wait has run out. */
  let sized = false;
  let closed = false;

  /** Ends the wait below, once the promise has handed over its resolve. */
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

  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    release();
    // Ending the shell reaches into the box, so it is not waited for: the
    // socket is closed now, and the client in there goes when it goes.
    void terminal?.close();
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };

  // --- the browser's side -----------------------------------------------

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Typing is what says somebody is using the box, and it is what holds
      // the reaper off once the terminal is closed again.
      manager.touchThrottled(sessionId);
      if (terminal) terminal.stream.write(data);
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
    void terminal?.resize(cols, rows);
  });

  ws.on('close', () => close(1000, 'closed'));
  ws.on('error', (err: Error) => {
    slog.debug('terminal socket error', { error: err.message });
    close(CLOSE.unavailable, 'socket error');
  });

  // The browser answers a ping below every application protocol, so nothing
  // the page is doing can stall the reply.
  let missed = 0;
  ws.on('pong', () => {
    missed = 0;
  });
  const pings = setInterval(() => {
    if (missed >= MISSED_PINGS) {
      slog.info('dropping a terminal whose browser stopped answering');
      // terminate() rather than close(): there is nobody to complete a
      // closing handshake with.
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

  void (async () => {
    let target;
    try {
      target = await manager.execTarget(sessionId);
    } catch (err) {
      slog.warn('could not reach the box for a terminal', { error: (err as Error).message });
      close(CLOSE.unavailable, (err as Error).message);
      return;
    }
    await knownSize;
    if (closed) return;

    try {
      terminal = await dk.openTerminalExec(target.containerId, target.workingDir, cols, rows);
    } catch (err) {
      slog.warn('could not open a terminal', { error: (err as Error).message });
      close(CLOSE.unavailable, (err as Error).message);
      return;
    }
    // The socket can go while the pty is opening, and the teardown above then
    // has nothing to end.
    if (closed) {
      void terminal.close();
      return;
    }

    for (const chunk of queued) terminal.stream.write(chunk);
    queued.length = 0;
    slog.info('terminal attached');

    terminal.stream.on('data', (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) return;
      // The pty stops being read, so the program writing into it blocks, and
      // both start again once the browser has caught up.
      terminal?.stream.pause();
      const resume = (): void => {
        if (closed) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          setTimeout(resume, 50).unref?.();
          return;
        }
        terminal?.stream.resume();
      };
      setTimeout(resume, 50).unref?.();
    });

    void terminal.exited.then(() => {
      slog.info('terminal shell ended');
      close(1000, 'shell ended');
    });
  })();
}
