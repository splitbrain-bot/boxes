/** Measurement of the disk space each box uses. */

/**
 * How long a measurement of a running box stands before a reader starts
 * another. It is long, because the dashboard shows the size rounded.
 */
export const BOX_SIZE_TTL_MS = 15 * 60_000;

/** The inputs of a BoxUsage. */
export interface UsageOptions {
  /** Measures a running box, in bytes. The file service in the box walks its files. */
  measure: (boxId: string) => Promise<number>;
  /** Stores a measurement with the time it was taken, in epoch ms. */
  store: (boxId: string, bytes: number, at: number) => void;
  /** How long a measurement stands. */
  ttlMs: number;
  /** Test seam: the clock a measurement is stamped against. */
  now?: () => number;
  /** Called when a measurement fails, so the caller can log it. */
  onTrouble?: (boxId: string, error: Error) => void;
}

/**
 * Box sizes, measured by the file service in each box.
 *
 * A box is measured before each stop, and a running box again when a reader
 * finds its measurement older than the TTL. Nothing in a stopped box changes,
 * so its stored value stays correct. A failed measurement keeps the value and
 * the time of the last one.
 */
export class BoxUsage {
  /** Boxes with a measurement running or queued, so a poll cannot pile them up. */
  private readonly measuring = new Set<string>();
  /**
   * When a measurement of each box last failed. A box that keeps failing is
   * tried again on the TTL, not on every read.
   */
  private readonly failed = new Map<string, number>();
  /**
   * The chain that runs the measurements a reader starts, one after another.
   * A list request asks about every box at once, and on one host all walks
   * go to the same disk.
   */
  private queue: Promise<void> = Promise.resolve();

  /** Measures one box, in bytes. */
  private readonly measure: UsageOptions['measure'];
  /** Stores one measurement. */
  private readonly store: UsageOptions['store'];
  /** How long a measurement of a running box stands, in milliseconds. */
  private readonly ttlMs: number;
  /** The clock a measurement is stamped against. */
  private readonly now: () => number;
  /** Receives the error of a failed measurement. */
  private readonly onTrouble: (boxId: string, error: Error) => void;

  constructor(options: UsageOptions) {
    this.measure = options.measure;
    this.store = options.store;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.onTrouble = options.onTrouble ?? (() => {});
  }

  /**
   * Queues a measurement of a running box when its last one is older than
   * the TTL. The caller never waits.
   *
   * `measuredAt` is when the stored measurement was taken, or null when there
   * is none.
   */
  refresh(boxId: string, measuredAt: number | null): void {
    const last = Math.max(measuredAt ?? -Infinity, this.failed.get(boxId) ?? -Infinity);
    if (this.now() - last < this.ttlMs) return;
    if (this.measuring.has(boxId)) return;
    this.measuring.add(boxId);
    this.queue = this.queue.then(async () => {
      try {
        await this.measureNow(boxId);
      } finally {
        this.measuring.delete(boxId);
      }
    });
  }

  /**
   * Measures a running box and stores the result, for a stop that waits for
   * it. A failure is reported to `onTrouble` and not thrown.
   */
  async measureNow(boxId: string): Promise<void> {
    try {
      const bytes = await this.measure(boxId);
      this.failed.delete(boxId);
      this.store(boxId, bytes, this.now());
    } catch (err) {
      this.failed.set(boxId, this.now());
      this.onTrouble(boxId, err as Error);
    }
  }

  /** Test seam: resolves once every measurement queued so far has finished. */
  settled(): Promise<void> {
    return this.queue;
  }
}
