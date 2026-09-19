/**
 * The words the terminal connection says: its subprotocol, and the control
 * messages the browser sends alongside the bytes.
 *
 * The orchestrator and the dashboard both speak this, so the spellings live
 * here and the module stays safe to pull into a browser bundle.
 */

/**
 * The WebSocket subprotocol the terminal endpoint negotiates.
 *
 * A browser offers this alongside a bearer.<token> entry, which is
 * credentials rather than a protocol, so this is the one the server selects.
 * The ACP gateway negotiates a different name, so neither endpoint answers a
 * client holding the other's handshake.
 */
export const TERMINAL_SUBPROTOCOL = 'boxes-terminal.v1';

/**
 * What the browser says about the size of its window onto the shell.
 *
 * The pty needs this to wrap lines and to place a full-screen program, and
 * only the browser knows it. Sent once on connect and again on every resize.
 */
export interface TerminalResize {
  type: 'resize';
  cols: number;
  rows: number;
}

/** Every control message the browser may send. */
export type TerminalControl = TerminalResize;

/**
 * The widest window the server accepts, in cells.
 *
 * A pty size is two 16-bit numbers, so a browser reporting nonsense would
 * reach the daemon with it. This is the ceiling on that mistake.
 */
export const MAX_TERMINAL_COLS = 500;

/** The tallest window the server accepts, in cells. */
export const MAX_TERMINAL_ROWS = 300;

/**
 * One control message, or null when the frame is not one.
 *
 * A frame that does not parse is dropped and the connection stays open. The
 * bytes flowing the other way are what the reader came for, and a malformed
 * resize is not worth ending a shell over.
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
  if (message['type'] !== 'resize') return null;
  const cols = message['cols'];
  const rows = message['rows'];
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 1), max);
  return {
    type: 'resize',
    cols: clamp(cols as number, MAX_TERMINAL_COLS),
    rows: clamp(rows as number, MAX_TERMINAL_ROWS),
  };
}
