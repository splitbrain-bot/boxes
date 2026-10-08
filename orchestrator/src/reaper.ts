import type { AgentStore } from './agents.ts';
import type { Config } from './config.ts';
import { refreshCredentials, type CredentialStore } from './credentials.ts';
import { boxTurnActive, boxesWithActiveTurns, type Db, type BoxRow } from './db.ts';
import type { EgressManager } from './egress.ts';
import { log } from './log.ts';
import type { BoxManager } from './boxes.ts';
import type { TunnelReconciler } from './tunnels.ts';

/** The interval of the reaper, proxy and credential loops, in milliseconds. */
const TICK_MS = 60_000;

/**
 * Runs `tick` every `everyMs` until the returned handle stops it, logging
 * whatever it throws rather than letting it reach an unhandled rejection.
 *
 * A tick that outlasts the interval skips the next one rather than overlap
 * it. Each tick re-asserts a state, so the running tick does the skipped
 * one's work. The timer does not keep the process alive.
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
 * be running, and no activity for IDLE_STOP_MINUTES. It never deletes a box.
 *
 * The same tick removes the Docker objects and directories of boxes that no
 * longer exist. No row names them, so reconcile() at boot cannot find them.
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
    // A box is busy when any of its threads has a turn running.
    const running = boxesWithActiveTurns(db);
    const now = Date.now();

    for (const row of rows) {
      if (running.has(row.id)) continue;
      if ((pendingCounts.get(row.id) ?? 0) > 0) continue;
      const upstream = manager.upstream(row.id);
      if (upstream.attachedCount > 0) continue;
      // An open terminal holds the box, as a build can run silently for an hour.
      if (manager.terminalCount(row.id) > 0) continue;
      // A background command or monitor in any thread holds the box. Null
      // means not read yet, so the box is held for this tick.
      if (upstream.backgroundActive !== false) continue;
      if (now - row.last_active_at < idleMs) continue;

      // Checked again just before the stop. Each stop can take ten seconds,
      // so the counts above may be minutes old by now.
      if (boxTurnActive(db, row.id)) continue;
      if (manager.pending.countForBox(row.id) > 0) continue;
      if (manager.terminalCount(row.id) > 0) continue;

      try {
        // Does not wait for the box's queue: a box with queued work is not
        // idle, and this tick has other boxes to check.
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
    // The reverse of reconcile(): objects labelled with a box that no longer
    // exists.
    await manager.sweepOrphans();
  };

  return loop('reaper tick', TICK_MS, tick);
}

/**
 * Starts the loop that pulls the box image again every
 * BOX_IMAGE_PULL_MINUTES, and returns a handle that stops it. Returns a
 * no-op handle when the setting is 0.
 *
 * Each box moves onto a new image at its next start, so nothing running is
 * disturbed. A failed pull is logged, and the image already here still works.
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
 * Starts the loop that re-asserts the proxy's state every minute, and returns
 * a handle that stops it. The state is the proxy's attachment to each box
 * network, and its policy. A proxy restart loses the policy, and a recreate
 * by compose loses the attachments.
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
 * Starts the loop that keeps the stored credentials valid, and returns a handle
 * that stops it.
 *
 * It runs every minute, well inside the hour before an access token expires.
 */
export function startCredentialRefresh(credentials: CredentialStore): { stop: () => void } {
  return loop('credential refresh', TICK_MS, () => refreshCredentials(credentials));
}

/**
 * Starts the loop that pulls the skill repositories of the agent sets, and
 * returns a handle that stops it.
 *
 * It looks every minute, and pulls a repository when its last pull is a day
 * old.
 */
export function startSkillRepoRefresh(agents: AgentStore): { stop: () => void } {
  return loop('skill repository refresh', TICK_MS, () => agents.pullDue());
}

/**
 * Starts the tunnel reconciler and returns a handle that stops it. Every
 * minute it reads which dev tunnels each box hosts, and deletes the
 * remembered tunnels that no box has hosted for a few minutes.
 */
export function startTunnelReconciler(tunnels: TunnelReconciler): { stop: () => void } {
  return loop('tunnel reconciler', TICK_MS, () => tunnels.tick());
}
