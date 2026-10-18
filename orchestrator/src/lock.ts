/** The claim that keeps two orchestrators from sharing one DATA_DIR. */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Name of the lock file in DATA_DIR. The file records which process owns DATA_DIR. */
export const LOCK_FILE = 'orchestrator.lock';

/** Interval at which the holder stamps the lock file, in milliseconds. */
export const HEARTBEAT_MS = 5_000;

/**
 * How long a claim outlives its last heartbeat before another process may
 * take it, in milliseconds.
 *
 * It spans several beats, so an event loop busy with a boot does not look
 * like a dead process. It is short enough that an orchestrator that was
 * killed is replaced on one of the restarts its restart policy makes.
 */
export const LOCK_STALE_MS = 20_000;

/** The result of a claim: held is true when another process owns the directory. */
export type Claim =
  | {
      held: false;
      /** Stops the heartbeat and gives the directory up. */
      release: () => void;
      /**
       * The time of the last stamp of the replaced claim, or null when there was no
       * claim to replace.
       */
      tookOver: number | null;
    }
  | {
      held: true;
      /** Time since the holder last stamped the lock file, in milliseconds. */
      quietFor: number;
    };

/**
 * Claims dataDir for this process, through a lock file the holder stamps
 * every HEARTBEAT_MS.
 *
 * Two orchestrators on one directory share a database, a subnet pool and the
 * containers. The boot of the second one also clears the permission requests
 * the first one is waiting on.
 *
 * A claim not stamped for LOCK_STALE_MS is taken over. The process id in the
 * file cannot show a dead holder. In a container every orchestrator is PID 1,
 * so the id of a killed one is alive in its replacement.
 *
 * @param dataDir The data directory to claim.
 * @param now The clock. A test passes its own clock to move time.
 * @returns The claim, or the report that another process holds the directory.
 */
export function claimDataDir(dataDir: string, now: () => number = Date.now): Claim {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILE);
  const stamp = (flag: 'wx' | 'w'): void => {
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: now() }), { flag });
  };

  /**
   * Returns the time of the last stamp, or null when the file holds no time.
   * Such a file, for example one with a bare process id, counts as abandoned.
   *
   * @returns The time in epoch milliseconds, or null.
   */
  const stampedAt = (): number | null => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const at = (parsed as { at?: unknown } | null)?.at;
      return typeof at === 'number' ? at : null;
    } catch {
      return null;
    }
  };

  let tookOver: number | null = null;
  try {
    stamp('wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const at = stampedAt();
    if (at !== null && now() - at < LOCK_STALE_MS) return { held: true, quietFor: now() - at };
    tookOver = at;
    stamp('w');
  }

  const beat = setInterval(() => stamp('w'), HEARTBEAT_MS);
  beat.unref?.();
  return {
    held: false,
    tookOver,
    release: () => {
      clearInterval(beat);
      rmSync(path, { force: true });
    },
  };
}
