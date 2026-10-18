/** Measurement of the disk space each box uses. */

/**
 * The time in milliseconds for which a measurement of a running box stays
 * valid before a reader starts another. It is long, because the dashboard
 * shows the size rounded.
 */
export const BOX_SIZE_TTL_MS = 15 * 60_000;

/** The inputs of a BoxUsage. */
export interface UsageOptions {
  /**
   * Measures a running box. The file service in the box walks its files.
   *
   * @param boxId The id of the box.
   * @returns The size in bytes.
   */
  measure: (boxId: string) => Promise<number>;
  /**
   * Stores a measurement with its time.
   *
   * @param boxId The id of the box.
   * @param bytes The size in bytes.
   * @param at The time of the measurement, in epoch milliseconds.
   */
  store: (boxId: string, bytes: number, at: number) => void;
  /** The time in milliseconds for which a measurement stays valid. */
  ttlMs: number;
  /**
   * The clock for the time of a measurement, for tests.
   *
   * @returns The current time in epoch milliseconds.
   */
  now?: () => number;
  /**
   * Receives a failed measurement, so the caller can log it.
   *
   * @param boxId The id of the box.
   * @param error The error of the measurement.
   */
  onTrouble?: (boxId: string, error: Error) => void;
}

/**
 * The disk usage of the boxes, which the file service in each box measures.
 *
 * A box gets a measurement before each stop. A reader starts a new measurement
 * of a running box when the last one is older than the TTL. Nothing in a
 * stopped box changes, so its stored value stays correct. A failed measurement
 * keeps the value and the time of the last good one.
 */
export class BoxUsage {
  /** The boxes with a running or queued measurement, so a poll cannot queue more. */
  private readonly measuring = new Set<string>();
  /**
   * The time of the last failed measurement of each box. A box that continues
   * to fail gets a new try after the TTL, and not at each read.
   */
  private readonly failed = new Map<string, number>();
  /**
   * The chain that runs the measurements that readers start, one after the
   * other. A list request asks for every box at once, and on one host all walks
   * use the same disk.
   */
  private queue: Promise<void> = Promise.resolve();

  /** Measures one box, in bytes. */
  private readonly measure: UsageOptions['measure'];
  /** Stores one measurement. */
  private readonly store: UsageOptions['store'];
  /** The time in milliseconds for which a measurement of a running box stays valid. */
  private readonly ttlMs: number;
  /** The clock for the time of a measurement. */
  private readonly now: () => number;
  /** Receives the error of a failed measurement. */
  private readonly onTrouble: (boxId: string, error: Error) => void;

  /**
   * @param options The measure and store functions, the TTL, and the optional clock and error callback.
   */
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
   * @param boxId The id of the box.
   * @param measuredAt The time of the stored measurement, or null when there is none.
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
   *
   * @param boxId The id of the box.
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

  /**
   * Waits for the queued measurements, for tests.
   *
   * @returns A promise that resolves when every queued measurement is finished.
   */
  settled(): Promise<void> {
    return this.queue;
  }
}
