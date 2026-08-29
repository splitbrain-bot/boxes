import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStatus } from '../../shared/types.ts';

/**
 * SQLite persistence (plan §7). WAL mode; the DB holds metadata only —
 * Docker is runtime truth (plan §8.2) and thread replay is the adapter's job
 * (plan §2), so there is deliberately no replay table here.
 */

export interface SessionRow {
  id: string;
  name: string;
  profile: string;
  repo_url: string | null;
  image: string;
  /** JSON array of argv for the ACP adapter. */
  agent_cmd: string;
  container_id: string | null;
  network_name: string;
  subnet: string;
  ws_volume: string;
  home_volume: string;
  status: SessionStatus;
  acp_session_id: string | null;
  turn_active: number;
  created_at: number;
  last_active_at: number;
}

export interface PendingRequestRow {
  id: number;
  session_id: string;
  upstream_id: string;
  method: string;
  params: string;
  created_at: number;
}

const MIGRATIONS: string[] = [
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
];

export type Db = Database.Database;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'boxes.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

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

/**
 * Allocates the next per-session /24 out of SESSION_SUBNET_POOL. Docker
 * requires non-overlapping subnets; nothing filters on these anymore since
 * the proxy vets resolved IPs instead (plan §8.4).
 */
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

/** Ring-prune the debug tap to the newest 5,000 rows per session (plan §7). */
const LOG_RING = 5000;

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

export function pruneAcpLog(db: Db, sessionId: string): void {
  db.prepare(
    `DELETE FROM acp_log
     WHERE session_id = ?
       AND id <= COALESCE(
         (SELECT id FROM acp_log WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?),
         -1)`,
  ).run(sessionId, sessionId, LOG_RING);
}
