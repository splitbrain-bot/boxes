import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The secrets this deployment generates, and the write every generated secret
 * in the data volume goes through.
 */

/**
 * Writes a generated secret to `path`, readable by this process alone.
 *
 * The content goes to a fresh temporary file beside it and is then renamed
 * over the target, so no reader ever sees a half-written file, and a file
 * replaced this way cannot keep a wider mode than 0600: the mode is applied
 * when the temporary file is created, which is always a create. Missing
 * parent directories are made first.
 */
export function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

/** Bytes of randomness behind one box's WebSocket token. */
const WS_TOKEN_BYTES = 32;

/**
 * Returns a fresh WebSocket auth token for one box to keep.
 *
 * Hex of WS_TOKEN_BYTES random bytes, from the same source as every other
 * secret this deployment generates.
 */
export function generateWsToken(): string {
  return randomBytes(WS_TOKEN_BYTES).toString('hex');
}
