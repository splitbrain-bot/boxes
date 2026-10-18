/** Secrets that the orchestrator generates. */

import { randomBytes } from 'node:crypto';

/** Bytes of randomness behind one box's WebSocket token. */
const WS_TOKEN_BYTES = 32;

/**
 * Returns a new WebSocket auth token for one box, as the hex of
 * WS_TOKEN_BYTES random bytes.
 *
 * @returns The token as a hex string.
 */
export function generateWsToken(): string {
  return randomBytes(WS_TOKEN_BYTES).toString('hex');
}
