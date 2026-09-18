import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { openDb, type Db } from './db.ts';
import { startReaper } from './reaper.ts';
import type { SessionManager } from './sessions.ts';

/**
 * What the idle reaper leaves alone.
 *
 * Every condition here is a different answer to "is anybody or anything still
 * using this box", and each is the only thing standing between a session and
 * being stopped under whoever is using it. They are asserted one at a time,
 * because a reaper that honoured four of the five would look healthy in a
 * suite that only ever set up one.
 */

/** How long a session must be quiet before the reaper stops it. */
const IDLE_MINUTES = 30;

let dir: string;
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

/** A running session row, quiet for `idleMinutes`. */
function insertSession(id: string, idleMinutes: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
       status, current_thread_id, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', ?,
       ?, '10.200.0.0/24', '', ?, ?, ?, 'running', NULL, ?, ?)`,
  ).run(
    id,
    `c-${id}`,
    `sn-${id}`,
    `home-${id}`,
    `${dir}/workspaces/${id}`,
    `${dir}/homes/${id}`,
    now - idleMinutes * 60_000,
    now - idleMinutes * 60_000,
  );
}

/** One of a session's threads, with or without a turn running on it. */
function insertThread(id: string, sessionId: string, turnActive = false): void {
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       turn_active, created_at, last_active_at)
     VALUES (?, ?, ?, NULL, 1, ?, 1000, 2000)`,
  ).run(id, sessionId, `acp-${id}`, turnActive ? 1 : 0);
}

/** What one tick of the reaper did, over a manager that answers as told. */
async function tick(
  over: {
    pending?: number;
    attachedCount?: number;
    /** Null is a box whose work has not been read yet. */
    backgroundActive?: boolean | null;
    /** Run as each session is stopped, for what a slow stop lets happen. */
    onStop?: (id: string) => void;
    /** The count asked for again just before a session is stopped. */
    pendingNow?: (id: string) => number;
    /** Sessions with an operation of their own in flight, which never wait. */
    busy?: Set<string>;
  } = {},
): Promise<string[]> {
  const stopped: string[] = [];
  const manager = {
    pending: {
      countsBySession: () => new Map(over.pending ? [['s1', over.pending]] : []),
      countForSession: (id: string) =>
        over.pendingNow?.(id) ?? (id === 's1' ? (over.pending ?? 0) : 0),
    },
    upstream: () => ({
      attachedCount: over.attachedCount ?? 0,
      backgroundActive: over.backgroundActive === undefined ? false : over.backgroundActive,
    }),
    stopUnlessBusy: (id: string) => {
      if (over.busy?.has(id)) return Promise.resolve(false);
      stopped.push(id);
      over.onStop?.(id);
      return Promise.resolve(true);
    },
    maintenance: () => undefined,
    sweepOrphans: () => Promise.resolve(),
  } as unknown as SessionManager;

  vi.useFakeTimers();
  const cfg = loadConfig({ DATA_DIR: dir, IDLE_STOP_MINUTES: String(IDLE_MINUTES) });
  const reaper = startReaper(db, cfg, manager);
  await vi.advanceTimersByTimeAsync(60_000);
  reaper.stop();
  return stopped;
}

test('a session quiet for longer than the idle limit is stopped', async () => {
  insertSession('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick(), ['s1']);
});

test('a session quiet for less than the idle limit is left running', async () => {
  insertSession('s1', IDLE_MINUTES / 2);
  assert.deepEqual(await tick(), []);
});

test("a turn running on any of a session's threads holds the box", async () => {
  insertSession('s1', IDLE_MINUTES + 1);
  insertThread('t1', 's1');
  insertThread('t2', 's1', true);
  assert.deepEqual(await tick(), []);
});

test('a permission request waiting for an answer holds the box', async () => {
  insertSession('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ pending: 1 }), []);
});

test('a browser still attached holds the box', async () => {
  insertSession('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ attachedCount: 1 }), []);
});

test('work left running in the background holds the box', async () => {
  insertSession('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ backgroundActive: true }), []);
});

test('a box whose work has not been read yet is held for this tick', async () => {
  // The state after every restart: the probe has not answered, and a box
  // with a build in it and nobody watching looks exactly like an idle one.
  // The reading lands well before the next sweep.
  insertSession('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ backgroundActive: null }), []);
});

test('a turn that starts while another box is being stopped holds its own box', async () => {
  // The counts the tick opens with are one reading of the whole deployment,
  // and stopping a box takes seconds. By the time a sweep of many idle boxes
  // reaches the last of them, a prompt sent meanwhile is minutes old.
  insertSession('s1', IDLE_MINUTES + 1);
  insertSession('s2', IDLE_MINUTES + 1);
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
  // The same window as the turn above: the question is asked while the first
  // box is being stopped, and only a fresh count can see it.
  insertSession('s1', IDLE_MINUTES + 1);
  insertSession('s2', IDLE_MINUTES + 1);
  let asked = false;
  const stopped = await tick({
    onStop: () => {
      asked = true;
    },
    pendingNow: (id) => (asked && id === 's2' ? 1 : 0),
  });
  assert.deepEqual(stopped, ['s1']);
});

test('a tick still running when the next one is due is not joined by it', async () => {
  // Every tick re-asserts the same thing, and stopping many boxes takes
  // longer than the interval. Two of them at once sweep each other's
  // half-finished work.
  insertSession('s1', IDLE_MINUTES + 1);
  let sweeps = 0;
  let finish: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const manager = {
    pending: {
      countsBySession: () => new Map<string, number>(),
      countForSession: () => 0,
    },
    upstream: () => ({ attachedCount: 0, backgroundActive: false }),
    stopUnlessBusy: () => Promise.resolve(true),
    maintenance: () => undefined,
    sweepOrphans: () => {
      sweeps += 1;
      return held;
    },
  } as unknown as SessionManager;

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

test("a session that is not running is not the reaper's to stop", async () => {
  insertSession('s1', IDLE_MINUTES + 1);
  db.prepare("UPDATE sessions SET status = 'stopped' WHERE id = 's1'").run();
  assert.deepEqual(await tick(), []);
});

test('a session something else is already working on is left for the next tick', async () => {
  // Starting a box, replacing its container or deleting it all hold the
  // session's own queue. The reaper never waits on that: the session is
  // skipped and looked at again a minute later.
  insertSession('s1', IDLE_MINUTES + 1);
  assert.deepEqual(await tick({ busy: new Set(['s1']) }), []);
});
