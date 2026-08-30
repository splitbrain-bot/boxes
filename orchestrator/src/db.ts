import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStatus } from '../../shared/types.ts';

/**
 * SQLite persistence in WAL mode. The database holds session metadata only:
 * Docker is the runtime truth, and thread replay belongs to the adapter.
 */

/** A row of the sessions table. */
export interface SessionRow {
  id: string;
  name: string;
  profile: string;
  image: string;
  /** JSON array of argv for the ACP adapter. */
  agent_cmd: string;
  container_id: string | null;
  network_name: string;
  subnet: string;
  ws_volume: string;
  home_volume: string;
  status: SessionStatus;
  /** The thread the gateway answers `session/new` with, or null before one exists. */
  current_thread_id: string | null;
  turn_active: number;
  created_at: number;
  last_active_at: number;
}

/**
 * One conversation of a session, as stored.
 *
 * `acp_session_id` is the adapter's own id for it, and is null while the row
 * exists but the adapter has forgotten the thread — a thread minted and never
 * prompted does not survive the adapter restarting.
 */
export interface ThreadRow {
  id: string;
  session_id: string;
  acp_session_id: string | null;
  /** The title the agent SDK generates, once a turn has produced one. */
  title: string | null;
  /** Per session and never reused; what an untitled thread is called. */
  ordinal: number;
  created_at: number;
  last_active_at: number;
}

/** One finished local command, as stored. */
export interface ExecRow {
  id: number;
  session_id: string;
  command: string;
  output: string;
  exit_code: number | null;
  truncated: number;
  timed_out: number;
  started_at: number;
  finished_at: number;
}

/** A permission request the adapter is still blocked on. */
export interface PendingRequestRow {
  id: number;
  session_id: string;
  upstream_id: string;
  method: string;
  params: string;
  created_at: number;
}

/**
 * Schema migrations, applied in order and tracked by user_version.
 *
 * Exported so a test can build a database at an earlier version and watch the
 * next migration move its data.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    profile        TEXT NOT NULL DEFAULT 'DEFAULT',
    repo_url       TEXT,
    image          TEXT NOT NULL,
    agent_cmd      TEXT NOT NULL,
    container_id   TEXT,
    network_name   TEXT NOT NULL,
    subnet         TEXT NOT NULL,
    ws_volume      TEXT NOT NULL,
    home_volume    TEXT NOT NULL,
    status         TEXT NOT NULL,
    acp_session_id TEXT,
    turn_active    INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE TABLE pending_requests (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL,
    upstream_id TEXT NOT NULL, method TEXT NOT NULL,
    params TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE acp_log (
    id INTEGER PRIMARY KEY, session_id TEXT, direction TEXT,
    ts INTEGER, payload TEXT
  );
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE INDEX idx_pending_session ON pending_requests(session_id);
  CREATE INDEX idx_acp_log_session ON acp_log(session_id, id);
  `,
  `
  CREATE TABLE exec_log (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL,
    command     TEXT NOT NULL,
    output      TEXT NOT NULL,
    exit_code   INTEGER,
    truncated   INTEGER NOT NULL DEFAULT 0,
    timed_out   INTEGER NOT NULL DEFAULT 0,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER NOT NULL
  );
  CREATE INDEX idx_exec_log_session ON exec_log(session_id, id);
  `,
  `
  ALTER TABLE sessions DROP COLUMN repo_url;
  `,
  // A session owns several threads. The single acp_session_id column becomes
  // one row per thread, and the session points at the one that is current.
  `
  CREATE TABLE threads (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    acp_session_id TEXT,
    title          TEXT,
    ordinal        INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE INDEX idx_threads_session ON threads(session_id, ordinal);
  ALTER TABLE sessions ADD COLUMN current_thread_id TEXT;

  INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
                       created_at, last_active_at)
    SELECT 't' || id, id, acp_session_id, NULL, 1, created_at, last_active_at
      FROM sessions WHERE acp_session_id IS NOT NULL;
  UPDATE sessions SET current_thread_id = 't' || id
    WHERE acp_session_id IS NOT NULL;

  ALTER TABLE sessions DROP COLUMN acp_session_id;
  `,
];

/** An open database handle. */
export type Db = Database.Database;

/** Opens boxes.db under dataDir, creating and migrating it as needed. */
export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'boxes.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Runs every migration the database has not applied yet, one per transaction. */
function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Returns the next value of the subnet counter, incrementing it in place. */
export function nextSubnetIndex(db: Db): number {
  const row = db
    .prepare(
      `INSERT INTO counters (name, value) VALUES ('subnet', 0)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get() as { value: number } | undefined;
  return row?.value ?? 0;
}

/** Debug log rows kept per session. */
const LOG_RING = 5000;

/** Records one tapped ACP message, truncating the payload at 64,000 characters. */
export function appendAcpLog(
  db: Db,
  sessionId: string,
  direction: 'up' | 'down' | 'stderr',
  payload: string,
): void {
  db.prepare(
    'INSERT INTO acp_log (session_id, direction, ts, payload) VALUES (?, ?, ?, ?)',
  ).run(sessionId, direction, Date.now(), payload.slice(0, 64_000));
}

/** Drops all but the newest LOG_RING debug log entries of one session. */
export function pruneAcpLog(db: Db, sessionId: string): void {
  db.prepare(
    `DELETE FROM acp_log
     WHERE session_id = ?
       AND id <= COALESCE(
         (SELECT id FROM acp_log WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?),
         -1)`,
  ).run(sessionId, sessionId, LOG_RING);
}

/** Local command runs kept per session. */
const EXEC_RING = 200;

/** Records one finished local command and returns its stored row id. */
export function appendExecLog(
  db: Db,
  sessionId: string,
  record: Omit<ExecRow, 'id' | 'session_id'>,
): number {
  const info = db
    .prepare(
      `INSERT INTO exec_log
         (session_id, command, output, exit_code, truncated, timed_out, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      record.command,
      record.output,
      record.exit_code,
      record.truncated,
      record.timed_out,
      record.started_at,
      record.finished_at,
    );
  db.prepare(
    `DELETE FROM exec_log
     WHERE session_id = ?
       AND id <= COALESCE(
         (SELECT id FROM exec_log WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?),
         -1)`,
  ).run(sessionId, sessionId, EXEC_RING);
  return Number(info.lastInsertRowid);
}

/** Every stored command run for one session, oldest first. */
export function listExecLog(db: Db, sessionId: string): ExecRow[] {
  return db
    .prepare('SELECT * FROM exec_log WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId) as ExecRow[];
}

// --- threads ----------------------------------------------------------------

/** Every thread of a session, oldest first. */
export function listThreads(db: Db, sessionId: string): ThreadRow[] {
  return db
    .prepare('SELECT * FROM threads WHERE session_id = ? ORDER BY ordinal ASC')
    .all(sessionId) as ThreadRow[];
}

/** One thread by id, whichever session it belongs to. */
export function getThread(db: Db, threadId: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as
    | ThreadRow
    | undefined;
}

/** The thread a session's gateway is currently answering for, or undefined. */
export function currentThread(db: Db, sessionId: string): ThreadRow | undefined {
  return db
    .prepare(
      `SELECT t.* FROM threads t
         JOIN sessions s ON s.current_thread_id = t.id
        WHERE s.id = ?`,
    )
    .get(sessionId) as ThreadRow | undefined;
}

/**
 * Inserts a thread and makes it the session's current one.
 *
 * The ordinal is one past the highest the session has ever used, so a name
 * like "Thread 2" stays that thread's for good.
 */
export function insertThread(
  db: Db,
  sessionId: string,
  acpSessionId: string | null,
): ThreadRow {
  const now = Date.now();
  const id = `t${randomBytes(6).toString('hex')}`;
  const next = db
    .prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM threads WHERE session_id = ?')
    .get(sessionId) as { n: number };
  const row: ThreadRow = {
    id,
    session_id: sessionId,
    acp_session_id: acpSessionId,
    title: null,
    ordinal: next.n,
    created_at: now,
    last_active_at: now,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
         created_at, last_active_at)
       VALUES (@id, @session_id, @acp_session_id, @title, @ordinal,
         @created_at, @last_active_at)`,
    ).run(row);
    db.prepare('UPDATE sessions SET current_thread_id = ? WHERE id = ?').run(id, sessionId);
  })();
  return row;
}

/** Records the adapter's own id for a thread, or clears it. */
export function setThreadAcpId(db: Db, threadId: string, acpSessionId: string | null): void {
  db.prepare('UPDATE threads SET acp_session_id = ? WHERE id = ?').run(
    acpSessionId,
    threadId,
  );
}

/** Records the title the agent generated for a thread, or clears it. */
export function setThreadTitle(db: Db, threadId: string, title: string | null): void {
  db.prepare('UPDATE threads SET title = ?, last_active_at = ? WHERE id = ?').run(
    title,
    Date.now(),
    threadId,
  );
}

/** Marks a thread active now, alongside its session. */
export function touchThread(db: Db, threadId: string): void {
  db.prepare('UPDATE threads SET last_active_at = ? WHERE id = ?').run(Date.now(), threadId);
}
