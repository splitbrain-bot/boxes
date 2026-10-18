import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { BoxManager } from './boxes.ts';
import { loadConfig } from './config.ts';
import { type Db, openDb } from './db.ts';
import { startReaper } from './reaper.ts';

/** How long a box must be quiet before the reaper stops it, in minutes. */
const IDLE_MINUTES = 30;

/** The temporary data directory of the current test. */
let dir: string;
/** The database of the current test. */
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-reaper-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/**
 * Inserts a running box row.
 *
 * @param id The box id.
 * @param idleMinutes How long the box has been quiet, in minutes.
 */
function insertBox(id: string, idleMinutes: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO boxes (id, name, profile, status, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'running', ?, ?)`,
  ).run(id, now - idleMinutes * 60_000, now - idleMinutes * 60_000);
}

/**
 * Inserts a thread of a box, with or without a turn running on it.
 *
 * @param id The thread id.
 * @param boxId The box id.
 * @param turnActive True for a thread with a turn running.
 */
function insertThread(id: string, boxId: string, turnActive = false): void {
  db.prepare(
    `INSERT INTO threads (id, box_id, acp_session_id, title, ordinal,
       turn_active, created_at, last_active_at)
     VALUES (?, ?, ?, NULL, 1, ?, 1000, 2000)`,
  ).run(id, boxId, `acp-${id}`, turnActive ? 1 : 0);
}

/**
 * Runs one tick of the reaper over a manager that answers as told.
 *
 * @param over The answers of the fake manager.
 * @returns The ids of the boxes that the reaper stopped.
 */
async function tick(
  over: {
    /** Permission requests waiting on box s1. */
    pending?: number;
    /** Browsers attached to each box. */
    attachedCount?: number;
    /** The background state of each box. Null means it has not been read yet. */
    backgroundActive?: boolean | null;
    /** Runs as each box is stopped, to simulate events during a slow stop. */
    onStop?: (id: string) => void;
    /** The pending count, read again just before a box is stopped. */
    pendingNow?: (id: string) => number;
    /** Terminals open on the box, which means somebody works in it directly. */
    terminals?: number;
    /** The terminal count, read again just before a box is stopped. */
    terminalsNow?: (id: string) => number;
    /** Boxes with an operation in progress, which the reaper skips without waiting. */
    busy?: Set<string>;
  } = {},
): Promise<string[]> {
  const stopped: string[] = [];
  const manager = {
    pending: {
      countsByBox: () => new Map(over.pending ? [['s1', over.pending]] : []),
      countForBox: (id: string) => over.pendingNow?.(id) ?? (id === 's1' ? (over.pending ?? 0) : 0),
    },
    upstream: () => ({
      attachedCount: over.attachedCount ?? 0,
      backgroundActive: over.backgroundActive === undefined ? false : over.backgroundActive,
    }),
    terminalCount: (id: string) => over.terminalsNow?.(id) ?? over.terminals ?? 0,
    stopUnlessBusy: (id: string) => {
      if (over.busy?.has(id)) return Promise.resolve(false);
      stopped.push(id);
      over.onStop?.(id);
      return Promise.resolve(true);
    },
    maintenance: () => undefined,
    sweepOrphans: () => Promise.resolve(),
  } as unknown as BoxManager;

  vi.useFakeTimers();
  const cfg = loadConfig({ DATA_DIR: dir, IDLE_STOP_MINUTES: String(IDLE_MINUTES) });
  const reaper = startReaper(db, cfg, manager);
  await vi.advanceTimersByTimeAsync(60_000);
  reaper.stop();
  return stopped;
}

test('a box quiet for longer than the idle limit is stopped', async () => {
  insertBox('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick(), ['s1']);
});

test('a box quiet for less than the idle limit is left running', async () => {
  insertBox('s1', IDLE_MINUTES / 2);
  assert.deepEqual(await tick(), []);
});

test("a turn running on any of a box's threads holds the box", async () => {
  insertBox('s1', IDLE_MINUTES + 1);
  insertThread('t1', 's1');
  insertThread('t2', 's1', true);
  assert.deepEqual(await tick(), []);
});

test('a permission request waiting for an answer holds the box', async () => {
  insertBox('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ pending: 1 }), []);
});

test('a browser still attached holds the box', async () => {
  insertBox('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ attachedCount: 1 }), []);
});

test('a terminal open on the box holds it, however quiet the shell has gone', async () => {
  // The activity clock cannot see a build that prints nothing for an hour
  // while somebody watches it. Stopping the box would end the shell, its
  // scrollback and the build.
  insertBox('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ terminals: 1 }), []);
});

test('work left running in the background holds the box', async () => {
  insertBox('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ backgroundActive: true }), []);
});

test('a box whose work has not been read yet is held for this tick', async () => {
  // After every restart, the probe has not answered yet. A box with an
  // unwatched build in it then looks like an idle one.
  insertBox('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ backgroundActive: null }), []);
});

test('a turn that starts while another box is being stopped holds its own box', async () => {
  // The counts the tick opens with are one reading of the whole deployment,
  // and stopping a box takes seconds. By the time a sweep of many idle boxes
  // reaches the last of them, a prompt sent meanwhile is minutes old.
  insertBox('s1', IDLE_MINUTES + 1);
  insertBox('s2', IDLE_MINUTES + 1);
  insertThread('t2', 's2');
  const stopped = await tick({
    onStop: (id) => {
      if (id === 's1') {
        db.prepare("UPDATE threads SET turn_active = 1 WHERE id = 't2'").run();
      }
    },
  });
  assert.deepEqual(stopped, ['s1']);
});

test('a permission request that arrives mid-sweep holds its box', async () => {
  // The request arrives while the first box is being stopped, so only a fresh
  // count can see it.
  insertBox('s1', IDLE_MINUTES + 1);
  insertBox('s2', IDLE_MINUTES + 1);
  let asked = false;
  const stopped = await tick({
    onStop: () => {
      asked = true;
    },
    pendingNow: (id) => (asked && id === 's2' ? 1 : 0),
  });
  assert.deepEqual(stopped, ['s1']);
});

test('a terminal opened mid-sweep holds its box', async () => {
  // Stopping many boxes takes long enough for somebody to open a shell in one
  // of them.
  insertBox('s1', IDLE_MINUTES + 1);
  insertBox('s2', IDLE_MINUTES + 1);
  const opened = new Set<string>();
  assert.deepEqual(
    await tick({
      onStop: (id) => opened.add(id === 's1' ? 's2' : 's1'),
      terminalsNow: (id) => (opened.has(id) ? 1 : 0),
    }),
    ['s1'],
  );
});

test('a tick still running when the next one is due is not joined by it', async () => {
  // Stopping many boxes can take longer than the interval. Two ticks at once
  // would sweep each other's half-finished work.
  insertBox('s1', IDLE_MINUTES + 1);
  let sweeps = 0;
  let finish: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const manager = {
    pending: {
      countsByBox: () => new Map<string, number>(),
      countForBox: () => 0,
    },
    upstream: () => ({ attachedCount: 0, backgroundActive: false }),
    terminalCount: () => 0,
    stopUnlessBusy: () => Promise.resolve(true),
    maintenance: () => undefined,
    sweepOrphans: () => {
      sweeps += 1;
      return held;
    },
  } as unknown as BoxManager;

  vi.useFakeTimers();
  const cfg = loadConfig({ DATA_DIR: dir, IDLE_STOP_MINUTES: String(IDLE_MINUTES) });
  const reaper = startReaper(db, cfg, manager);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(sweeps, 1);

  // The first tick is still in its sweep three intervals later.
  await vi.advanceTimersByTimeAsync(180_000);
  assert.equal(sweeps, 1);

  finish();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(sweeps, 2);
  reaper.stop();
});

test("a box that is not running is not the reaper's to stop", async () => {
  insertBox('s1', IDLE_MINUTES + 1);
  db.prepare("UPDATE boxes SET status = 'stopped' WHERE id = 's1'").run();
  assert.deepEqual(await tick(), []);
});

test('a box something else is already working on is left for the next tick', async () => {
  // Starting a box, replacing its container or deleting it all hold the
  // queue of the box. The reaper never waits on the queue. It skips the box
  // and checks it again a minute later.
  insertBox('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ busy: new Set(['s1']) }), []);
});
