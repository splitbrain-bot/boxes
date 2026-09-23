import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How much disk a box is taking up, measured off the request path and
 * read from a cache.
 *
 * Two directories, summed: the workspace the agent works in, and the home its
 * thread history, tool caches and runtime installs are in.
 *
 * A request never waits for a measurement. `bytes()` answers with what was
 * last measured — null before the first one — and starts a walk only when the
 * answer may have moved. A measurement of a running box stands for a quarter
 * of an hour, and a box that is down is measured once and then left alone.
 *
 * The walks are lazy rather than on a timer, so a deployment nobody is
 * looking at walks no disk.
 */

/**
 * How long a measurement of a running box stands before a reader starts
 * another.
 *
 * Long, because the answer is shown rounded to two significant figures: it
 * takes about a hundred megabytes to change what a card says. A box with no
 * measurement yet does not wait for this; its first read starts a walk.
 */
export const BOX_SIZE_TTL_MS = 15 * 60_000;

/**
 * Apparent size of everything under a directory, in bytes.
 *
 * Sizes rather than allocated blocks — `du --apparent-size` rather than `du`.
 * The two disagree by whatever the filesystem does underneath, which for a
 * tree of many small files is most of the answer.
 *
 * Symlinks are counted as nothing and never followed. `readdir` reports the
 * link itself rather than what it points at, so a link the agent planted in
 * its workspace cannot walk this out of the tree.
 *
 * A directory that disappears mid-walk is skipped, because a walk of a live
 * workspace races with the agent working in it. The root is the exception: a
 * workspace that cannot be read at all throws.
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

export interface UsageOptions {
  /**
   * The directories a box is made of, on this process's own filesystem.
   *
   * Nulls are expected and dropped: an unknown box has none of them, and
   * a box from before homes became directories has a workspace and a home
   * volume nothing out here can walk. All-null means there is nothing to
   * measure, and the box reports no size rather than a zero.
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
  /** Null when every attempt so far has failed: an attempt is not an answer. */
  bytes: number | null;
  at: number;
  /**
   * Whether the box was up when this was taken.
   *
   * A stopped box still gets one walk, because the measurement before it
   * was of a workspace being written to. Once one has been taken with the box
   * down, nothing can change it and none is taken again.
   */
  live: boolean;
}

/** Box sizes, measured off the request path and cached per box. */
export class BoxUsage {
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
   * The walks, one after another.
   *
   * A list request asks about every box at once, and the walks all go to
   * the same disk. Nothing waits for one.
   */
  private queue: Promise<void> = Promise.resolve();

  private readonly pathsOf: UsageOptions['pathsOf'];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly measure: (path: string) => Promise<number>;
  private readonly onTrouble: (boxId: string, error: Error) => void;

  constructor(options: UsageOptions) {
    this.pathsOf = options.pathsOf;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.measure = options.measure ?? directorySize;
    this.onTrouble = options.onTrouble ?? (() => {});
  }

  /**
   * What the box's workspace last measured, and a walk started if there
   * is reason to think that has moved.
   *
   * Null means "no answer yet" rather than "empty": before the first walk
   * finishes, and for a box with no workspace directory.
   *
   * `live` is whether the box could still be writing to the workspace. Only a
   * container known to be down makes it false, since a Docker read that
   * failed says nothing about whether the agent is working.
   */
  bytes(boxId: string, live: boolean): number | null {
    const paths = this.pathsOf(boxId).filter((p): p is string => p !== null);
    if (paths.length === 0) return null;
    const last = this.measured.get(boxId);
    if (this.due(last, live)) this.start(boxId, paths, live);
    return last?.bytes ?? null;
  }

  /**
   * Drops what was measured, so the next read walks again.
   *
   * For a box going away, and for an upload, which is the one thing that
   * puts enough bytes in a stopped workspace to move the number. A box that
   * is down cannot otherwise grow, which is what freezing its measurement
   * rests on.
   */
  forget(boxId: string): void {
    this.measured.delete(boxId);
    this.generations.set(boxId, (this.generations.get(boxId) ?? 0) + 1);
  }

  /** Whether the box changed under a walk, which makes its total history. */
  private overtaken(boxId: string, generation: number): boolean {
    return (this.generations.get(boxId) ?? 0) !== generation;
  }

  /** Whether there is any reason to walk this workspace again. */
  private due(last: Measurement | undefined, live: boolean): boolean {
    // Nothing known about it at all.
    if (!last) return true;
    // Every attempt so far has failed. Retry on the interval rather than
    // never: a permission fixed by hand should show up eventually.
    if (last.bytes === null) return this.now() - last.at >= this.ttlMs;
    // A box that is down is measured once — the walk that settles what it was
    // left at — and then not again for as long as it stays down.
    if (!live) return last.live;
    return this.now() - last.at >= this.ttlMs;
  }

  /** Test seam: resolves once every walk started so far has finished. */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * Queues one box's walks, unless it already has some coming.
   *
   * Its directories are walked one after another and summed, and a failure in
   * either abandons the pair rather than reporting half a box's size.
   */
  private start(boxId: string, paths: readonly string[], live: boolean): void {
    if (this.walking.has(boxId)) return;
    this.walking.add(boxId);
    this.queue = this.queue.then(async () => {
      const generation = this.generations.get(boxId) ?? 0;
      try {
        let bytes = 0;
        for (const path of paths) bytes += await this.measure(path);
        // An upload landed while this was walking, so this total is of the
        // workspace as it was before it. Dropped rather than stored with a
        // fresh timestamp, which would freeze the old number in place.
        if (this.overtaken(boxId, generation)) return;
        // Recorded against the state the box was in when the walk was asked
        // for rather than the state it is in now, so a box stopped while
        // its settling walk was queued is walked again at its next read.
        this.measured.set(boxId, { bytes, at: this.now(), live });
      } catch (err) {
        // Hold the last answer, since a workspace that could not be read is
        // not one known to be empty, but record the attempt so a walk that
        // keeps failing is retried on the interval rather than per request.
        // Not for a box that changed under the walk: that one is due a
        // reading whatever this one found.
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
