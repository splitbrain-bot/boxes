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
  /**
   * The named volume that used to hold the workspace, and still does for a
   * session created before workspaces became directories. Empty on a session
   * that is directory-backed, which every new one is.
   */
  ws_volume: string;
  home_volume: string;
  /**
   * Where the session's files are, as this process saw them when the session
   * was created or migrated, and null while the session is still
   * volume-backed. The path actually used is derived from the current
   * DATA_DIR, so moving the data volume moves the workspaces with it; what
   * this column decides is only whether the session has a directory at all.
   */
  workspace_dir: string | null;
  status: SessionStatus;
  /**
   * The thread a connection that names none gets, or null before one exists.
   * A default rather than the truth: a connection may pin itself to any of
   * the session's threads instead.
   */
  current_thread_id: string | null;
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
  /**
   * 1 while a prompt turn is running on this thread. The session's own
   * "a turn is running" is derived from its threads rather than stored
   * beside them, because two sources of truth for that is precisely the
   * thing that goes stale.
   */
  turn_active: number;
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
  /**
   * The ACP thread that asked, so a browser is given only the requests for
   * the thread it is watching. Null on a row from before the column existed,
   * which no live process can have: `clearStale` drops those at boot.
   */
  acp_session_id: string | null;
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
  // Threads run in parallel, so what was session-wide moves onto the thread
  // it is actually about. Nothing needs moving with it: a turn cannot survive
  // the restart that applies this, and pending_requests is cleared at every
  // boot, so every thread starting at 0 is not a loss of state but the truth.
  `
  ALTER TABLE threads ADD COLUMN turn_active INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_requests ADD COLUMN acp_session_id TEXT;
  ALTER TABLE sessions DROP COLUMN turn_active;
  `,
  // A workspace becomes a directory on the orchestrator's data volume,
  // bind-mounted into the session container, so the orchestrator can read the
  // agent's files without an exec. Nothing is moved here: an existing row
  // keeps its ws_volume and a null workspace_dir, and migrates at its next
  // start — which is the only moment its container can be recreated with the
  // new mount.
  `
  ALTER TABLE sessions ADD COLUMN workspace_dir TEXT;
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
    turn_active: 0,
    created_at: now,
    last_active_at: now,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
         turn_active, created_at, last_active_at)
       VALUES (@id, @session_id, @acp_session_id, @title, @ordinal,
         @turn_active, @created_at, @last_active_at)`,
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

/**
 * Records whether a prompt turn is running on the thread the adapter knows by
 * `acpSessionId`, and marks both it and its session active.
 *
 * Addressed by the adapter's own id because that is what a prompt's params
 * carry: the row is found by which conversation the turn is on, never by
 * which one happens to be the session's default.
 */
export function setThreadTurnActive(
  db: Db,
  sessionId: string,
  acpSessionId: string,
  active: boolean,
): void {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `UPDATE threads SET turn_active = ?, last_active_at = ?
        WHERE session_id = ? AND acp_session_id = ?`,
    ).run(active ? 1 : 0, now, sessionId, acpSessionId);
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(now, sessionId);
  })();
}

/**
 * Clears the running-turn flag on every thread of a session.
 *
 * What the callers have in common is that none of them leaves a turn running:
 * a deliberate stop, an adapter exit, a cancel, and boot reconciliation.
 */
export function clearSessionTurns(db: Db, sessionId: string): void {
  db.prepare('UPDATE threads SET turn_active = 0 WHERE session_id = ?').run(sessionId);
}

/** Whether any of a session's threads has a turn running. */
export function sessionTurnActive(db: Db, sessionId: string): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS hit FROM threads WHERE session_id = ? AND turn_active = 1 LIMIT 1',
    )
    .get(sessionId) as { hit: number } | undefined;
  return row !== undefined;
}

/** The session ids that have a turn running on any of their threads. */
export function sessionsWithActiveTurns(db: Db): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT session_id FROM threads WHERE turn_active = 1')
    .all() as Array<{ session_id: string }>;
  return new Set(rows.map((r) => r.session_id));
}
