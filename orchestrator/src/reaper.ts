import type { Config } from './config.ts';
import { sessionsWithActiveTurns, type Db, type SessionRow } from './db.ts';
import type { EgressManager } from './egress.ts';
import { log } from './log.ts';
import type { SessionManager } from './sessions.ts';

/**
 * Starts the idle reaper and returns a handle that stops it. Every minute it
 * stops each session that has no running turn, no waiting permission request,
 * no attached browser and no activity for IDLE_STOP_MINUTES. It never deletes.
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
    // A turn runs on a thread, so "is this session busy" is any of its
    // threads being busy. The other three counts stay session-scoped: they
    // are about the box, not the conversation.
    const running = sessionsWithActiveTurns(db);
    const now = Date.now();

    for (const row of rows) {
      if (running.has(row.id)) continue;
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

/**
 * Starts the loop that pulls the session image again every
 * SESSION_IMAGE_PULL_MINUTES, and returns a handle that stops it. Returns a
 * no-op handle when the setting is 0.
 *
 * This is the whole of "keep the session image current": the pull puts the
 * new image on the host, and each session moves onto it the next time it is
 * started. Nothing running is disturbed, and a failed pull is a log line —
 * the image already here still works.
 */
export function startImageRefresher(
  cfg: Config,
  manager: SessionManager,
): { stop: () => void } {
  if (cfg.SESSION_IMAGE_PULL_MINUTES === 0) {
    log.info('session image refresh is off', { image: cfg.SESSION_IMAGE });
    return { stop: () => {} };
  }

  const timer = setInterval(
    () => {
      void manager.refreshSessionImage().catch((err: Error) => {
        log.warn('could not refresh the session image', {
          image: cfg.SESSION_IMAGE,
          error: err.message,
        });
      });
    },
    cfg.SESSION_IMAGE_PULL_MINUTES * 60_000,
  );
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}

/**
 * Starts the loop that re-asserts the proxy's state every minute: its
 * attachment to each session network, and the policy it is running.
 *
 * Both need re-asserting for the same reason. The proxy holds nothing at rest,
 * so a restart leaves it with no policy at all and compose can recreate it
 * without its dynamic network attachments. This loop is what closes both
 * windows, and is why the push is idempotent and cheap.
 */
export function startProxyReconciler(
  manager: SessionManager,
  egress: EgressManager,
  onWarnings: (ids: string[]) => void,
): { stop: () => void } {
  const tick = async (): Promise<void> => {
    const warnings = await manager.reconcileProxyAttachments();
    onWarnings(warnings);
    if (warnings.length > 0) {
      log.warn('sessions missing egress proxy attachment', { sessions: warnings });
    }
    try {
      await egress.sync();
    } catch (err) {
      log.warn('could not push the egress policy to the proxy', {
        error: (err as Error).message,
      });
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
