import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.ts';

/**
 * Resolution of the gateway's WebSocket auth token (plan §2, §8.3).
 *
 * A shipped default for a secret is not a default, it is a published password,
 * so an unset WS_AUTH_TOKEN means "generate one for this deployment" rather
 * than "run without auth". The generated value lives in the data volume so it
 * survives restarts and container rebuilds, and that file is the only place it
 * is written: plan §6 keeps secrets out of SQLite and out of logs.
 *
 * Setting WS_AUTH_TOKEN explicitly still wins, which is also how the token is
 * rotated: set a new one, or delete the file and restart.
 */

/** Filename under DATA_DIR holding the generated token. */
const TOKEN_FILE = 'ws-auth-token';

/** Shortest token accepted, configured or generated. */
const MIN_LENGTH = 32;

export function resolveWsAuthToken(dataDir: string, configured: string): string {
  if (configured) {
    if (configured.length < MIN_LENGTH) {
      throw new Error(
        `WS_AUTH_TOKEN must be at least ${MIN_LENGTH} characters; ` +
          'leave it unset to have one generated instead',
      );
    }
    return configured;
  }

  const path = join(dataDir, TOKEN_FILE);
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored.length >= MIN_LENGTH) return stored;
    log.warn('stored WS auth token is too short; generating a replacement', { path });
  }

  const token = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  // writeFileSync only applies the mode when it creates the file, so an
  // existing short-token file would keep whatever mode it had.
  chmodSync(path, 0o600);
  log.info('generated a WebSocket auth token for this deployment', { path });
  return token;
}
