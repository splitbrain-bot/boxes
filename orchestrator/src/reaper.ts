import type { Config } from './config.ts';
import type { Db, SessionRow } from './db.ts';
import { log } from './log.ts';
import type { SessionManager } from './sessions.ts';

/**
 * Turn-aware idle reaper (plan §8.6). Stops — never deletes. All four
 * conditions must hold, so a long-running turn with a locked phone is never
 * interrupted, and a session blocked on an unanswered permission prompt is
 * kept alive so the answer still has somewhere to land.
 */
export function startReaper(
  db: Db,
  cfg: Config,
  manager: SessionManager,
): { stop: () => void } {
  const idleMs = cfg.IDLE_STOP_MINUTES * 60_000;

  const tick = async (): Promise<void> => {
    const rows = db
      .prepare("SELECT * FROM sessions WHERE status = 'running'")
      .all() as SessionRow[];
    const pendingCounts = manager.pending.countsBySession();
    const now = Date.now();

    for (const row of rows) {
      if (row.turn_active === 1) continue;
      if ((pendingCounts.get(row.id) ?? 0) > 0) continue;
      if (manager.upstream(row.id).attachedCount > 0) continue;
      if (now - row.last_active_at < idleMs) continue;

      try {
        await manager.stop(row.id);
        log.session(row.id).info('reaped idle session', {
          idleMinutes: Math.round((now - row.last_active_at) / 60_000),
        });
      } catch (err) {
        log.session(row.id).warn('reap failed', { error: (err as Error).message });
      }
    }

    manager.maintenance();
  };

  const timer = setInterval(() => {
    void tick().catch((err: Error) => log.error('reaper tick failed', { error: err.message }));
  }, 60_000);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}

/** 60s proxy-attachment reconcile loop (plan §8.4). */
export function startProxyReconciler(
  manager: SessionManager,
  onWarnings: (ids: string[]) => void,
): { stop: () => void } {
  const tick = async (): Promise<void> => {
    const warnings = await manager.reconcileProxyAttachments();
    onWarnings(warnings);
    if (warnings.length > 0) {
      log.warn('sessions missing egress proxy attachment', { sessions: warnings });
    }
  };
  const timer = setInterval(() => {
    void tick().catch((err: Error) =>
      log.error('proxy reconcile failed', { error: err.message }),
    );
  }, 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
