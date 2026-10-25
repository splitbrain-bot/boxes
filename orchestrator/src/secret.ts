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

/** Bytes of randomness behind the token of one box at the egress proxy. */
const PROXY_TOKEN_BYTES = 32;

/**
 * Returns a new token that identifies one box at the egress proxy, as the hex
 * of PROXY_TOKEN_BYTES random bytes. Hex needs no encoding in a URL.
 *
 * @returns The token as a hex string.
 */
export function generateProxyToken(): string {
  return randomBytes(PROXY_TOKEN_BYTES).toString('hex');
}
