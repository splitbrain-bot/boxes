import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Generation and storage of the secrets this deployment creates. */

/**
 * Writes a generated secret to `path`, readable by this process alone.
 *
 * The content goes to a new temporary file beside the target, which is then
 * renamed over it. So no reader sees a half-written file, and the result
 * always has mode 0600, even where an older file had a wider one. Missing
 * parent directories are created first.
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
 * Returns a new WebSocket auth token for one box, as the hex of
 * WS_TOKEN_BYTES random bytes.
 */
export function generateWsToken(): string {
  return randomBytes(WS_TOKEN_BYTES).toString('hex');
}
