/**
 * Subprotocol and control messages of the terminal WebSocket, shared by the
 * orchestrator and the dashboard.
 */

/**
 * The WebSocket subprotocol that the terminal endpoint selects.
 *
 * A browser also offers a `bearer.<token>` entry, which holds the credential and is not a protocol.
 * The ACP gateway uses a different name, so a client cannot open one endpoint with the handshake of the other.
 */
export const TERMINAL_SUBPROTOCOL = 'boxes-terminal.v1';

/**
 * The size of the terminal in the browser.
 *
 * The pty needs the size to wrap lines and to place a full-screen program.
 * The browser sends it once when it connects and again at each resize.
 */
export interface TerminalResize {
  /** Message type. */
  type: 'resize';
  /** Width in cells. */
  cols: number;
  /** Height in cells. */
  rows: number;
}

/** A control message that the browser can send. */
export type TerminalControl = TerminalResize;

/**
 * The maximum terminal width in cells. {@link parseTerminalControl} clamps a larger width.
 *
 * A pty size is two 16-bit numbers. The limit stops a browser from sending an invalid size to the runtime.
 */
export const MAX_TERMINAL_COLS = 500;

/** The maximum terminal height in cells. {@link parseTerminalControl} clamps a larger height. */
export const MAX_TERMINAL_ROWS = 300;

/**
 * Parses one control message. The function clamps each size to between 1 and
 * {@link MAX_TERMINAL_COLS} or {@link MAX_TERMINAL_ROWS}.
 *
 * @param text The text of one WebSocket frame.
 * @returns The control message, or null when the frame is not a control message.
 */
export function parseTerminalControl(text: string): TerminalControl | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.type !== 'resize') return null;
  const cols = message.cols;
  const rows = message.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 1), max);
  return {
    type: 'resize',
    cols: clamp(cols as number, MAX_TERMINAL_COLS),
    rows: clamp(rows as number, MAX_TERMINAL_ROWS),
  };
}
