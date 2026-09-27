import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** Measurement of the disk space each box uses. */

/**
 * How long a measurement of a running box stands before a reader starts
 * another. It is long, because the dashboard shows the size rounded.
 */
export const BOX_SIZE_TTL_MS = 15 * 60_000;

/**
 * Apparent size of everything under a directory, in bytes.
 *
 * It sums file sizes, like `du --apparent-size`, not allocated blocks.
 *
 * Symlinks count as nothing and are not followed, so a link the agent
 * planted cannot lead the walk out of the tree.
 *
 * A subdirectory that cannot be read, for example because the agent deleted
 * it mid-walk, is skipped. An unreadable root throws.
 */
export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === root) throw err;
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        try {
          total += (await lstat(child)).size;
        } catch {
          // Deleted between the readdir and the stat. Nothing to add.
        }
      }
    }
  }
  return total;
}

/** The inputs of a BoxUsage. */
export interface UsageOptions {
  /**
   * The directories a box is made of, on this process's own filesystem.
   *
   * Null entries are dropped. For example, a box with a named home volume has
   * no home path. When all are null, the box reports no size rather than zero.
   */
  pathsOf: (boxId: string) => Array<string | null>;
  /** How long a measurement stands. */
  ttlMs: number;
  /** Test seam: the clock a measurement is stamped against. */
  now?: () => number;
  /** Test seam: how one directory is measured. */
  measure?: (path: string) => Promise<number>;
  /** Called when a walk fails, so the caller can log it. */
  onTrouble?: (boxId: string, error: Error) => void;
}

/** What was last measured for one box, and the state it was taken in. */
interface Measurement {
  /** Total size in bytes, or null when every attempt so far has failed. */
  bytes: number | null;
  /** When the measurement or failed attempt was recorded, in epoch ms. */
  at: number;
  /**
   * Whether the box was up when this was taken.
   *
   * A stopped box gets one more walk, because the last one ran while the
   * agent was writing. After a walk with the box down, none is taken again.
   */
  live: boolean;
}

/**
 * Box sizes, measured off the request path and cached per box. A walk starts
 * only when a reader asks, so a deployment nobody looks at walks no disk.
 */
export class BoxUsage {
  /** The last measurement of each box. */
  private readonly measured = new Map<string, Measurement>();
  /** Boxes with a walk running or queued, so a poll cannot pile them up. */
  private readonly walking = new Set<string>();
  /**
   * How many times each box has been forgotten. A walk carries the number
   * it started under, so one that was measuring while the workspace changed
   * is dropped rather than stored as the answer.
   */
  private readonly generations = new Map<string, number>();
  /**
   * The chain that runs the walks one after another. A list request asks
   * about every box at once, and all walks go to the same disk.
   */
  private queue: Promise<void> = Promise.resolve();

  /** Returns the directories of a box. */
  private readonly pathsOf: UsageOptions['pathsOf'];
  /** How long a measurement of a running box stands, in milliseconds. */
  private readonly ttlMs: number;
  /** The clock a measurement is stamped against. */
  private readonly now: () => number;
  /** Measures one directory, in bytes. */
  private readonly measure: (path: string) => Promise<number>;
  /** Receives the error of a failed walk. */
  private readonly onTrouble: (boxId: string, error: Error) => void;

  constructor(options: UsageOptions) {
    this.pathsOf = options.pathsOf;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.measure = options.measure ?? directorySize;
    this.onTrouble = options.onTrouble ?? (() => {});
  }

  /**
   * Returns the last measured size of the box, and starts a walk when the
   * size may have changed. The caller never waits for a walk.
   *
   * Null means no answer yet, not empty: before the first walk finishes, and
   * for a box with no directories.
   *
   * `live` is whether the box could still be writing to its directories.
   */
  bytes(boxId: string, live: boolean): number | null {
    const paths = this.pathsOf(boxId).filter((p): p is string => p !== null);
    if (paths.length === 0) return null;
    const last = this.measured.get(boxId);
    if (this.due(last, live)) this.start(boxId, paths, live);
    return last?.bytes ?? null;
  }

  /**
   * Drops the measurement, so the next read walks again. A walk still running
   * for the box is discarded.
   */
  forget(boxId: string): void {
    this.measured.delete(boxId);
    this.generations.set(boxId, (this.generations.get(boxId) ?? 0) + 1);
  }

  /** Whether the box was forgotten since the walk of this generation started. */
  private overtaken(boxId: string, generation: number): boolean {
    return (this.generations.get(boxId) ?? 0) !== generation;
  }

  /** Whether the box is due another walk. */
  private due(last: Measurement | undefined, live: boolean): boolean {
    if (!last) return true;
    // Retry failures on the interval, so a permission fixed by hand shows up.
    if (last.bytes === null) return this.now() - last.at >= this.ttlMs;
    // A box that is down is walked once more, then not while it stays down.
    if (!live) return last.live;
    return this.now() - last.at >= this.ttlMs;
  }

  /** Test seam: resolves once every walk started so far has finished. */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * Queues the walk of one box, unless it already has one queued.
   *
   * The walk sums all its directories. A failure in any of them abandons the
   * whole walk rather than report part of the size.
   */
  private start(boxId: string, paths: readonly string[], live: boolean): void {
    if (this.walking.has(boxId)) return;
    this.walking.add(boxId);
    this.queue = this.queue.then(async () => {
      const generation = this.generations.get(boxId) ?? 0;
      try {
        let bytes = 0;
        for (const path of paths) bytes += await this.measure(path);
        // The box was forgotten during the walk, so this total is out of date.
        if (this.overtaken(boxId, generation)) return;
        // Stored with the state at request time, so a box stopped while this
        // walk was queued is walked again at its next read.
        this.measured.set(boxId, { bytes, at: this.now(), live });
      } catch (err) {
        // Keep the last size, but record the attempt, so a walk that keeps
        // failing is retried on the interval rather than on every request.
        if (!this.overtaken(boxId, generation)) {
          const last = this.measured.get(boxId);
          this.measured.set(boxId, { bytes: last?.bytes ?? null, at: this.now(), live });
        }
        this.onTrouble(boxId, err as Error);
      } finally {
        this.walking.delete(boxId);
      }
    });
  }
}
