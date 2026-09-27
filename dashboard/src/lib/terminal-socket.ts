import { TERMINAL_SUBPROTOCOL, type TerminalResize } from '../../../shared/terminal.ts';

/** Where a connection is in its life, as the view draws it. */
export type TerminalStatus = 'connecting' | 'ready' | 'closed';

/** What the view gives the socket to call back into. */
export interface TerminalSocketHandlers {
  /**
   * Receives the pty's output as raw bytes. A multi-byte character can be
   * split across two calls, and the terminal emulator joins it.
   */
  onData: (bytes: Uint8Array) => void;
  /** Receives each change of state. `detail` is the server's reason for a close. */
  onStatus: (status: TerminalStatus, detail?: string) => void;
}

/**
 * One connection to one box's shell.
 *
 * Binary frames carry the pty's bytes in both directions. Text frames carry
 * the window size this end sends.
 */
export class TerminalSocket {
  /** The WebSocket to the orchestrator. */
  private readonly ws: WebSocket;
  /** False once this end asked to close, so the close is not reported to the view. */
  private wanted = true;

  /**
   * Opens the connection.
   *
   * The token travels as a subprotocol entry, because a browser cannot set a
   * header on a WebSocket.
   *
   * @param url The terminal endpoint.
   * @param token The box's WebSocket token.
   * @param handlers The view's callbacks.
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

  /** Tells the pty the size of the window, in columns and rows. */
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
