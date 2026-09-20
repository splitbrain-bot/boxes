import { TERMINAL_SUBPROTOCOL, type TerminalResize } from '../../../shared/terminal.ts';

/**
 * The browser's end of a session's terminal.
 *
 * Binary frames are the pty's bytes in both directions. Text frames are
 * control this end sends, which is a window size and nothing else so far.
 *
 * The bytes are handed on undecoded: a multi-byte character can arrive split
 * across two frames, and the terminal emulator is what reassembles it.
 */

/** Where a connection is in its life, as the view draws it. */
export type TerminalStatus = 'connecting' | 'ready' | 'closed';

/** What the view gives the socket to call back into. */
export interface TerminalSocketHandlers {
  /** The pty wrote something, still as bytes. */
  onData: (bytes: Uint8Array) => void;
  /** The connection changed state. `detail` says why a close happened. */
  onStatus: (status: TerminalStatus, detail?: string) => void;
}

/** One connection to one box's shell. */
export class TerminalSocket {
  private readonly ws: WebSocket;
  /** False once this end asked to close, which reports no reason to the view. */
  private wanted = true;

  /**
   * Opens the connection.
   *
   * The token travels as a subprotocol entry because a browser cannot set a
   * header on a WebSocket, and the server checks it on the upgrade itself.
   * The thread's connection makes the same handshake with the same token.
   */
  constructor(url: string, token: string, handlers: TerminalSocketHandlers) {
    this.ws = new WebSocket(url, [TERMINAL_SUBPROTOCOL, `bearer.${token}`]);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => handlers.onStatus('ready'));
    this.ws.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) handlers.onData(new Uint8Array(event.data));
    });
    this.ws.addEventListener('close', (event: CloseEvent) => {
      if (this.wanted) handlers.onStatus('closed', event.reason || undefined);
    });
    // A close follows every error, and that is where the reporting happens.
    this.ws.addEventListener('error', () => {});
    handlers.onStatus('connecting');
  }

  /** Sends what was typed, as the UTF-8 the pty expects. */
  send(data: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(new TextEncoder().encode(data));
  }

  /**
   * Tells the pty how large the window onto it is.
   *
   * Sent on connect before anything is typed, and again on every resize.
   */
  resize(cols: number, rows: number): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const message: TerminalResize = { type: 'resize', cols, rows };
    this.ws.send(JSON.stringify(message));
  }

  /** Closes the connection. The shell behind it stays, and can be reattached. */
  close(): void {
    this.wanted = false;
    this.ws.close();
  }
}
