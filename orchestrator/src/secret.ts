import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from './log.ts';

/**
 * Resolution of the gateway's WebSocket auth token, and the write every
 * generated secret in the data volume goes through.
 *
 * An unset WS_AUTH_TOKEN means the deployment generates its own. The
 * generated value lives in the data volume, so it survives restarts and
 * rebuilds, and that file is the only place the token is written.
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

/** Filename under DATA_DIR holding the generated token. */
const TOKEN_FILE = 'ws-auth-token';

/** Shortest token accepted, configured or generated. */
const MIN_LENGTH = 32;

/**
 * Returns the token for this deployment. A configured token wins and must be
 * at least MIN_LENGTH characters; otherwise the token stored under dataDir is
 * reused, or a fresh one is generated and stored there.
 */
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
  writeSecretFile(path, `${token}\n`);
  log.info('generated a WebSocket auth token for this deployment', { path });
  return token;
}
