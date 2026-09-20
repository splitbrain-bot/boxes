import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which process owns DATA_DIR, so that two orchestrators cannot share one.
 *
 * Two of them on one directory share a database, a subnet pool and a set of
 * containers, and the second one's boot clears the first one's queue of
 * permission requests — questions a person is looking at, gone, with the
 * turns behind them left waiting.
 *
 * The claim is a file, because Node has no advisory lock without a
 * dependency, and a file outlives the process that wrote it. What tells a
 * held claim from an abandoned one is a heartbeat rather than the id in it:
 * the holder stamps the file while it runs, and one nothing has touched for
 * {@link LOCK_STALE_MS} belongs to a process that is gone.
 *
 * A process id cannot answer this. Every orchestrator in a container is PID
 * 1, so a claim left behind by a container that was killed names a number
 * that is alive in the very next one — its own — and asking the kernel about
 * it answers yes for as long as the deployment lasts: the replacement refuses
 * to boot, its restart policy starts it again, and it refuses again. Reading
 * the holder's `/proc` does not help either, since in another PID namespace
 * that path is this process's own. The clock is the one thing two of them
 * are certain to share.
 */

/** The file that says which process owns DATA_DIR, under DATA_DIR itself. */
export const LOCK_FILE = 'orchestrator.lock';

/** How often the holder says it is still there, in milliseconds. */
export const HEARTBEAT_MS = 5_000;

/**
 * How long a claim outlives its last heartbeat before another process may
 * take it, in milliseconds.
 *
 * Several beats, so an event loop busy with a boot is not read as a process
 * that has died, and short enough that a box killed rather than stopped is
 * taken over on one of the restarts its policy is already making.
 */
export const LOCK_STALE_MS = 20_000;

/** What a claim answers with: the directory is this process's, or it is not. */
export type Claim =
  | {
      held: false;
      /** Stops the heartbeat and gives the directory up. */
      release: () => void;
      /**
       * When the claim this replaced was last stamped, or null where there
       * was none to replace. Worth a line in the log: a deployment taking
       * over every time it boots is one being killed rather than stopped.
       */
      tookOver: number | null;
    }
  | {
      held: true;
      /** How long ago the holder last said it was there, in milliseconds. */
      quietFor: number;
    };

/**
 * Claims dataDir for this process.
 *
 * `now` is injected so a test can move time rather than wait for it.
 */
export function claimDataDir(dataDir: string, now: () => number = Date.now): Claim {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILE);
  const stamp = (flag: 'wx' | 'w'): void => {
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: now() }), { flag });
  };

  /**
   * When the claim was last stamped, or null where there is nothing to read.
   *
   * A file this cannot parse is one an older build wrote, holding a bare id
   * and no time at all. There is no answering that, and whatever wrote it is
   * not stamping: it reads as abandoned, which is what lets a deployment
   * upgrade onto this without being locked out by its own predecessor.
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
