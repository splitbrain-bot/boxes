import type { Db, PendingRequestRow } from '../db.ts';
import { log } from '../log.ts';

/** One queued permission request and the handlers waiting on its answer. */
export interface PendingEntry {
  /** The stored row of this request. */
  row: PendingRequestRow;
  /** Resolves the upstream request with the browser's chosen outcome. */
  resolve: (result: unknown) => void;
  /** Fails the upstream request. */
  reject: (error: Error) => void;
  /** Fires when the hold expires. */
  timer: NodeJS.Timeout;
  /**
   * One per browser this request has been put to and not yet heard from.
   *
   * Every browser that opens the thread gets the question, and only the first
   * answer counts. Aborting a delivery tells that browser the question is over.
   */
  readonly deliveries: Set<AbortController>;
}

/**
 * The queue of unanswered permission requests, in memory and in the database.
 *
 * The adapter blocks until a human answers, or until PERMISSION_HOLD_MINUTES
 * expires and PERMISSION_FALLBACK applies. The row lets the dashboard show
 * that something is waiting. The resolver lives in memory only, so a row left
 * by an earlier process cannot be answered.
 */
export class PendingStore {
  /** The answerable entries, by row id. */
  private readonly entries = new Map<number, PendingEntry>();

  constructor(private readonly db: Db) {}

  /** Drops rows left behind by a previous orchestrator process. */
  clearStale(): void {
    const removed = this.db.prepare('DELETE FROM pending_requests').run();
    if (removed.changes > 0) {
      log.info('cleared stale pending permission requests', { count: removed.changes });
    }
  }

  /**
   * Queues a request and returns its entry.
   *
   * @param onTimeout Runs after holdMs unless the entry is settled first.
   */
  add(
    boxId: string,
    acpSessionId: string | null,
    method: string,
    params: unknown,
    handlers: { resolve: (r: unknown) => void; reject: (e: Error) => void },
    holdMs: number,
    onTimeout: (entry: PendingEntry) => void,
  ): PendingEntry {
    const createdAt = Date.now();
    // Serialized once, so the returned row matches the stored one.
    const serialized = JSON.stringify(params ?? null);
    const info = this.db
      .prepare(
        `INSERT INTO pending_requests
           (box_id, acp_session_id, method, params, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(boxId, acpSessionId, method, serialized, createdAt);
    const id = Number(info.lastInsertRowid);
    const row: PendingRequestRow = {
      id,
      box_id: boxId,
      acp_session_id: acpSessionId,
      method,
      params: serialized,
      created_at: createdAt,
    };
    const timer = setTimeout(() => {
      const entry = this.entries.get(id);
      if (entry) onTimeout(entry);
    }, holdMs);
    timer.unref?.();
    const entry: PendingEntry = { row, ...handlers, timer, deliveries: new Set() };
    this.entries.set(id, entry);
    return entry;
  }

  /**
   * Removes the entry and its DB row. Safe to call twice.
   *
   * @returns The entry, or undefined when it was already settled.
   */
  settle(id: number): PendingEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      // Withdraws the question from every browser still showing it.
      for (const delivery of entry.deliveries) delivery.abort();
      entry.deliveries.clear();
      this.entries.delete(id);
    }
    this.db.prepare('DELETE FROM pending_requests WHERE id = ?').run(id);
    return entry;
  }

  /** The answerable entries of one box, across every thread. */
  listForBox(boxId: string): PendingEntry[] {
    return [...this.entries.values()].filter((e) => e.row.box_id === boxId);
  }

  /** The answerable entries of one thread. */
  listForThread(boxId: string, acpSessionId: string): PendingEntry[] {
    return this.listForBox(boxId).filter(
      (e) => e.row.acp_session_id === acpSessionId,
    );
  }

  /** How many requests of one box are waiting. */
  countForBox(boxId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pending_requests WHERE box_id = ?')
      .get(boxId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Waiting request counts of one box, keyed by the adapter's thread id. */
  countsByThread(boxId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT acp_session_id, COUNT(*) AS n FROM pending_requests
          WHERE box_id = ? AND acp_session_id IS NOT NULL
          GROUP BY acp_session_id`,
      )
      .all(boxId) as Array<{ acp_session_id: string; n: number }>;
    return new Map(rows.map((r) => [r.acp_session_id, r.n]));
  }

  /** Waiting request counts, keyed by box id. */
  countsByBox(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT box_id, COUNT(*) AS n FROM pending_requests GROUP BY box_id')
      .all() as Array<{ box_id: string; n: number }>;
    return new Map(rows.map((r) => [r.box_id, r.n]));
  }

  /** Rejects every queued request of a box, for a box that stops or is deleted. */
  failBox(boxId: string, reason: string): void {
    for (const entry of this.listForBox(boxId)) {
      this.settle(entry.row.id);
      entry.reject(new Error(reason));
    }
  }

  /** Rejects every queued request of one thread, for an adapter that has exited. */
  failThread(boxId: string, acpSessionId: string, reason: string): void {
    for (const entry of this.listForThread(boxId, acpSessionId)) {
      this.settle(entry.row.id);
      entry.reject(new Error(reason));
    }
  }
}
