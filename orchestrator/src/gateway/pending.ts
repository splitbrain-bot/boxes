import type { Db, PendingRequestRow } from '../db.ts';
import { log } from '../log.ts';

/**
 * Permission requests the adapter is blocked on while no browser is attached.
 * The turn pauses until a human answers, or until PERMISSION_HOLD_MINUTES
 * expires and PERMISSION_FALLBACK applies.
 *
 * Each request gets a row, so the dashboard can show that something is waiting
 * and a restart does not lose that fact. The resolver that answers the request
 * lives in memory, so a row outliving its process can no longer be answered.
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
    sessionId: string,
    upstreamId: string,
    method: string,
    params: unknown,
    handlers: { resolve: (r: unknown) => void; reject: (e: Error) => void },
    holdMs: number,
    onTimeout: (entry: PendingEntry) => void,
  ): PendingEntry {
    const createdAt = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO pending_requests (session_id, upstream_id, method, params, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, upstreamId, method, JSON.stringify(params ?? null), createdAt);
    const id = Number(info.lastInsertRowid);
    const row: PendingRequestRow = {
      id,
      session_id: sessionId,
      upstream_id: upstreamId,
      method,
      params: JSON.stringify(params ?? null),
      created_at: createdAt,
    };
    const timer = setTimeout(() => {
      const entry = this.entries.get(id);
      if (entry) onTimeout(entry);
    }, holdMs);
    // Do not keep the process alive purely for a hold timer.
    timer.unref?.();
    const entry: PendingEntry = { row, ...handlers, timer };
    this.entries.set(id, entry);
    return entry;
  }

  /** Removes the entry and its DB row; safe to call twice. */
  settle(id: number): PendingEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.entries.delete(id);
    }
    this.db.prepare('DELETE FROM pending_requests WHERE id = ?').run(id);
    return entry;
  }

  /** The answerable entries of one session. */
  listForSession(sessionId: string): PendingEntry[] {
    return [...this.entries.values()].filter((e) => e.row.session_id === sessionId);
  }

  /** How many requests of one session are waiting. */
  countForSession(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pending_requests WHERE session_id = ?')
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Waiting request counts, keyed by session id. */
  countsBySession(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT session_id, COUNT(*) AS n FROM pending_requests GROUP BY session_id')
      .all() as Array<{ session_id: string; n: number }>;
    return new Map(rows.map((r) => [r.session_id, r.n]));
  }

  /** Fail everything outstanding for a session (container stop / delete). */
  failSession(sessionId: string, reason: string): void {
    for (const entry of this.listForSession(sessionId)) {
      this.settle(entry.row.id);
      entry.reject(new Error(reason));
    }
  }
}
