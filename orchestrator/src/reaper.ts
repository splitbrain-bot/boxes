import type { Config } from './config.ts';
import { refreshCredentials, type CredentialStore } from './credentials.ts';
import { boxTurnActive, boxesWithActiveTurns, type Db, type BoxRow } from './db.ts';
import type { EgressManager } from './egress.ts';
import { log } from './log.ts';
import type { BoxManager } from './boxes.ts';

/**
 * The interval every background loop here runs on. Each one re-asserts
 * something rather than reacting to an event.
 */
const TICK_MS = 60_000;

/**
 * Runs `tick` every `everyMs` until the returned handle stops it, logging
 * whatever it throws rather than letting it reach an unhandled rejection.
 *
 * One tick at a time: a tick that outlasts the interval skips the next one
 * rather than overlapping it. Each tick re-asserts a state rather than
 * reacting to an event, so the one in flight is already doing the work the
 * skipped one would have done.
 *
 * The timer is unreferenced, so a loop that is still scheduled never holds the
 * process open at shutdown.
 */
function loop(what: string, everyMs: number, tick: () => Promise<void>): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tick()
      .catch((err: Error) => log.error(`${what} failed`, { error: err.message }))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Starts the idle reaper and returns a handle that stops it. Every minute it
 * stops each box that has no running turn, no waiting permission request,
 * no attached browser, no open terminal, no background task still believed to
 * be running, and no activity for IDLE_STOP_MINUTES. It never deletes a
 * box.
 *
 * It does delete what a box left: the same tick sweeps the containers,
 * networks, volumes and workspace directories labelled with boxes that no
 * longer exist. An orphan is something no row names, so reconcile() at boot
 * cannot find it.
 */
export function startReaper(
  db: Db,
  cfg: Config,
  manager: BoxManager,
): { stop: () => void } {
  const idleMs = cfg.IDLE_STOP_MINUTES * 60_000;

  const tick = async (): Promise<void> => {
    const rows = db
      .prepare("SELECT * FROM boxes WHERE status = 'running'")
      .all() as BoxRow[];
    const pendingCounts = manager.pending.countsByBox();
    // A turn runs on a thread, so "is this box busy" is any of its
    // threads being busy. The other three counts stay box-scoped: they
    // are about the box, not the conversation.
    const running = boxesWithActiveTurns(db);
    const now = Date.now();

    for (const row of rows) {
      if (running.has(row.id)) continue;
      if ((pendingCounts.get(row.id) ?? 0) > 0) continue;
      const upstream = manager.upstream(row.id);
      if (upstream.attachedCount > 0) continue;
      // Somebody is in the box, however quiet the shell has gone: a build can
      // run for an hour without printing a line.
      if (manager.terminalCount(row.id) > 0) continue;
      // A box with a command still running in it, or a monitor still watching
      // something, is not idle however quiet it has gone. Any of the
      // box's threads holds the box.
      // Null is a box that has not been read yet, which is not a box known
      // to be empty: it is held for this tick, and the reading behind it
      // lands before the next one.
      if (upstream.backgroundActive !== false) continue;
      if (now - row.last_active_at < idleMs) continue;

      // Asked again for this one box, immediately before it is stopped.
      // The counts above are one reading of the whole deployment, and a
      // sweep that stops many boxes takes ten seconds over each of them, so
      // by here they are minutes old — long enough for a turn to have
      // started on a box nobody is watching.
      if (boxTurnActive(db, row.id)) continue;
      if (manager.pending.countForBox(row.id) > 0) continue;
      if (manager.terminalCount(row.id) > 0) continue;

      try {
        // Never waits for the box's own queue: a box something else is
        // already working on is not idle, whatever the counts above said, and
        // this tick has other boxes to get to.
        if (!(await manager.stopUnlessBusy(row.id))) {
          log.box(row.id).info('not reaping a box that is busy; trying again next tick');
          continue;
        }
        log.box(row.id).info('reaped idle box', {
          idleMinutes: Math.round((now - row.last_active_at) / 60_000),
        });
      } catch (err) {
        log.box(row.id).warn('reap failed', { error: (err as Error).message });
      }
    }

    manager.maintenance();
    // Docker read the other way round from reconcile(): what is labelled with
    // a box that no longer exists, and is therefore nobody's.
    await manager.sweepOrphans();
  };

  return loop('reaper tick', TICK_MS, tick);
}

/**
 * Starts the loop that pulls the box image again every
 * BOX_IMAGE_PULL_MINUTES, and returns a handle that stops it. Returns a
 * no-op handle when the setting is 0.
 *
 * How the box image stays current while the orchestrator runs, boot
 * having pulled it once already: the pull puts the new image on the host, and
 * each box moves onto it the next time it is started. Nothing running is
 * disturbed, and a failed pull is a log line — the image already here still
 * works.
 */
export function startImageRefresher(
  cfg: Config,
  manager: BoxManager,
): { stop: () => void } {
  if (cfg.BOX_IMAGE_PULL_MINUTES === 0) {
    log.info('box image refresh is off', { image: cfg.BOX_IMAGE });
    return { stop: () => {} };
  }

  // The one loop whose failure is a warning rather than an error.
  return loop('box image refresh', cfg.BOX_IMAGE_PULL_MINUTES * 60_000, async () => {
    try {
      await manager.refreshBoxImage();
    } catch (err) {
      log.warn('could not refresh the box image', {
        image: cfg.BOX_IMAGE,
        error: (err as Error).message,
      });
    }
  });
}

/**
 * Starts the loop that re-asserts the proxy's state every minute: its
 * attachment to each box network, and the policy it is running.
 *
 * Both need re-asserting for the same reason. The proxy holds nothing at
 * rest, so a restart leaves it with no policy at all, and compose can
 * recreate it without its dynamic network attachments. This loop closes both
 * windows.
 */
export function startProxyReconciler(
  manager: BoxManager,
  egress: EgressManager,
  onWarnings: (ids: string[]) => void,
): { stop: () => void } {
  const tick = async (): Promise<void> => {
    const warnings = await manager.reconcileProxyAttachments();
    onWarnings(warnings);
    if (warnings.length > 0) {
      log.warn('boxes missing egress proxy attachment', { boxes: warnings });
    }
    try {
      await egress.sync();
    } catch (err) {
      log.warn('could not push the egress policy to the proxy', {
        error: (err as Error).message,
      });
    }
  };
  return loop('proxy reconcile', TICK_MS, tick);
}

/**
 * Starts the loop that keeps the stored credentials true, and returns a handle
 * that stops it.
 *
 * A credential is the one thing Boxes holds that goes stale on its own: a
 * Codex subscription's access token lasts hours, its login goes stale after
 * eight days, and a Claude `setup-token` token runs out after a year with no
 * way to renew it. Every minute, because the window that matters is the hour
 * before an access token expires and a minute is cheap: the tick reads the
 * rows, refreshes what it can, and marks what it cannot.
 *
 * A refresh writes through the store, so the new material reaches the proxy on
 * the store's own change hook rather than waiting for the reconciler.
 */
export function startCredentialRefresh(credentials: CredentialStore): { stop: () => void } {
  return loop('credential refresh', TICK_MS, () => refreshCredentials(credentials));
}
