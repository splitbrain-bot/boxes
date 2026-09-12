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
  upsertHarnessCatalog,
  type Db,
} from './db.ts';

/**
 * The migrations that moved a session's conversation onto its threads.
 *
 * A deployment upgrading in place has live sessions whose conversation is a
 * single `sessions.acp_session_id`, and that conversation has to survive as
 * the session's first thread. What was session-wide about a running turn then
 * moves onto the thread it is about.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Builds a database at the version just before threads existed. */
function atVersion3(withAcpSessionId: string | null): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
  db.pragma('user_version = 3');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, acp_session_id,
       turn_active, created_at, last_active_at)
     VALUES ('s1', 'old session', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', ?, 0, 1000, 2000)`,
  ).run(withAcpSessionId);
  db.close();
}

/** The columns a table has, by name. */
function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

test('an existing conversation becomes the session first thread', () => {
  atVersion3('acp-abc');
  const db = openDb(dir);
  try {
    const threads = db.prepare('SELECT * FROM threads').all() as Array<Record<string, unknown>>;
    assert.equal(threads.length, 1);
    assert.equal(threads[0]!['session_id'], 's1');
    assert.equal(threads[0]!['acp_session_id'], 'acp-abc');
    assert.equal(threads[0]!['ordinal'], 1);
    // The session's own timestamps carry over: the thread is that session's
    // conversation, not a new one made today.
    assert.equal(threads[0]!['created_at'], 1000);
    assert.equal(threads[0]!['last_active_at'], 2000);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
      string,
      unknown
    >;
    assert.equal(session['current_thread_id'], threads[0]!['id']);
    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(db, 'sessions').includes('acp_session_id'));
  } finally {
    db.close();
  }
});

test('a session that never had a conversation gets no thread', () => {
  atVersion3(null);
  const db = openDb(dir);
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    assert.equal(count.n, 0);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
      string,
      unknown
    >;
    // The orchestrator mints one on the next spawn, exactly as it did before.
    assert.equal(session['current_thread_id'], null);
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
     VALUES ('s1', 'busy session', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', 't1', ?, 1000, 2000)`,
  ).run(turnActive);
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 's1', 'acp-abc', NULL, 1, 1000, 2000)`,
  ).run();
  db.close();
}

test('a running turn moves onto the threads, starting cleared', () => {
  // Mid-turn when the orchestrator went down, which is the state the upgrade
  // actually meets.
  atVersion4(1);
  const db = openDb(dir);
  try {
    // Not a loss of state but the truth: a turn cannot survive the restart
    // that applies the migration, so every thread starts at 0.
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get('t1') as Record<
      string,
      unknown
    >;
    assert.equal(thread['turn_active'], 0);
    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(db, 'sessions').includes('turn_active'));
    // And the thread's conversation and identity are untouched by the move.
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
     VALUES ('s1', 'volume session', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.close();
}

test('a volume-backed session keeps its volume and gains no directory', () => {
  atVersion5();
  const db = openDb(dir);
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
      string,
      unknown
    >;
    // Nothing is moved by the migration itself: the files are in a named
    // volume this process has no path to, and only a start can recreate the
    // container with the new mount.
    assert.equal(session['ws_volume'], 'ws-s1');
    assert.equal(session['workspace_dir'], null);
    assert.ok(columns(db, 'sessions').includes('workspace_dir'));
  } finally {
    db.close();
  }
});

/**
 * A deployment already running the push-notification release, upgrading to
 * this one.
 *
 * The two features were built on separate branches and both added a migration
 * at the same index. Whichever shipped first has to keep its index, or a
 * database that already applied it skips it and runs the wrong statement in
 * its place — so this asserts the order rather than trusting the merge that
 * chose it.
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
       'sn-live', '10.200.0.0/24', 'ws-live', 'home-live', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label,
       created_at, last_used_at)
     VALUES ('https://push.example/x', 'key', 'auth', 'phone', 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    const sessions = columns(upgraded, 'sessions');
    assert.ok(sessions.includes('workspace_dir'));
    // The review's base revision survives as the expression it always was.
    assert.ok(sessions.includes('review_base_rev'));
    // Its root and its resolved commit do not: the review is over the whole
    // workspace now, and one expression resolves separately in every
    // repository the workspace holds, so neither can mean anything.
    assert.ok(!sessions.includes('review_root'));
    assert.ok(!sessions.includes('review_base_commit'));

    // The migration that shipped first kept its index, so what it created is
    // still there and still holds its rows.
    assert.ok(columns(upgraded, 'push_subscriptions').includes('endpoint'));
    const push = upgraded
      .prepare('SELECT COUNT(*) AS n FROM push_subscriptions')
      .get() as { n: number };
    assert.equal(push.n, 1);

    // And the session that predates workspace directories is untouched: it
    // migrates at its next start, not here.
    const row = upgraded
      .prepare("SELECT ws_volume, workspace_dir FROM sessions WHERE id = 'live'")
      .get() as { ws_volume: string; workspace_dir: string | null };
    assert.deepEqual(row, { ws_volume: 'ws-live', workspace_dir: null });
  } finally {
    upgraded.close();
  }
});

test('threads from before the mode column upgrade to the deployment default', () => {
  const db = new Database(join(dir, 'boxes.db'));
  // The version just before the migration that adds the two columns, named
  // rather than derived from the length: a migration appended later must not
  // silently move this case onto itself.
  for (const sql of MIGRATIONS.slice(0, 10)) db.exec(sql);
  db.pragma('user_version = 10');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before modes were kept', 'DEFAULT', 'img', '[]', 'c1',
       'sn-live', '10.200.0.0/24', '', 'home-live', 'running', 't1', 1000, 2000)`,
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

    // No backfill, because null already says the right thing: this thread is
    // in whatever its harness starts one in. Nothing has to guess what a
    // conversation from before the column was in.
    //
    // The model column is gone by the time every migration has run — it is one
    // entry of the config map now — and a thread that never had one comes out
    // with an empty map rather than a guess.
    const row = upgraded
      .prepare("SELECT mode_id, config FROM threads WHERE id = 't1'")
      .get() as { mode_id: string | null; config: string };
    assert.deepEqual(row, { mode_id: null, config: '{}' });
  } finally {
    upgraded.close();
  }
});

test('the agent tables arrive with a global set, and existing sessions select none', () => {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 8)) db.exec(sql);
  db.pragma('user_version = 8');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before agent sets', 'DEFAULT', 'img', '[]', 'c1',
       'sn-live', '10.200.0.0/24', '', 'home-live', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    // Seeded by the migration rather than created on demand: a deployment has
    // exactly one always-applied set from the moment it has any.
    const sets = upgraded.prepare('SELECT id, name FROM agent_sets').all();
    assert.deepEqual(sets, [{ id: 'global', name: 'Global' }]);

    // A session that predates the feature gets the global set and nothing
    // else, which is what a null column means.
    assert.ok(columns(upgraded, 'sessions').includes('agent_set_id'));
    const row = upgraded
      .prepare("SELECT agent_set_id FROM sessions WHERE id = 'live'")
      .get() as { agent_set_id: string | null };
    assert.equal(row.agent_set_id, null);
  } finally {
    upgraded.close();
  }
});

test('the exec log gains a thread, and its session-wide rows are dropped', () => {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 14)) db.exec(sql);
  db.pragma('user_version = 14');
  db.prepare(
    `INSERT INTO exec_log (session_id, command, output, exit_code, truncated,
       timed_out, started_at, finished_at)
     VALUES ('s1', 'git status', 'clean', 0, 0, 0, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    assert.ok(columns(upgraded, 'exec_log').includes('thread_id'));

    // The stored rows name no thread, and nothing can tell which of a
    // session's conversations each of them was typed in. Keeping them would
    // mean showing every one of them in every thread, which is the behaviour
    // the column is here to end.
    const count = upgraded.prepare('SELECT COUNT(*) AS n FROM exec_log').get() as { n: number };
    assert.equal(count.n, 0);
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
       'sn-live', '10.200.0.0/24', '', 'home-live', 'running', 't1', 1000, 2000)`,
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

    // No backfill and nothing to guess: a mark is the reader's, and one they
    // have never had the chance to set is not set.
    const row = upgraded.prepare("SELECT done FROM threads WHERE id = 't1'").get() as {
      done: number;
    };
    assert.equal(row.done, 0);
  } finally {
    upgraded.close();
  }
});

/**
 * A deployment at the version before credentials, harnesses and the config map
 * — the last state anybody can be in — with one live session and one thread
 * that was left on a model.
 */
function atVersion16(): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 16)) db.exec(sql);
  db.pragma('user_version = 16');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before credentials moved', 'DEFAULT', 'img',
       '["claude-agent-acp"]', 'c1',
       'sn-live', '10.200.0.0/24', '', 'home-live', 'running', 't1', 1000, 2000)`,
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
  atVersion16();

  const upgraded = openDb(dir);
  try {
    // Nothing is carried over from the environment, deliberately: a
    // deployment that had credentials in its .env enters them again on the
    // settings page, and the release notes say so.
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

    // And the session that predates them is untouched: its box gets a
    // placeholder for every credential at its next start, whatever is stored.
    const row = upgraded.prepare("SELECT name FROM sessions WHERE id = 'live'").get() as {
      name: string;
    };
    assert.equal(row.name, 'from before credentials moved');
  } finally {
    upgraded.close();
  }
});

test('a thread from before harnesses is Claude, on the model it was left on', () => {
  atVersion16();
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
      // And a thread nobody chose a model for gets an empty map rather than a
      // guess: it comes back on its harness's default, which is what an empty
      // column has always meant.
      { id: 't2', harness: 'claude', mode_id: null, config: '{}' },
    ]);
    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(upgraded, 'threads').includes('model_id'));

    // And the argv comes from the registry now: a box may need either adapter,
    // so the one a session was created with says nothing.
    assert.ok(!columns(upgraded, 'sessions').includes('agent_cmd'));

    // The catalogue arrives empty. Nothing fills it until an adapter has
    // answered for a thread — a dialog on a fresh deployment offers the agent
    // choice alone rather than starting a box to find out what it would offer.
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

    // An answer that carries only one of them says nothing about the other,
    // and emptying the half it did not mention would cost the dialog a list it
    // has no other way to get.
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
