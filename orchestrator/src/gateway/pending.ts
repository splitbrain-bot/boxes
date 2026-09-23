import type { Db, PendingRequestRow } from '../db.ts';
import { log } from '../log.ts';

/**
 * Permission requests the adapter is blocked on while no browser is attached.
 * The turn pauses until a human answers, or until PERMISSION_HOLD_MINUTES
 * expires and PERMISSION_FALLBACK applies.
 *
 * Each request gets a row, so the dashboard can show that something is waiting
 * and a restart does not lose that fact. The resolver that answers the request
 * lives in memory, so a row that outlives its process cannot be answered.
 */

/** One queued permission request and the handlers waiting on its answer. */
export interface PendingEntry {
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
   * The same question goes to every browser that opens the thread, and only
   * the first answer counts. Aborting the rest is what tells those browsers
   * the question is over, so a card is not left waiting for an answer that
   * would be discarded.
   */
  readonly deliveries: Set<AbortController>;
}

/** The queue of unanswered permission requests, in memory and in the database. */
export class PendingStore {
  private readonly entries = new Map<number, PendingEntry>();

  constructor(private readonly db: Db) {}

  /** Drop rows left behind by a previous orchestrator process. */
  clearStale(): void {
    const removed = this.db.prepare('DELETE FROM pending_requests').run();
    if (removed.changes > 0) {
      log.info('cleared stale pending permission requests', { count: removed.changes });
    }
  }

  /**
   * Queues a request and returns its entry. The timeout callback fires after
   * holdMs unless the entry is settled first.
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
    // Serialized once: the row handed back has to be the row that was stored,
    // and stringifying twice made that a coincidence rather than a fact.
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
    // Do not keep the process alive purely for a hold timer.
    timer.unref?.();
    const entry: PendingEntry = { row, ...handlers, timer, deliveries: new Set() };
    this.entries.set(id, entry);
    return entry;
  }

  /** Removes the entry and its DB row; safe to call twice. */
  settle(id: number): PendingEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      // Whoever else is still showing this question is told it is over,
      // however it was settled: an answer from another browser, the hold
      // running out, or the box stopping.
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

  /**
   * The answerable entries of one thread, which is what a browser watching
   * that thread is given. A request from another conversation is not this
   * browser's to answer.
   */
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

  /**
   * Waiting request counts of one box, keyed by the adapter's thread id.
   *
   * A column rather than the stored params: the params carry the thread too,
   * but a query wants a column, and this is what the per-thread badge counts.
   */
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

  /** Fail everything outstanding for a box (container stop / delete). */
  failBox(boxId: string, reason: string): void {
    for (const entry of this.listForBox(boxId)) {
      this.settle(entry.row.id);
      entry.reject(new Error(reason));
    }
  }

  /**
   * Rejects every queued request of one thread, for an adapter that has gone
   * with the thread still asking. Its other threads, and the box's other
   * adapter, keep their questions.
   */
  failThread(boxId: string, acpSessionId: string, reason: string): void {
    for (const entry of this.listForThread(boxId, acpSessionId)) {
      this.settle(entry.row.id);
      entry.reject(new Error(reason));
    }
  }
}
