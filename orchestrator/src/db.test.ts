import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDb, type Db } from './db.ts';

/**
 * The migration that turns one thread per session into several.
 *
 * A deployment upgrading in place has live sessions whose conversation is a
 * single `sessions.acp_session_id`, and that conversation has to survive as
 * the session's first thread.
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
