import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HarnessCatalog,
  HarnessId,
  ThreadConfigOption,
  ThreadModeState,
  BoxStatus,
} from '../../shared/types.ts';

/**
 * SQLite persistence in WAL mode. The database holds box metadata only:
 * Docker holds the runtime state, and the adapter holds the transcripts.
 */

/** A row of the boxes table. */
export interface BoxRow {
  /** The server-generated box id. */
  id: string;
  /** The display name. */
  name: string;
  /** The credential profile. Every box is DEFAULT. */
  profile: string;
  /** The image the container was last created from. */
  image: string;
  /** The Docker container id, or null when there is no container. */
  container_id: string | null;
  /** The name of the box network. */
  network_name: string;
  /** The /24 subnet of the box network. */
  subnet: string;
  /**
   * The revision the review is compared against, as the user gave it, such as
   * a branch, a tag or a short id. Null means each repository's working tree.
   * Each repository in the workspace resolves it on its own, per request.
   */
  review_base_rev: string | null;
  /** The lifecycle state. A deleted box keeps its row as a tombstone. */
  status: BoxStatus;
  /**
   * The extra agent set this box was created with, or null for the global
   * set alone. Cleared by the database if that set is later deleted.
   */
  agent_set_id: string | null;
  /** The bearer token a WebSocket upgrade must present. It opens this box only. */
  ws_token: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last activity, read by the idle reaper. */
  last_active_at: number;
}

/** One conversation of a box, as stored. */
export interface ThreadRow {
  /** The thread id. */
  id: string;
  /** The box the thread belongs to. */
  box_id: string;
  /**
   * Which agent runs this conversation, by its harness id. It is per thread,
   * as one box may run both agents, and only the adapter that wrote a
   * transcript can load it.
   */
  harness: HarnessId;
  /**
   * The adapter's own id for the conversation, or null while the adapter has
   * none. A thread that was never prompted does not survive an adapter restart.
   */
  acp_session_id: string | null;
  /**
   * What the thread is called: the title the agent generates at the end of a
   * turn, or the first line of a prompt sent on it while it has none. Null on
   * a thread that has never been prompted.
   */
  title: string | null;
  /** Per box and never reused; what an untitled thread is called. */
  ordinal: number;
  /** 1 while a prompt turn is running on this thread, else 0. */
  turn_active: number;
  /**
   * The thread this one was forked from, until its first prompt. The adapter
   * writes a fork's transcript only then, so until then the replay comes from
   * the source thread.
   */
  inherits_from: string | null;
  /**
   * The mode this thread is meant to be in, or null for the deployment's
   * default. Stored here, as a respawned adapter loads the conversation back
   * without its mode.
   */
  mode_id: string | null;
  /**
   * The thread's other options, such as the model, as a JSON map of the
   * adapter's option id to its value. Stored for the same reason as the mode.
   * An option that echoes the mode is not stored here, so the two cannot
   * drift apart.
   */
  config: string;
  /**
   * 1 once the reader has marked this conversation finished with. It changes
   * only how the dashboard shows the thread.
   */
  done: number;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last activity. */
  last_active_at: number;
}

/** A permission request the adapter is still blocked on. */
export interface PendingRequestRow {
  /** The row id. */
  id: number;
  /** The box whose adapter asked. */
  box_id: string;
  /**
   * The ACP thread that asked, so a browser gets only the requests for the
   * thread it watches. Null only on old rows, which PendingStore.clearStale
   * drops at boot.
   */
  acp_session_id: string | null;
  /** The JSON-RPC method of the request. */
  method: string;
  /** The JSON-encoded request params. */
  params: string;
  /** Epoch milliseconds of arrival. */
  created_at: number;
}

/** One browser that has asked to be pushed to. */
export interface PushSubscriptionRow {
  /**
   * The push service's opaque URL for this subscription, and its key. The same
   * browser subscribing again gets the same endpoint.
   */
  endpoint: string;
  /** The subscriber's public key, uncompressed P-256, base64url. */
  p256dh: string;
  /** The subscriber's authentication secret, base64url. */
  auth: string;
  /** What the browser called itself when it registered; for the UI only. */
  label: string | null;
  /** Epoch milliseconds of the first registration. */
  created_at: number;
  /** Epoch milliseconds of the last successful push. */
  last_used_at: number;
  /**
   * The VAPID public key the subscription was made under, or null on an old
   * row. A push signed with another key is refused.
   */
  vapid_key: string | null;
}

/**
 * One named collection of agent configuration: an AGENTS.md, plus any number
 * of skills and slash commands.
 *
 * The `global` set, seeded by its migration, applies to every box. A box may
 * name one more set at creation, whose contents are merged over the global
 * ones.
 */
export interface AgentSetRow {
  /** The set id. */
  id: string;
  /** The display name. */
  name: string;
  /** This set's own AGENTS.md, or '' when it contributes none. */
  agents_md: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last change. */
  updated_at: number;
}

/** One skill or slash command belonging to an agent set. */
export interface AgentItemRow {
  /** The set the item belongs to. */
  set_id: string;
  /** Whether it is a skill or a slash command. */
  kind: 'skill' | 'command';
  /** A safe single path component. */
  name: string;
  /** The markdown content. */
  content: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last change. */
  updated_at: number;
}

/**
 * Schema migrations, applied in order and tracked by user_version. Exported,
 * so a test can build a database at an earlier version.
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
  // A box owns several threads. The single acp_session_id column becomes
  // one row per thread, and the box points at the one that is current.
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
  // Threads run in parallel, so the turn flag and pending requests move onto
  // the thread. No data moves: no turn survives the restart, and
  // pending_requests is cleared at every boot.
  `
  ALTER TABLE threads ADD COLUMN turn_active INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_requests ADD COLUMN acp_session_id TEXT;
  ALTER TABLE sessions DROP COLUMN turn_active;
  `,
  // Browsers subscribed to Web Push, keyed by the push service's endpoint.
  // It must stay at this index: deployments that applied it are at
  // user_version 6.
  `
  CREATE TABLE push_subscriptions (
    endpoint     TEXT PRIMARY KEY,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  `,
  // Workspaces become directories on the data volume. An existing box keeps
  // its ws_volume and moves at its next start, when its container is
  // recreated.
  `
  ALTER TABLE sessions ADD COLUMN workspace_dir TEXT;
  `,
  // What a review remembers between requests. The annotations live in
  // REVIEW.md in the workspace.
  `
  ALTER TABLE sessions ADD COLUMN review_root TEXT;
  ALTER TABLE sessions ADD COLUMN review_base_rev TEXT;
  ALTER TABLE sessions ADD COLUMN review_base_commit TEXT;
  `,
  // Agent sets: an AGENTS.md, skills and slash commands, managed from the
  // dashboard. The `global` set is seeded here. Deleting a set clears the
  // references of the boxes that named it.
  `
  CREATE TABLE agent_sets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    agents_md  TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE agent_items (
    set_id     TEXT NOT NULL REFERENCES agent_sets(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('skill', 'command')),
    name       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (set_id, kind, name)
  );
  INSERT INTO agent_sets (id, name, agents_md, created_at, updated_at)
    VALUES ('global', 'Global', '', 0, 0);
  ALTER TABLE sessions ADD COLUMN agent_set_id TEXT
    REFERENCES agent_sets(id) ON DELETE SET NULL;
  `,
  // The source of a fork, whose transcript stands in until the first prompt.
  `
  ALTER TABLE threads ADD COLUMN inherits_from TEXT;
  `,
  // The mode and model a thread is meant to be in, for an adapter respawn.
  // NULL means the deployment's default, so existing rows need no backfill.
  `
  ALTER TABLE threads ADD COLUMN mode_id TEXT;
  ALTER TABLE threads ADD COLUMN model_id TEXT;
  `,
  // Nothing reads pending_requests.upstream_id.
  `
  ALTER TABLE pending_requests DROP COLUMN upstream_id;
  `,
  // The review covers the whole workspace, and each repository resolves the
  // base itself, so neither a root nor a single commit is stored. An old
  // REVIEW.md in a subdirectory stays as an ordinary file.
  `
  ALTER TABLE sessions DROP COLUMN review_root;
  ALTER TABLE sessions DROP COLUMN review_base_commit;
  `,
  // Homes become directories on the data volume. Only new boxes get one; an
  // existing box keeps mounting its home_volume.
  `
  ALTER TABLE sessions ADD COLUMN home_dir TEXT;
  `,
  // A local command belongs to its thread. The stored rows name no thread,
  // so they are deleted.
  `
  DELETE FROM exec_log;
  ALTER TABLE exec_log ADD COLUMN thread_id TEXT;
  `,
  // Whether the reader is finished with a conversation.
  `
  ALTER TABLE threads ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
  `,
  // The id of the transcript entry a command was typed after, for replay.
  `
  ALTER TABLE exec_log ADD COLUMN after_id TEXT;
  `,
  // A WebSocket token per box. SQLite draws randomblob per row, so every
  // existing box gets its own token.
  `
  ALTER TABLE sessions ADD COLUMN ws_token TEXT NOT NULL DEFAULT '';
  UPDATE sessions SET ws_token = lower(hex(randomblob(32)));
  `,
  // ACP messages are logged to stderr, so acp_log has no reader or writer.
  `
  DROP INDEX IF EXISTS idx_acp_log_session;
  DROP TABLE IF EXISTS acp_log;
  `,
  // The VAPID key a browser subscribed under, so rows of another key can be
  // dropped. Existing rows get no key.
  `
  ALTER TABLE push_subscriptions ADD COLUMN vapid_key TEXT;
  `,
  // exec_log has no reader or writer.
  `
  DROP INDEX IF EXISTS idx_exec_log_session;
  DROP TABLE IF EXISTS exec_log;
  `,
  // Credentials and settings, managed from the settings page. The secret is
  // stored unencrypted, as the orchestrator must hand it to the proxy on every
  // boot. Also the harness of each thread and the harness catalogue.
  `
  CREATE TABLE credentials (
    id           TEXT PRIMARY KEY,
    method       TEXT NOT NULL,
    secret       TEXT NOT NULL,
    account      TEXT,
    expires_at   INTEGER,
    refreshed_at INTEGER,
    status       TEXT NOT NULL DEFAULT 'ok',
    last_error   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Which agent a thread runs, and its options beyond the mode. Existing
  -- threads are Claude's. Both adapters call the model option "model".
  ALTER TABLE threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE threads ADD COLUMN config  TEXT NOT NULL DEFAULT '{}';
  UPDATE threads SET config = json_object('model', model_id) WHERE model_id IS NOT NULL;
  ALTER TABLE threads DROP COLUMN model_id;

  -- The harness registry holds the adapter argv, so the box does not.
  ALTER TABLE sessions DROP COLUMN agent_cmd;

  -- What each adapter last advertised, for a dialog that has no thread to ask
  -- and must not start a box to find out.
  CREATE TABLE harness_catalog (
    harness        TEXT PRIMARY KEY,
    modes          TEXT NOT NULL,
    config_options TEXT NOT NULL,
    seen_at        INTEGER NOT NULL
  );
  `,
  // Sessions become boxes, so the name does not collide with ACP sessions.
  // `acp_session_id` keeps its name, as it holds the adapter's own id.
  `
  ALTER TABLE sessions RENAME TO boxes;
  ALTER TABLE threads RENAME COLUMN session_id TO box_id;
  ALTER TABLE pending_requests RENAME COLUMN session_id TO box_id;
  DROP INDEX IF EXISTS idx_pending_session;
  DROP INDEX IF EXISTS idx_threads_session;
  CREATE INDEX idx_pending_box ON pending_requests(box_id);
  CREATE INDEX idx_threads_box ON threads(box_id, ordinal);
  `,
  // A caller naming no thread gets the most recently active one.
  `
  ALTER TABLE boxes DROP COLUMN current_thread_id;
  `,
  // The dev tunnels boxes have hosted, so that the orchestrator can delete
  // the ones nobody hosts any more. A row outlives its box on purpose.
  `
  CREATE TABLE tunnels (
    id             TEXT PRIMARY KEY,
    cluster        TEXT NOT NULL,
    box_id         TEXT NOT NULL,
    ports          TEXT NOT NULL,
    unserved_since INTEGER,
    created_at     INTEGER NOT NULL
  );
  `,
  // Every box keeps its workspace and home in directories under DATA_DIR,
  // named by its id, so no row records a volume or a path.
  `
  ALTER TABLE boxes DROP COLUMN ws_volume;
  ALTER TABLE boxes DROP COLUMN home_volume;
  ALTER TABLE boxes DROP COLUMN workspace_dir;
  ALTER TABLE boxes DROP COLUMN home_dir;
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

/**
 * Runs every migration the database has not applied yet, one per transaction.
 * Throws for a database a newer build migrated, as there is no migration back.
 */
function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database is at version ${current} and this build knows ` +
        `${MIGRATIONS.length}: it was written by a newer build of Boxes.`,
    );
  }
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
 * The subnets of the boxes that are not deleted, which the allocator skips.
 * A deleted box gave its subnet back with its network.
 */
export function takenSubnets(db: Db): Set<string> {
  const rows = db
    .prepare("SELECT subnet FROM boxes WHERE status != 'deleted'")
    .all() as Array<{ subnet: string }>;
  return new Set(rows.map((row) => row.subnet));
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

/**
 * Marks a box active now, which holds the idle reaper off. A deleted box is
 * left alone, as an upstream may still report after the delete.
 */
export function touchBox(db: Db, boxId: string): void {
  db.prepare("UPDATE boxes SET last_active_at = ? WHERE id = ? AND status != 'deleted'").run(
    Date.now(),
    boxId,
  );
}

// --- threads ----------------------------------------------------------------

/** Every thread of a box, oldest first. */
export function listThreads(db: Db, boxId: string): ThreadRow[] {
  return db
    .prepare('SELECT * FROM threads WHERE box_id = ? ORDER BY ordinal ASC')
    .all(boxId) as ThreadRow[];
}

/** One thread by id, whichever box it belongs to. */
export function getThread(db: Db, threadId: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as
    | ThreadRow
    | undefined;
}

/**
 * One thread by the adapter's own id for it, within a box and a harness. A
 * message on one adapter's connection can only be about that adapter's thread.
 */
export function threadByAcpId(
  db: Db,
  boxId: string,
  harness: HarnessId,
  acpSessionId: string,
): ThreadRow | undefined {
  return db
    .prepare(
      'SELECT * FROM threads WHERE box_id = ? AND harness = ? AND acp_session_id = ?',
    )
    .get(boxId, harness, acpSessionId) as ThreadRow | undefined;
}

/**
 * The box's most recently active thread, or undefined before it has one.
 * Ties go to the newer thread.
 */
export function latestThread(db: Db, boxId: string): ThreadRow | undefined {
  return db
    .prepare(
      `SELECT * FROM threads WHERE box_id = ?
        ORDER BY last_active_at DESC, ordinal DESC LIMIT 1`,
    )
    .get(boxId) as ThreadRow | undefined;
}

/** What a thread is created as. Everything but the harness has a default. */
export interface NewThread {
  /** The agent that runs the thread. */
  harness: HarnessId;
  /** The adapter's own id, or null for a thread whose conversation is minted later. */
  acpSessionId?: string | null;
  /** The mode it is meant to be in, or null for its harness's default. */
  modeId?: string | null;
  /** What it is configured with, by option id. */
  config?: Record<string, string>;
  /** The thread it was forked from, while it has no transcript of its own. */
  inheritsFrom?: string | null;
}

/**
 * Inserts a thread and returns its row.
 *
 * The ordinal is one past the highest the box has ever used, so a name like
 * "Thread 2" stays that thread's for good.
 */
export function insertThread(db: Db, boxId: string, thread: NewThread): ThreadRow {
  const now = Date.now();
  const id = `t${randomBytes(6).toString('hex')}`;
  const next = db
    .prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM threads WHERE box_id = ?')
    .get(boxId) as { n: number };
  const row: ThreadRow = {
    id,
    box_id: boxId,
    harness: thread.harness,
    acp_session_id: thread.acpSessionId ?? null,
    title: null,
    ordinal: next.n,
    turn_active: 0,
    inherits_from: thread.inheritsFrom ?? null,
    mode_id: thread.modeId ?? null,
    config: JSON.stringify(thread.config ?? {}),
    done: 0,
    created_at: now,
    last_active_at: now,
  };
  db.prepare(
    `INSERT INTO threads (id, box_id, harness, acp_session_id, title, ordinal,
       turn_active, inherits_from, mode_id, config, done, created_at,
       last_active_at)
     VALUES (@id, @box_id, @harness, @acp_session_id, @title, @ordinal,
       @turn_active, @inherits_from, @mode_id, @config, @done, @created_at,
       @last_active_at)`,
  ).run(row);
  return row;
}

/** Records the adapter's own id for a thread, or clears it. */
export function setThreadAcpId(db: Db, threadId: string, acpSessionId: string | null): void {
  db.prepare('UPDATE threads SET acp_session_id = ? WHERE id = ?').run(
    acpSessionId,
    threadId,
  );
}

/**
 * Drops a fork's link to its source, once its first prompt gives it a
 * transcript that holds the source's history too.
 */
export function clearThreadInheritance(db: Db, threadId: string): void {
  db.prepare('UPDATE threads SET inherits_from = NULL WHERE id = ?').run(threadId);
}

/** Records what a thread is called, or clears it back to its ordinal. */
export function setThreadTitle(db: Db, threadId: string, title: string | null): void {
  db.prepare('UPDATE threads SET title = ?, last_active_at = ? WHERE id = ?').run(
    title,
    Date.now(),
    threadId,
  );
}

/**
 * Records the mode a thread is meant to be in, or clears it back to the
 * deployment's default.
 */
export function setThreadMode(db: Db, threadId: string, modeId: string | null): void {
  db.prepare('UPDATE threads SET mode_id = ? WHERE id = ?').run(modeId, threadId);
}

/**
 * Records a thread's other options, replacing the whole map. The adapter
 * answers a change with its full list of options.
 */
export function setThreadConfig(
  db: Db,
  threadId: string,
  config: Record<string, string>,
): void {
  db.prepare('UPDATE threads SET config = ? WHERE id = ?').run(
    JSON.stringify(config),
    threadId,
  );
}

/**
 * A thread's config column, parsed. Non-string values are dropped, and a
 * value that is not a JSON object reads as an empty map.
 */
export function threadConfig(row: ThreadRow): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(row.config);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([, value]) => typeof value === 'string',
    );
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Marks a thread finished with, or takes the mark off again. It leaves
 * `last_active_at` alone, so the mark does not make the thread the latest.
 */
export function setThreadDone(db: Db, threadId: string, done: boolean): void {
  db.prepare('UPDATE threads SET done = ? WHERE id = ?').run(done ? 1 : 0, threadId);
}

/** Marks a thread active now. */
export function touchThread(db: Db, threadId: string): void {
  db.prepare('UPDATE threads SET last_active_at = ? WHERE id = ?').run(Date.now(), threadId);
}

/**
 * Records whether a prompt turn is running on the thread the adapter knows by
 * `acpSessionId`, the id a prompt's params carry. Marks the thread and its box
 * active.
 */
export function setThreadTurnActive(
  db: Db,
  boxId: string,
  acpSessionId: string,
  active: boolean,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE threads SET turn_active = ?, last_active_at = ?
        WHERE box_id = ? AND acp_session_id = ?`,
    ).run(active ? 1 : 0, Date.now(), boxId, acpSessionId);
    touchBox(db, boxId);
  })();
}

/**
 * Clears the running-turn flag on every thread of a box, after a stop, an
 * adapter exit or boot reconciliation.
 */
export function clearBoxTurns(db: Db, boxId: string): void {
  db.prepare('UPDATE threads SET turn_active = 0 WHERE box_id = ?').run(boxId);
}

/** Whether any of a box's threads has a turn running. */
export function boxTurnActive(db: Db, boxId: string): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS hit FROM threads WHERE box_id = ? AND turn_active = 1 LIMIT 1',
    )
    .get(boxId) as { hit: number } | undefined;
  return row !== undefined;
}

/** The box ids that have a turn running on any of their threads. */
export function boxesWithActiveTurns(db: Db): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT box_id FROM threads WHERE turn_active = 1')
    .all() as Array<{ box_id: string }>;
  return new Set(rows.map((r) => r.box_id));
}

// --- push subscriptions -----------------------------------------------------

/**
 * Records a browser's subscription, replacing whatever was stored for the
 * same endpoint. A browser re-subscribes on every load with the same
 * endpoint, so this keeps one row and refreshes rotated keys.
 */
export function upsertPushSubscription(
  db: Db,
  endpoint: string,
  p256dh: string,
  auth: string,
  label: string | null,
  vapidKey: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO push_subscriptions
       (endpoint, p256dh, auth, label, created_at, last_used_at, vapid_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
       vapid_key = excluded.vapid_key`,
  ).run(endpoint, p256dh, auth, label, now, now, vapidKey);
}

/**
 * Deletes the subscriptions made under any key but this one, rows with no
 * key included, and returns how many went. The browser subscribes again on
 * its next visit.
 */
export function dropOtherKeySubscriptions(db: Db, vapidKey: string): number {
  return db
    .prepare('DELETE FROM push_subscriptions WHERE vapid_key IS NOT ?')
    .run(vapidKey).changes;
}

/** Every subscription this deployment would push to. */
export function listPushSubscriptions(db: Db): PushSubscriptionRow[] {
  return db
    .prepare('SELECT * FROM push_subscriptions ORDER BY created_at ASC')
    .all() as PushSubscriptionRow[];
}

/** Deletes one subscription, for an unsubscribe or a gone subscription. */
export function deletePushSubscription(db: Db, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/** Marks a subscription as delivered to just now. */
export function touchPushSubscription(db: Db, endpoint: string): void {
  db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?').run(
    Date.now(),
    endpoint,
  );
}

/** How many boxes exist that have not been deleted. */
export function countLiveBoxes(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM boxes WHERE status != 'deleted'")
    .get() as { n: number };
  return row.n;
}

/** How many browsers are subscribed. */
export function countPushSubscriptions(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as {
    n: number;
  };
  return row.n;
}

// --- the harness catalogue ---------------------------------------------------

/** One harness's cached answer, as stored. */
export interface HarnessCatalogRow {
  /** The harness id. */
  harness: string;
  /** JSON: the `modes` of the last answer, or `null`. */
  modes: string;
  /** JSON: the `configOptions` of the last answer. */
  config_options: string;
  /** Epoch milliseconds of the last answer. */
  seen_at: number;
}

/**
 * Records what an adapter advertised, against its harness.
 *
 * Called for every `session/new`, `session/load` and `session/fork` answer
 * that carries either list. A list the answer leaves out keeps its last
 * stored value.
 */
export function upsertHarnessCatalog(
  db: Db,
  harness: HarnessId,
  modes: ThreadModeState | null | undefined,
  configOptions: ThreadConfigOption[] | null | undefined,
): void {
  const previous = readHarnessCatalog(db, harness);
  const next: HarnessCatalog = {
    modes: modes ?? previous?.modes ?? null,
    configOptions: configOptions ?? previous?.configOptions ?? [],
    seenAt: Date.now(),
  };
  db.prepare(
    `INSERT INTO harness_catalog (harness, modes, config_options, seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(harness) DO UPDATE SET modes = excluded.modes,
       config_options = excluded.config_options, seen_at = excluded.seen_at`,
  ).run(harness, JSON.stringify(next.modes), JSON.stringify(next.configOptions), next.seenAt);
}

/**
 * What one harness's adapter last advertised, or null on a deployment that has
 * never run it.
 *
 * It is a cache, which the adapter corrects on the thread's first answer. A
 * row that cannot be parsed counts as no row.
 */
export function readHarnessCatalog(db: Db, harness: HarnessId): HarnessCatalog | null {
  const row = db.prepare('SELECT * FROM harness_catalog WHERE harness = ?').get(harness) as
    | HarnessCatalogRow
    | undefined;
  if (!row) return null;
  try {
    return {
      modes: JSON.parse(row.modes) as ThreadModeState | null,
      configOptions: JSON.parse(row.config_options) as ThreadConfigOption[],
      seenAt: row.seen_at,
    };
  } catch {
    return null;
  }
}
