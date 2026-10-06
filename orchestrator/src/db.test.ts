import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATIONS,
  openDb,
  readHarnessCatalog,
  touchBox,
  upsertHarnessCatalog,
  type Db,
} from './db.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds a database at the version just before threads existed. Its one box
 * holds its conversation in `acp_session_id`, or none when that is null.
 */
function atVersion3(withAcpSessionId: string | null): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
  db.pragma('user_version = 3');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, acp_session_id,
       turn_active, created_at, last_active_at)
     VALUES ('s1', 'old box', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'bn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', ?, 0, 1000, 2000)`,
  ).run(withAcpSessionId);
  db.close();
}

/** The columns a table has, by name. */
function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

test('an existing conversation becomes the box first thread', () => {
  atVersion3('acp-abc');
  const db = openDb(dir);
  try {
    const threads = db.prepare('SELECT * FROM threads').all() as Array<Record<string, unknown>>;
    assert.equal(threads.length, 1);
    assert.equal(threads[0]!['box_id'], 's1');
    assert.equal(threads[0]!['acp_session_id'], 'acp-abc');
    assert.equal(threads[0]!['ordinal'], 1);
    // The box's own timestamps carry over: the thread is that box's
    // conversation, not a new one made today.
    assert.equal(threads[0]!['created_at'], 1000);
    assert.equal(threads[0]!['last_active_at'], 2000);

    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(db, 'boxes').includes('acp_session_id'));
    // The migrations also drop current_thread_id.
    assert.ok(!columns(db, 'boxes').includes('current_thread_id'));
  } finally {
    db.close();
  }
});

test('a box that never had a conversation gets no thread', () => {
  atVersion3(null);
  const db = openDb(dir);
  try {
    // The orchestrator creates one on the next spawn.
    const count = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    db.close();
  }
});

/** Builds a database at the version just before turns moved onto threads. */
function atVersion4(turnActive: number): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 4)) db.exec(sql);
  db.pragma('user_version = 4');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       turn_active, created_at, last_active_at)
     VALUES ('s1', 'busy box', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'bn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', 't1', ?, 1000, 2000)`,
  ).run(turnActive);
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 's1', 'acp-abc', NULL, 1, 1000, 2000)`,
  ).run();
  db.close();
}

test('a running turn moves onto the threads, starting cleared', () => {
  // The orchestrator went down mid-turn, which is the state the upgrade meets.
  atVersion4(1);
  const db = openDb(dir);
  try {
    // A turn cannot survive the restart that applies the migration, so every
    // thread starts at 0.
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get('t1') as Record<
      string,
      unknown
    >;
    assert.equal(thread['turn_active'], 0);
    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(db, 'boxes').includes('turn_active'));
    // The thread's conversation and identity are untouched.
    assert.equal(thread['acp_session_id'], 'acp-abc');
    assert.equal(thread['ordinal'], 1);
  } finally {
    db.close();
  }
});

test('a queued permission request gains the thread that asked', () => {
  atVersion4(0);
  const db = openDb(dir);
  try {
    // Nullable and unbackfilled on purpose: clearStale drops every row left
    // by a previous process at boot, so no existing row outlives the change.
    assert.ok(columns(db, 'pending_requests').includes('acp_session_id'));
  } finally {
    db.close();
  }
});

/**
 * Builds a database at the version before push subscriptions, workspace
 * directories and the review columns — the last state a deployment could be in
 * without any of the three.
 */
function atVersion5(): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
  db.pragma('user_version = 5');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('s1', 'volume box', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'bn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.close();
}

test('a box from before workspace directories loses its volume columns', () => {
  atVersion5();
  const db = openDb(dir);
  try {
    // The row stays. Its directories are named by its id, so no column
    // records where they are.
    const box = db.prepare('SELECT name FROM boxes WHERE id = ?').get('s1') as {
      name: string;
    };
    assert.equal(box.name, 'volume box');
    for (const column of ['ws_volume', 'home_volume', 'workspace_dir', 'home_dir']) {
      assert.ok(!columns(db, 'boxes').includes(column), column);
    }
  } finally {
    db.close();
  }
});

/**
 * A deployment on the push-notification release, upgrading. Two migrations
 * were written for the same index. The one that shipped first must keep it,
 * or a database that applied it runs the wrong statement in its place.
 */
test('a deployment on the previous release upgrades cleanly', () => {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 6)) db.exec(sql);
  db.pragma('user_version = 6');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'on the old release', 'DEFAULT', 'img', '[]', 'c1',
       'bn-live', '10.200.0.0/24', 'ws-live', 'home-live', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label,
       created_at, last_used_at)
     VALUES ('https://push.example/x', 'key', 'auth', 'phone', 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    const boxes = columns(upgraded, 'boxes');
    // The review's base revision survives as the expression it always was.
    assert.ok(boxes.includes('review_base_rev'));
    // Its root and resolved commit are dropped. The review covers the whole
    // workspace, and one expression resolves separately in each repository.
    assert.ok(!boxes.includes('review_root'));
    assert.ok(!boxes.includes('review_base_commit'));

    // The migration that shipped first kept its index, so what it created is
    // still there and still holds its rows.
    assert.ok(columns(upgraded, 'push_subscriptions').includes('endpoint'));
    const push = upgraded
      .prepare('SELECT COUNT(*) AS n FROM push_subscriptions')
      .get() as { n: number };
    assert.equal(push.n, 1);
  } finally {
    upgraded.close();
  }
});

test('threads from before the mode column upgrade to the deployment default', () => {
  const db = new Database(join(dir, 'boxes.db'));
  // The schema as it stood before the migration that adds the two columns.
  const before = MIGRATIONS.findIndex((sql) => sql.includes('ADD COLUMN mode_id'));
  for (const sql of MIGRATIONS.slice(0, before)) db.exec(sql);
  db.pragma(`user_version = ${before}`);
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before modes were kept', 'DEFAULT', 'img', '[]', 'c1',
       'bn-live', '10.200.0.0/24', '', 'home-live', 'running', 't1', 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 'live', 'acp-1', NULL, 1, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    assert.ok(columns(upgraded, 'threads').includes('mode_id'));

    // No backfill: a null mode means the mode its harness starts a thread in.
    // A later migration moves the model into the config map, and a thread
    // without a model gets an empty map.
    const row = upgraded
      .prepare("SELECT mode_id, config FROM threads WHERE id = 't1'")
      .get() as { mode_id: string | null; config: string };
    assert.deepEqual(row, { mode_id: null, config: '{}' });
  } finally {
    upgraded.close();
  }
});

test('the agent tables arrive with a global set, and existing boxes select none', () => {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 8)) db.exec(sql);
  db.pragma('user_version = 8');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before agent sets', 'DEFAULT', 'img', '[]', 'c1',
       'bn-live', '10.200.0.0/24', '', 'home-live', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    // Seeded by the migration rather than created on demand: a deployment has
    // exactly one always-applied set from the moment it has any.
    const sets = upgraded.prepare('SELECT id, name FROM agent_sets').all();
    assert.deepEqual(sets, [{ id: 'global', name: 'Global' }]);

    // A box that predates the feature gets the global set and nothing
    // else, which is what a null column means.
    assert.ok(columns(upgraded, 'boxes').includes('agent_set_id'));
    const row = upgraded
      .prepare("SELECT agent_set_id FROM boxes WHERE id = 'live'")
      .get() as { agent_set_id: string | null };
    assert.equal(row.agent_set_id, null);
  } finally {
    upgraded.close();
  }
});

test('a database that has an exec log loses it', () => {
  // Nothing reads the exec log, so the upgrade drops the table.
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 16)) db.exec(sql);
  db.pragma('user_version = 16');
  db.prepare(
    `INSERT INTO exec_log (session_id, thread_id, command, output, exit_code, truncated,
       timed_out, started_at, finished_at)
     VALUES ('s1', 't1', 'git status', 'clean', 0, 0, 0, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    const table = upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exec_log'")
      .get();
    assert.equal(table, undefined);
  } finally {
    upgraded.close();
  }
});

test('threads from before the done column read as not done', () => {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 15)) db.exec(sql);
  db.pragma('user_version = 15');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before threads were marked', 'DEFAULT', 'img', '[]', 'c1',
       'bn-live', '10.200.0.0/24', '', 'home-live', 'running', 't1', 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 'live', 'acp-1', NULL, 1, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    assert.ok(columns(upgraded, 'threads').includes('done'));

    // The reader sets the mark, so a thread from before the column is not done.
    const row = upgraded.prepare("SELECT done FROM threads WHERE id = 't1'").get() as {
      done: number;
    };
    assert.equal(row.done, 0);
  } finally {
    upgraded.close();
  }
});


test('boxes from before the token column each get one of their own', () => {
  const before = MIGRATIONS.findIndex((sql) => sql.includes('ADD COLUMN ws_token'));
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, before)) db.exec(sql);
  db.pragma(`user_version = ${before}`);
  for (const id of ['s1', 's2']) {
    db.prepare(
      `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
         network_name, subnet, ws_volume, home_volume, status, created_at, last_active_at)
       VALUES (?, 'old box', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
         ?, '10.200.0.0/24', '', '', 'running', 1000, 2000)`,
    ).run(id, `bn-${id}`);
  }
  db.close();

  const upgraded = openDb(dir);
  try {
    // An existing box stays reachable, so it needs a token now rather than at
    // its next start.
    const rows = upgraded
      .prepare('SELECT id, ws_token FROM boxes ORDER BY id')
      .all() as Array<{ id: string; ws_token: string }>;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.match(row.ws_token, /^[0-9a-f]{64}$/);
    // One each, so a leaked token cannot open another box.
    assert.notEqual(rows[0]!.ws_token, rows[1]!.ws_token);
  } finally {
    upgraded.close();
  }
});

test('a database written by a newer build is refused rather than opened', () => {
  // After a rollback, the queries of this build name columns a later
  // migration changed. Refusing at boot beats failing at the first request.
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS) db.exec(sql);
  db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
  db.close();

  assert.throws(() => openDb(dir), {
    message: new RegExp(`version ${MIGRATIONS.length + 1}.*knows ${MIGRATIONS.length}`, 's'),
  });
});

/** A live box row, in the shape today's schema wants. */
function insertLiveBox(db: Db, id: string): void {
  db.prepare(
    `INSERT INTO boxes (id, name, profile, image, container_id,
       network_name, subnet, status, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', 'c1',
       ?, '10.200.0.0/24', 'running', 1000, 2000)`,
  ).run(id, `bn-${id}`);
}

test('a deleted box takes no more writes', () => {
  // Deleting sets the tombstone before it clears the tables. Work still in
  // flight, such as an upstream that is settling, must not touch the row.
  const db = openDb(dir);
  insertLiveBox(db, 's1');

  db.prepare("UPDATE boxes SET status = 'deleted' WHERE id = 's1'").run();
  touchBox(db, 's1');

  const row = db.prepare('SELECT last_active_at FROM boxes WHERE id = ?').get('s1') as {
    last_active_at: number;
  };
  assert.equal(row.last_active_at, 2000);
  db.close();
});

/**
 * Builds a database at the version before credentials, harnesses and the
 * config map, with one live box, one thread left on a model and one without.
 */
function atLastRelease(): void {
  const db = new Database(join(dir, 'boxes.db'));
  const before = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE credentials'));
  for (const sql of MIGRATIONS.slice(0, before)) db.exec(sql);
  db.pragma(`user_version = ${before}`);
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before credentials moved', 'DEFAULT', 'img',
       '["claude-agent-acp"]', 'c1',
       'bn-live', '10.200.0.0/24', '', 'home-live', 'running', 't1', 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       mode_id, model_id, created_at, last_active_at)
     VALUES ('t1', 'live', 'acp-1', NULL, 1, 'plan', 'opus', 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       mode_id, model_id, created_at, last_active_at)
     VALUES ('t2', 'live', 'acp-2', NULL, 2, NULL, NULL, 1000, 2000)`,
  ).run();
  db.close();
}

test('the credential and settings tables arrive empty on an existing deployment', () => {
  atLastRelease();

  const upgraded = openDb(dir);
  try {
    // Nothing is carried over from the environment. A deployment that had
    // credentials in its .env enters them again on the settings page.
    const credentials = upgraded
      .prepare('SELECT COUNT(*) AS n FROM credentials')
      .get() as { n: number };
    assert.equal(credentials.n, 0);
    const settings = upgraded.prepare('SELECT COUNT(*) AS n FROM settings').get() as {
      n: number;
    };
    assert.equal(settings.n, 0);

    assert.deepEqual(columns(upgraded, 'settings'), ['key', 'value', 'updated_at']);
    assert.deepEqual(columns(upgraded, 'credentials'), [
      'id',
      'method',
      'secret',
      'account',
      'expires_at',
      'refreshed_at',
      'status',
      'last_error',
      'created_at',
      'updated_at',
    ]);

    // The box is untouched. It gets a placeholder for every credential at its
    // next start, whatever is stored.
    const row = upgraded.prepare("SELECT name FROM boxes WHERE id = 'live'").get() as {
      name: string;
    };
    assert.equal(row.name, 'from before credentials moved');
  } finally {
    upgraded.close();
  }
});

test('a thread from before harnesses is Claude, on the model it was left on', () => {
  atLastRelease();
  const upgraded = openDb(dir);
  try {
    // Every thread there has ever been is Claude's, which is what the column
    // default says without a backfill.
    const threads = upgraded
      .prepare('SELECT id, harness, mode_id, config FROM threads ORDER BY ordinal')
      .all() as Array<{ id: string; harness: string; mode_id: string | null; config: string }>;
    assert.deepEqual(threads, [
      // The model becomes one entry of the config map, keeping the meaning it
      // had: both adapters call that option `model`. The mode is untouched —
      // it stays its own column, because ACP treats a mode as its own concept.
      { id: 't1', harness: 'claude', mode_id: 'plan', config: '{"model":"opus"}' },
      // A thread without a model gets an empty map and comes back on its
      // harness's default.
      { id: 't2', harness: 'claude', mode_id: null, config: '{}' },
    ]);
    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(upgraded, 'threads').includes('model_id'));

    // The argv comes from the harness registry, because a box may need
    // either adapter.
    assert.ok(!columns(upgraded, 'boxes').includes('agent_cmd'));

    // The catalogue arrives empty. An adapter fills it when it answers for a
    // thread. Until then, a dialog offers only the choice of agent.
    assert.deepEqual(columns(upgraded, 'harness_catalog'), [
      'harness',
      'modes',
      'config_options',
      'seen_at',
    ]);
    const cached = upgraded
      .prepare('SELECT COUNT(*) AS n FROM harness_catalog')
      .get() as { n: number };
    assert.equal(cached.n, 0);
  } finally {
    upgraded.close();
  }
});

test('the catalogue keeps the half an answer says nothing about', () => {
  const db = openDb(dir);
  try {
    // A `session/new` answer carries both lists, which is what a dialog with
    // no adapter to ask reads.
    upsertHarnessCatalog(
      db,
      'claude',
      { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'plan' }] },
      [{ id: 'model', category: 'model', currentValue: 'opus' }],
    );
    assert.deepEqual(readHarnessCatalog(db, 'claude'), {
      modes: { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'plan' }] },
      configOptions: [{ id: 'model', category: 'model', currentValue: 'opus' }],
      seenAt: readHarnessCatalog(db, 'claude')!.seenAt,
    });

    // An answer with only one list leaves the other in place. The dialog has
    // no other way to get it.
    upsertHarnessCatalog(db, 'claude', null, [
      { id: 'model', category: 'model', currentValue: 'sonnet' },
    ]);
    const after = readHarnessCatalog(db, 'claude');
    assert.equal(after?.modes?.currentModeId, 'auto');
    assert.deepEqual(after?.configOptions, [
      { id: 'model', category: 'model', currentValue: 'sonnet' },
    ]);

    // A harness no adapter has ever answered for has no cache, which is what
    // a fresh deployment's dialog is built against.
    assert.equal(readHarnessCatalog(db, 'codex'), null);
  } finally {
    db.close();
  }
});
