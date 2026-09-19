import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HarnessCatalog,
  HarnessId,
  SessionConfigOption,
  SessionModeState,
  SessionStatus,
} from '../../shared/types.ts';

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
  container_id: string | null;
  network_name: string;
  subnet: string;
  /**
   * The named volume holding the workspace of a session created before
   * workspaces became directories. Empty on a directory-backed session,
   * which every new one is.
   */
  ws_volume: string;
  /**
   * The named volume holding the home of a session created before homes
   * became directories. Empty on a directory-backed session, which every new
   * one is.
   */
  home_volume: string;
  /**
   * Where the session's files are, as this process saw them when the session
   * was created or migrated, and null while the session is still
   * volume-backed. The path used is derived from the current DATA_DIR, so
   * moving the data volume moves the workspaces with it; this column decides
   * only whether the session has a directory.
   */
  workspace_dir: string | null;
  /**
   * Where the session's home is, on the same terms as `workspace_dir`, and
   * null for a session from before homes became directories — which keeps its
   * `home_volume` and goes on running from it.
   */
  home_dir: string | null;
  /**
   * The revision the review is compared against, as the user gave it — a
   * branch, a tag, a short id — or null for each repository's own working
   * tree.
   *
   * One expression for the whole workspace, resolved independently in every
   * repository it holds. What it resolves to is therefore a different commit
   * in each and in some of them none, so it is derived per request rather
   * than stored.
   */
  review_base_rev: string | null;
  status: SessionStatus;
  /**
   * The extra agent set this session was created with, or null for the global
   * set alone. Cleared by the database if that set is later deleted.
   */
  agent_set_id: string | null;
  /**
   * The thread a connection that names none gets, or null before one exists.
   * A default rather than the truth: a connection may pin itself to any of
   * the session's threads instead.
   */
  current_thread_id: string | null;
  /**
   * The bearer token a WebSocket upgrade to this session has to present. Its
   * own: it opens this session and no other one in the deployment.
   */
  ws_token: string;
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
  /**
   * Which agent runs this conversation, by its id in the harness registry.
   *
   * On the thread rather than on the session because a box holds one checkout
   * and may run both agents over it, and because a transcript can only be
   * loaded back by the adapter that wrote it.
   */
  harness: HarnessId;
  acp_session_id: string | null;
  /**
   * What the thread is called: the title the agent generates at the end of a
   * turn, or the first line of a prompt sent on it while it has none. Null on
   * a thread that has never been prompted.
   */
  title: string | null;
  /** Per session and never reused; what an untitled thread is called. */
  ordinal: number;
  /**
   * 1 while a prompt turn is running on this thread. The session's own
   * "a turn is running" is derived from its threads rather than stored
   * beside them.
   */
  turn_active: number;
  /**
   * The thread this one was forked from, while it still has nothing of its
   * own to show. A fork carries the source's context from the moment it is
   * minted, but the adapter writes it a transcript only once it is prompted,
   * so until then this is where its replay comes from — and it is cleared by
   * that first prompt, after which the adapter has the whole conversation.
   */
  inherits_from: string | null;
  /**
   * The mode this thread is meant to be in, or null for the deployment's
   * default. Written when it changes rather than read from the adapter,
   * because the adapter forgets: it holds a mode for as long as the process
   * lives, and a respawn loads the conversation back without it.
   */
  mode_id: string | null;
  /**
   * Everything else the thread is configured with, as a JSON map of the
   * adapter's own option id to its value: the model, an effort level, whatever
   * else the harness offers.
   *
   * On the same terms as the mode, and for the same reason — the adapter holds
   * these only for as long as its process lives. The option that merely echoes
   * the mode is never stored here: a mode travels through `session/set_mode`
   * and `mode_id` alone, and a thread put into its mode twice by two
   * mechanisms is how the two answers drift apart.
   */
  config: string;
  /**
   * 1 once the reader has marked this conversation finished with. Read by the
   * dashboard and by nothing else: it changes what a row looks like, never
   * what the thread can do.
   */
  done: number;
  created_at: number;
  last_active_at: number;
}

/** One finished local command, as stored. */
export interface ExecRow {
  id: number;
  session_id: string;
  /**
   * The thread the command was typed in, and null when the session had no
   * thread to log it against. Such a row is listed by nobody.
   */
  thread_id: string | null;
  command: string;
  output: string;
  exit_code: number | null;
  truncated: number;
  timed_out: number;
  started_at: number;
  finished_at: number;
  /**
   * The id of the tool call or message the thread ended with when the command
   * was typed, or null when there was none or the browser did not say.
   */
  after_id: string | null;
}

/** A permission request the adapter is still blocked on. */
export interface PendingRequestRow {
  id: number;
  session_id: string;
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
 * One browser that has asked to be pushed to.
 *
 * The endpoint is the identity: it is the push service's own opaque URL for
 * this browser, unique per subscription, and re-subscribing the same browser
 * returns the same one — so a re-registered browser updates its row rather
 * than accumulating them. There is no user here to key on; Boxes has no
 * accounts, and whoever can reach the API can register.
 */
export interface PushSubscriptionRow {
  endpoint: string;
  /** The subscriber's public key, uncompressed P-256, base64url. */
  p256dh: string;
  /** The subscriber's authentication secret, base64url. */
  auth: string;
  /** What the browser called itself when it registered; for the UI only. */
  label: string | null;
  created_at: number;
  last_used_at: number;
  /**
   * The deployment's VAPID public key at the moment this subscription was
   * made, or null for a row stored before it was recorded.
   *
   * A subscription belongs to the key it was made under: a push signed with
   * any other one is refused for good.
   */
  vapid_key: string | null;
}

/**
 * One named collection of agent configuration: an AGENTS.md, plus any number
 * of skills and slash commands.
 *
 * The row with id `global` is seeded by the migration that creates the table
 * and is applied to every session. Every other set is optional and is chosen
 * when a session is created, and its contents are merged over the global ones.
 */
export interface AgentSetRow {
  id: string;
  name: string;
  /** This set's own AGENTS.md, or '' when it contributes none. */
  agents_md: string;
  created_at: number;
  updated_at: number;
}

/** One skill or slash command belonging to an agent set. */
export interface AgentItemRow {
  set_id: string;
  kind: 'skill' | 'command';
  /** A safe single path component; see the check in agents.ts. */
  name: string;
  content: string;
  created_at: number;
  updated_at: number;
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
  // it is about. Nothing needs moving with it: a turn cannot survive the
  // restart that applies this, and pending_requests is cleared at every boot,
  // so every thread correctly starts at 0.
  `
  ALTER TABLE threads ADD COLUMN turn_active INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_requests ADD COLUMN acp_session_id TEXT;
  ALTER TABLE sessions DROP COLUMN turn_active;
  `,
  // Browsers subscribed to Web Push. Keyed by the push service's endpoint,
  // which is the only stable identity a subscription has.
  //
  // This one stays at this index: a deployment that has already applied it
  // sits at user_version 6, and anything inserted ahead of it would be
  // skipped there.
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
  // A workspace becomes a directory on the orchestrator's data volume,
  // bind-mounted into the session container, so the orchestrator can read the
  // agent's files without an exec. Nothing is moved here: an existing row
  // keeps its ws_volume and a null workspace_dir, and migrates at its next
  // start — which is the only moment its container can be recreated with the
  // new mount.
  `
  ALTER TABLE sessions ADD COLUMN workspace_dir TEXT;
  `,
  // What a review remembers between requests. The annotations themselves are
  // not here: REVIEW.md in the workspace is the single source of truth for
  // those, and it is shared with the agent. These three are only what the
  // orchestrator would otherwise have to re-derive on every request.
  `
  ALTER TABLE sessions ADD COLUMN review_root TEXT;
  ALTER TABLE sessions ADD COLUMN review_base_rev TEXT;
  ALTER TABLE sessions ADD COLUMN review_base_commit TEXT;
  `,
  // What the agent is configured with, managed from the dashboard: an
  // AGENTS.md, skills and slash commands, in named sets. The `global` row is
  // seeded here, so every deployment has exactly one always-applied set from
  // its first boot.
  //
  // A session names at most one further set. Deleting that set is not blocked
  // — the session's files are already materialized — so the reference clears
  // itself, and the session falls back to the global set alone at its next
  // start.
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
  // A fork carries its source's context, but the adapter writes it no
  // transcript until it is first prompted — so until then the thread it
  // branched from stands in for one.
  `
  ALTER TABLE threads ADD COLUMN inherits_from TEXT;
  `,
  // Which mode and model a thread is meant to be in. The adapter holds both
  // only for as long as its process lives, so a respawn — an idle stop and a
  // return, a deploy, an adapter that died — needs them from here.
  //
  // NULL means this deployment's default rather than "unknown", which is what
  // a thread nobody has changed is in, so existing rows need no backfill.
  `
  ALTER TABLE threads ADD COLUMN mode_id TEXT;
  ALTER TABLE threads ADD COLUMN model_id TEXT;
  `,
  // pending_requests.upstream_id correlated a queued request with the
  // JSON-RPC id it arrived under, and the in-memory resolver reads nothing
  // from it. The table is cleared at every boot, so nothing is preserved.
  `
  ALTER TABLE pending_requests DROP COLUMN upstream_id;
  `,
  // The review becomes the whole workspace rather than one repository in it,
  // so there is no root to remember: `/workspace` is the root and a repository
  // is an attribute of a path. With a base resolved separately in every
  // repository the workspace holds there is no single commit to store either —
  // only the expression, which `review_base_rev` already is.
  //
  // Existing sessions are not migrated. An old REVIEW.md under a subdirectory
  // stays where it is and is no longer the review; it remains a file of the
  // tree, readable and deletable like any other.
  `
  ALTER TABLE sessions DROP COLUMN review_root;
  ALTER TABLE sessions DROP COLUMN review_base_commit;
  `,
  // The home follows the workspace out of a named volume and into a directory
  // on the data volume, so that everything a session is made of is in one
  // place and can be measured, backed up and read as ordinary files.
  //
  // Nothing is moved, here or later: an existing session keeps its
  // home_volume and a null home_dir, and goes on mounting the volume for as
  // long as it lives. Only a session created after this gets a directory.
  `
  ALTER TABLE sessions ADD COLUMN home_dir TEXT;
  `,
  // A local command belongs to the thread it was typed in. The log was
  // per-session, so every thread replayed all of it and a command run in one
  // conversation showed up in every other one. The stored rows name no thread
  // and nothing can say which conversation each was typed in, so they go.
  `
  DELETE FROM exec_log;
  ALTER TABLE exec_log ADD COLUMN thread_id TEXT;
  `,
  // Whether the reader is finished with a conversation. Theirs to set and
  // theirs alone to read: every existing thread starts at 0, which is what a
  // thread nobody has marked is.
  `
  ALTER TABLE threads ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
  `,
  // Where in its thread a command was typed: the id of the tool call or
  // message the transcript ended with, so a replay can put the run back
  // there. Rows from before know no such place and stay at the end.
  `
  ALTER TABLE exec_log ADD COLUMN after_id TEXT;
  `,
  // The token a WebSocket upgrade presents belongs to one session, so it
  // opens that session alone rather than every session of the deployment.
  //
  // Every existing row is given a token here rather than at its first read:
  // this is the one moment that reaches all of them, and it leaves no session
  // without one. SQLite draws randomblob per row, so no two sessions share a
  // token.
  `
  ALTER TABLE sessions ADD COLUMN ws_token TEXT NOT NULL DEFAULT '';
  UPDATE sessions SET ws_token = lower(hex(randomblob(32)));
  `,
  // The forwarded ACP messages go to stderr at debug level, where `docker
  // logs` sees them, so the table that held them has no reader and no writer.
  `
  DROP INDEX IF EXISTS idx_acp_log_session;
  DROP TABLE IF EXISTS acp_log;
  `,
  // Which VAPID key a browser subscribed under. A push signed with another
  // one is refused by the push service with a status that says nothing about
  // the subscription, so without this the row is retried at every event for
  // as long as the deployment lives. Existing rows are left empty, which is
  // no key at all: the browser subscribes again on its next visit.
  `
  ALTER TABLE push_subscriptions ADD COLUMN vapid_key TEXT;
  `,
  // Credentials move out of the environment and into the database, so that a
  // token can be entered from the settings page and reach the proxy without a
  // restart — and so that a login, which has no static form at all, has
  // somewhere to live. The secret is stored as-is: the orchestrator has to
  // hand it to the proxy on every boot, so there is nobody to ask for a
  // passphrase.
  //
  // The settings table is the non-secret half of the same page: the git
  // identity that used to come from the environment beside the credentials,
  // and each dialog's last choice.
  //
  // Milestone 2 adds the thread and catalogue changes here: this entry is
  // extended rather than a new one appended, because the two ship together
  // and a deployment that has applied this one is not yet in anybody's hands.
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

  -- Which agent a thread runs, and what it is configured with beyond its
  -- mode. Existing threads are Claude's, which is the only harness there has
  -- been, and the model each was left on keeps meaning what it meant: both
  -- adapters call that option "model".
  ALTER TABLE threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE threads ADD COLUMN config  TEXT NOT NULL DEFAULT '{}';
  UPDATE threads SET config = json_object('model', model_id) WHERE model_id IS NOT NULL;
  ALTER TABLE threads DROP COLUMN model_id;

  -- The argv comes from the harness registry now, so a session no longer
  -- carries the adapter it was created with: the thread says which adapter it
  -- needs, and a box may need either.
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
 * Runs every migration the database has not applied yet, one per transaction,
 * and refuses a database from ahead of this build.
 *
 * A rollback puts an older orchestrator on a database a newer one migrated,
 * whose columns are not the ones this build reads and writes. There is no
 * migration back, so the only safe answer is to say so and stop, rather than
 * to boot and fail against the first query that meets a changed column.
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
 * The subnets the sessions that still exist are on.
 *
 * What the allocator has to skip: the counter behind nextSubnetIndex only
 * rises, so it wraps back onto subnets that are still held once the pool has
 * been round once. A deleted session gives its subnet back with its network,
 * so its tombstone is not counted.
 */
export function takenSubnets(db: Db): Set<string> {
  const rows = db
    .prepare("SELECT subnet FROM sessions WHERE status != 'deleted'")
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
 * Drops all but the newest `keep` rows of one session from a log table.
 *
 * Both logs are per-session rings, and the trim is the same statement over a
 * different table: keep nothing older than the row `keep` places back from the
 * newest, and keep everything when the session has fewer than that. The table
 * name is interpolated because SQLite cannot bind an identifier; it is never
 * caller-supplied.
 */
function pruneRing(db: Db, table: 'exec_log', sessionId: string, keep: number): void {
  db.prepare(
    `DELETE FROM ${table}
     WHERE session_id = ?
       AND id <= COALESCE(
         (SELECT id FROM ${table} WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?),
         -1)`,
  ).run(sessionId, sessionId, keep);
}

/** Local command runs kept per session. */
const EXEC_RING = 200;

/**
 * Records one finished local command and returns its stored row id.
 *
 * A session whose row says deleted is written nothing and gets 0 back, the
 * rule setStatus keeps. A command streams its output for up to two minutes
 * and is stored when it ends, which is long enough for the session to have
 * been removed under it — and a row inserted then would outlive the delete
 * that cleared the table.
 */
export function appendExecLog(
  db: Db,
  sessionId: string,
  record: Omit<ExecRow, 'id' | 'session_id'>,
): number {
  const info = db
    .prepare(
      `INSERT INTO exec_log
         (session_id, thread_id, command, output, exit_code, truncated, timed_out,
          started_at, finished_at, after_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = ? AND status = 'deleted')`,
    )
    .run(
      sessionId,
      record.thread_id,
      record.command,
      record.output,
      record.exit_code,
      record.truncated,
      record.timed_out,
      record.started_at,
      record.finished_at,
      record.after_id,
      sessionId,
    );
  if (info.changes === 0) return 0;
  pruneRing(db, 'exec_log', sessionId, EXEC_RING);
  return Number(info.lastInsertRowid);
}

/**
 * Every stored command run in one thread, oldest first.
 *
 * The session is part of the lookup as well as the thread, so a thread id
 * from another session matches nothing rather than reaching into it.
 */
export function listExecLog(db: Db, sessionId: string, threadId: string): ExecRow[] {
  return db
    .prepare('SELECT * FROM exec_log WHERE session_id = ? AND thread_id = ? ORDER BY id ASC')
    .all(sessionId, threadId) as ExecRow[];
}

/**
 * Marks a session active now, which is what holds the idle reaper off.
 *
 * A deleted session is left alone: an upstream still settling when the session
 * was removed reports afterwards, and that must not stir a row that is on its
 * way out.
 */
export function touchSession(db: Db, sessionId: string): void {
  db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ? AND status != 'deleted'").run(
    Date.now(),
    sessionId,
  );
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

/**
 * One thread by the adapter's own id for it, within a session and a harness.
 *
 * The gateway knows a conversation by that id and nothing else, so this is
 * how a message about it finds the row a link or a name has to come from.
 * Both adapters mint UUIDs and a collision is not expected; the harness is
 * part of the key as hygiene, because a message arrives on one adapter's
 * connection and can only be about a thread of that adapter.
 */
export function threadByAcpId(
  db: Db,
  sessionId: string,
  harness: HarnessId,
  acpSessionId: string,
): ThreadRow | undefined {
  return db
    .prepare(
      'SELECT * FROM threads WHERE session_id = ? AND harness = ? AND acp_session_id = ?',
    )
    .get(sessionId, harness, acpSessionId) as ThreadRow | undefined;
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

/** What a thread is created as. Everything but the harness has a default. */
export interface NewThread {
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
 * Inserts a thread and makes it the session's current one.
 *
 * The ordinal is one past the highest the session has ever used, so a name
 * like "Thread 2" stays that thread's for good.
 *
 * The harness, the mode and the config are given here rather than written
 * afterwards because they are what the thread *is*: a row created without them
 * would be a conversation on an unknown agent for as long as it took the
 * second statement to run, and the first thread of a box is created before
 * any adapter has been started.
 */
export function insertThread(db: Db, sessionId: string, thread: NewThread): ThreadRow {
  const now = Date.now();
  const id = `t${randomBytes(6).toString('hex')}`;
  const next = db
    .prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM threads WHERE session_id = ?')
    .get(sessionId) as { n: number };
  const row: ThreadRow = {
    id,
    session_id: sessionId,
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
  db.transaction(() => {
    db.prepare(
      `INSERT INTO threads (id, session_id, harness, acp_session_id, title, ordinal,
         turn_active, inherits_from, mode_id, config, done, created_at,
         last_active_at)
       VALUES (@id, @session_id, @harness, @acp_session_id, @title, @ordinal,
         @turn_active, @inherits_from, @mode_id, @config, @done, @created_at,
         @last_active_at)`,
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

/**
 * Drops a thread's borrowed history: it has a transcript of its own now.
 *
 * Called when a fork is first prompted, because that is the moment the
 * adapter starts a transcript for it — one that already carries everything
 * the source had said. Replaying the source as well would say all of it
 * twice.
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
 *
 * Written on every change rather than read back on demand, because the only
 * other holder of it is the adapter process and the point of the column is
 * outliving that.
 */
export function setThreadMode(db: Db, threadId: string, modeId: string | null): void {
  db.prepare('UPDATE threads SET mode_id = ? WHERE id = ?').run(modeId, threadId);
}

/**
 * Records everything else a thread is configured with, replacing the whole
 * map.
 *
 * Whole rather than per key, because the adapter answers a change with its
 * full list of options and that answer is the record that matters. A caller
 * with one option to change reads, merges and writes; see
 * `gateway/adapter.ts`.
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
 * A thread's config map, as a map.
 *
 * Tolerant of anything that is not one: the column is JSON written by this
 * process, and a row that somehow holds something else should cost the thread
 * its settings rather than every read of it.
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
 * Marks a thread finished with, or takes the mark off again.
 *
 * `last_active_at` is left alone: marking a conversation done is the reader's
 * bookkeeping rather than anything happening in it, and moving the age would
 * send a thread nobody has touched back to the freshest one in the box.
 */
export function setThreadDone(db: Db, threadId: string, done: boolean): void {
  db.prepare('UPDATE threads SET done = ? WHERE id = ?').run(done ? 1 : 0, threadId);
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
 * carry, so the row is found by which conversation the turn is on.
 */
export function setThreadTurnActive(
  db: Db,
  sessionId: string,
  acpSessionId: string,
  active: boolean,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE threads SET turn_active = ?, last_active_at = ?
        WHERE session_id = ? AND acp_session_id = ?`,
    ).run(active ? 1 : 0, Date.now(), sessionId, acpSessionId);
    touchSession(db, sessionId);
  })();
}

/**
 * Clears the running-turn flag on every thread of a session.
 *
 * None of the callers leaves a turn running: a deliberate stop, an adapter
 * exit, boot reconciliation.
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

// --- push subscriptions -----------------------------------------------------

/**
 * Records a browser's subscription, replacing whatever was stored for the
 * same endpoint.
 *
 * A browser re-subscribes on every load — Safari in particular drops
 * subscriptions on its own schedule — and the push service hands back the
 * endpoint it already had. Upserting is what keeps that from growing a row
 * per page view, and refreshes keys the browser has rotated.
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
 * Forgets the subscriptions made under any key but this one, and says how
 * many went.
 *
 * A subscription is only good for the VAPID key it was made under, so one
 * left from a rotated key can never be delivered to again — and a push
 * service refuses it with a status that is neither 404 nor 410, which is
 * what the ordinary pruning reads. A row that names no key at all is from
 * before the key was recorded and goes the same way; the browser subscribes
 * again on its next visit.
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

/** Forgets one subscription. Used both by an unsubscribe and by a 410. */
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

/** How many sessions exist that have not been deleted. */
export function countLiveSessions(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE status != 'deleted'")
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
  harness: string;
  /** JSON: the `modes` of the last answer, or `null`. */
  modes: string;
  /** JSON: the `configOptions` of the last answer. */
  config_options: string;
  seen_at: number;
}

/**
 * Records what an adapter advertised, against its harness.
 *
 * Called for every `session/new`, `session/load` and `session/fork` answer
 * that carries either list, because that is every moment a running adapter
 * says what it offers. A field the answer does not carry leaves what was last
 * seen alone: an adapter that answers a load with modes and no config options
 * should not empty the half it said nothing about.
 */
export function upsertHarnessCatalog(
  db: Db,
  harness: HarnessId,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[] | null | undefined,
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
 * A cache and not a truth: it is what some adapter said at some point, and the
 * dialog reading it offers it knowing the adapter corrects it on the thread's
 * first answer. A row that cannot be parsed is treated as no row at all.
 */
export function readHarnessCatalog(db: Db, harness: HarnessId): HarnessCatalog | null {
  const row = db.prepare('SELECT * FROM harness_catalog WHERE harness = ?').get(harness) as
    | HarnessCatalogRow
    | undefined;
  if (!row) return null;
  try {
    return {
      modes: JSON.parse(row.modes) as SessionModeState | null,
      configOptions: JSON.parse(row.config_options) as SessionConfigOption[],
      seenAt: row.seen_at,
    };
  } catch {
    return null;
  }
}
