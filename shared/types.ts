/**
 * REST API shapes shared by the orchestrator handlers and the dashboard.
 */

/** Lifecycle status of a Boxes session, as stored in the sessions table. */
export type SessionStatus =
  | 'creating'
  | 'running'
  | 'stopped'
  | 'error'
  | 'deleted';

/** What Docker reports right now, independent of what the DB believes. */
export type DockerState = 'running' | 'exited' | 'missing' | 'unknown';

/** One conversation of a session, as the API reports it. */
export interface ThreadSummary {
  id: string;
  /**
   * The adapter's own id for the thread, or null while the adapter has
   * forgotten it. A thread minted and never prompted does not survive the
   * adapter restarting.
   */
  acpSessionId: string | null;
  /** The title the agent generated, or null until a turn has produced one. */
  title: string | null;
  /** Per session and never reused; what an untitled thread is called. */
  ordinal: number;
  /**
   * True while a prompt turn is running on this thread. Threads run in
   * parallel, so with two of them live this is the only thing that says which
   * one is busy.
   */
  turnActive: boolean;
  /** Permission requests from this thread waiting for a browser to answer. */
  pendingCount: number;
  createdAt: number;
  lastActiveAt: number;
}

/** A session as returned by the list endpoint. */
export interface SessionSummary {
  id: string;
  name: string;
  profile: string;
  status: SessionStatus;
  /** Live container state, resolved against Docker on every request. */
  dockerState: DockerState;
  /**
   * True while a prompt turn is running on any of the session's threads.
   * Derived from them rather than stored beside them, so the two can never
   * disagree.
   */
  turnActive: boolean;
  /** Permission requests waiting for a browser to answer them, on any thread. */
  pendingCount: number;
  /**
   * Number of browsers currently attached to the session, across all of its
   * threads. Two tabs on two threads is two attachments.
   */
  attachedCount: number;
  /**
   * Bearer token an ACP client authenticates the WebSocket upgrade with,
   * carried in the subprotocol. One token covers the whole deployment, and
   * the list carries it so opening a thread needs no further request.
   */
  wsToken: string;
  /** Every conversation this session owns, oldest first. */
  threads: ThreadSummary[];
  /**
   * The thread a connection that names none gets — `/sessions/:id`, the short
   * WebSocket path, an external ACP client, a bookmark from before per-thread
   * routes existed. A default rather than the truth about what is loaded, and
   * null before the session has any thread at all.
   */
  currentThreadId: string | null;
  /**
   * True when the adapter advertised `sessionCapabilities.fork`. The capability
   * is unstable in the ACP schema, so the UI offers forking only when it is
   * there, and false is also what an adapter that has not yet been reached
   * reports.
   */
  canFork: boolean;
  createdAt: number;
  lastActiveAt: number;
}

/** A single session with the extra detail the detail view needs. */
export interface SessionDetail extends SessionSummary {
  image: string;
  containerId: string | null;
  networkName: string;
  subnet: string;
  /**
   * The named volume that used to hold the workspace, and still does for a
   * session created before workspaces became directories. Empty once the
   * session is directory-backed, which it becomes at its next start.
   */
  wsVolume: string;
  /**
   * Where the session's files are on the orchestrator's own filesystem, or
   * null while the session is still volume-backed — which is also what says
   * the review surface cannot read it yet.
   */
  workspaceDir: string | null;
  homeVolume: string;
  /** The adapter's id for the session's default thread, or null before one exists. */
  acpSessionId: string | null;
  /** True when the egress proxy is attached to this session's network. */
  proxyAttached: boolean;
}

/** Body of a request to add a thread to a session. */
export interface CreateThreadBody {
  /**
   * Fork this thread, carrying its context into the new one. Absent means a
   * fresh, empty thread on the same workspace.
   */
  from?: string;
}

/** Body of a create-session request. */
export interface CreateSessionBody {
  name: string;
  profile?: string;
}

/** One tapped ACP message from the debug log. */
export interface AcpLogEntry {
  id: number;
  direction: 'up' | 'down' | 'stderr';
  ts: number;
  payload: string;
}

/** A page of debug log entries. */
export interface AcpLogPage {
  entries: AcpLogEntry[];
  /** Pass as the after parameter to poll for newer entries. */
  cursor: number;
}

/** Answer to a health probe. */
export interface HealthResponse {
  ok: boolean;
  version: string;
  sessions: number;
  /** Session ids whose network is missing the egress proxy. */
  proxyWarnings: string[];
  /** Egress policy state, or null before the first push has been attempted. */
  egress: EgressHealth | null;
  /**
   * True when the deployment holds a Claude token. False means no session can
   * run a turn unless somebody logs in inside it.
   */
  claudeTokenConfigured: boolean;
  /** How many browsers are registered for Web Push. */
  pushSubscriptions: number;
}

/** The deployment's VAPID public key, which a browser subscribes with. */
export interface PushKeyResponse {
  /** Uncompressed P-256 point, base64url. Not a secret. */
  publicKey: string;
}

/**
 * Body of a push registration, shaped like the browser's own
 * PushSubscription.toJSON() so the page can pass it through unchanged.
 */
export interface PushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** What this browser calls itself, for the deployment's own reference. */
  label?: string;
}

/** Body of any 4xx or 5xx answer from the API. */
export interface ApiError {
  error: string;
}

/** Body of a request to run a local command in the session container. */
export interface ExecRequest {
  /** Run with `bash -lc`, inside the session's own isolation. */
  command: string;
}

/** One finished local command, as the exec log stores it. */
export interface ExecRecord {
  id: number;
  sessionId: string;
  command: string;
  /** Combined stdout and stderr, truncated at the output limit. */
  output: string;
  /** Null when the command was killed before reporting one. */
  exitCode: number | null;
  /** True when output hit the size limit and the rest was dropped. */
  truncated: boolean;
  /** True when the command hit the wall-clock limit and was killed. */
  timedOut: boolean;
  startedAt: number;
  finishedAt: number;
}

/** A page of exec records for one session, oldest first. */
export interface ExecLogPage {
  records: ExecRecord[];
}

// --- egress policy: the orchestrator -> proxy control channel ---------------

/**
 * One credential the proxy swaps in on the wire.
 *
 * A session holds `placeholder`; `secret` never leaves the orchestrator's and
 * the proxy's memory. A request to one of `hosts` carrying `placeholder` in
 * one of `headers` is rewritten to carry `secret`; one carrying anything else
 * there is refused by the proxy rather than forwarded.
 */
export interface EgressCredential {
  /** Stable identifier, used in logs and status. Never secret. */
  id: string;
  /**
   * Hostnames whose TLS is intercepted so this credential can be swapped in.
   * Same grammar as the allowlist: exact names and one-label wildcards.
   */
  hosts: string[];
  /** Header names that may carry it, lowercased. */
  headers: string[];
  /** What the session holds. Shaped like the real thing, worth nothing. */
  placeholder: string;
  /** The real credential. */
  secret: string;
}

/**
 * The proxy's entire configuration. It holds this in memory only, has none of
 * it at rest, and starts with none of it at all until the orchestrator pushes.
 */
export interface EgressPolicy {
  /**
   * Hostnames a session may reach. Empty means every public host, which is
   * the behavior of a deployment that sets no allowlist.
   */
  allowedHosts: string[];
  /** CA the proxy mints interception leaf certificates from, or null. */
  ca: { key: string; cert: string } | null;
  /** Credentials to translate. Empty means nothing is intercepted. */
  credentials: EgressCredential[];
}

/** What the proxy reports back on the control channel. Carries no secret. */
export interface EgressStatus {
  /** False until a policy has been pushed. */
  applied: boolean;
  /** Hash of the applied policy, so the orchestrator can see what is live. */
  policyHash: string;
  /** Number of entries in the applied allowlist; 0 means the allowlist is off. */
  allowedHostCount: number;
  /** Ids of the credentials being translated. */
  credentialIds: string[];
  /** Denials since the proxy booted, counted by reason. */
  denials: Record<string, number>;
  /** Seconds since the proxy booted. */
  uptimeSeconds: number;
}

/** The egress half of a health probe, as the orchestrator sees the proxy. */
export interface EgressHealth {
  /** True when the proxy reports the policy the orchestrator composed. */
  inSync: boolean;
  /** True when an allowlist is configured. */
  allowlistActive: boolean;
  /** Credentials being translated, by id. Never the values. */
  credentialIds: string[];
  /** Denials the proxy has counted since it booted, by reason. */
  denials: Record<string, number>;
  /** Why the last push or status read failed, or null. */
  error: string | null;
}

// --- code review over a session's workspace ---------------------------------

/** The git status of a file, as the review tree colours it. */
export type ReviewFileStatus =
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'added'
  | 'deleted'
  | 'conflict';

/** What happened to a line of a file, relative to the base revision. */
export type ReviewLineChange = 'added' | 'modified';

/** One file or directory of the review tree. */
export interface ReviewTreeEntry {
  name: string;
  /** Path relative to the review root, slash-separated. */
  path: string;
  isDir: boolean;
  /** Absent on files, which are the bulk of a tree. */
  children?: ReviewTreeEntry[];
}

/**
 * The revision a review is compared against. Both fields empty means the
 * working tree's HEAD, which is the default.
 */
export interface ReviewBase {
  /** What the user asked for: a branch, a tag, a short id. */
  rev: string;
  /** What that resolved to, through the merge base with HEAD. */
  commit: string;
}

/**
 * The whole left panel in one response: a phone on a slow link gets one round
 * trip per screen rather than one per piece of it.
 */
export interface ReviewTreeResponse {
  /**
   * The review root, relative to the workspace. Empty when the workspace
   * itself is the root — `/workspace` starts empty and an agent usually clones
   * into a subdirectory, so it usually names that.
   */
  root: string;
  /** False when the root is no git repository, which turns the git features off. */
  hasGit: boolean;
  entries: ReviewTreeEntry[];
  /** True when the tree hit the entry cap and was cut short. */
  truncated: boolean;
  /** Git status per path. Empty without git. */
  statuses: Record<string, ReviewFileStatus>;
  /** How many comments each annotated file has. */
  counts: Record<string, number>;
  base: ReviewBase;
  /** True when the workspace holds a REVIEW.md. */
  hasReview: boolean;
  /** The date the review was started, or '' when there is no review yet. */
  started: string;
}

/** One comment on one line, as the API reports it. */
export interface ReviewAnnotation {
  line: number;
  comment: string;
  /** True when the code the comment was written against is gone. */
  outdated: boolean;
}

/** A diff hunk, with the range of lines it covers in the current file. */
export interface ReviewDiffHunk {
  startLine: number;
  endLine: number;
  /** The hunk's raw diff text, which is what the hunk sheet shows. */
  diff: string;
}

/**
 * A block of lines deleted between two lines of the current file. How many is
 * not recorded: the hunk it points at shows them.
 */
export interface ReviewDiffDeletion {
  /** The deletion sits after this line; 0 means the top of the file. */
  afterLine: number;
  /** Index into a response's `hunks`. */
  hunkIndex: number;
}

/** The diff markers a file view draws in its gutter. */
export interface ReviewFileDiff {
  /** Changed lines, keyed by line number as a string, since JSON has no int keys. */
  lines: Record<string, ReviewLineChange>;
  hunks: ReviewDiffHunk[];
  deletions: ReviewDiffDeletion[];
}

/** The whole file view in one response. */
export interface ReviewFileResponse {
  path: string;
  /** Plain text. The browser tokenizes it; nothing here is render markup. */
  content: string;
  /** True when the file was longer than the cap and the rest was dropped. */
  truncated: boolean;
  /** True when the file holds a NUL byte, in which case content is empty. */
  binary: boolean;
  /**
   * True when the change under review deleted the file. The tree still lists
   * it, because a deletion is part of what is being reviewed, but there is
   * nothing on disk to show.
   */
  deleted: boolean;
  /** The file's real size in bytes, whatever was returned. */
  size: number;
  /** Lines in what was returned. */
  lines: number;
  /** Language guess for the highlighter, or '' when there is none. */
  language: string;
  /** This file's git status, or null when it has none. */
  status: ReviewFileStatus | null;
  diff: ReviewFileDiff;
  annotations: ReviewAnnotation[];
}

/** A file's comments, as the mutation endpoints answer with. */
export interface ReviewAnnotationsResponse {
  path: string;
  annotations: ReviewAnnotation[];
}

/**
 * The poll fingerprint. Local hashes rather than execs, and the only thing the
 * review view asks for while nothing is happening.
 */
export interface ReviewStatusResponse {
  /** Hash of REVIEW.md, or '' when there is none. */
  reviewHash: string;
  /** The commit HEAD names, or '' outside a repository. */
  headCommit: string;
  /** Hash of the whole status map, so a file's status changing moves it. */
  statusHash: string;
  /**
   * Hash of the file the pane has open, or '' when it has none. An edit to an
   * already-modified file moves nothing else, and this is what makes the open
   * file follow the agent's work.
   */
  fileHash: string;
}

/** Body of a create-or-update annotation request. */
export interface ReviewAnnotationBody {
  path: string;
  line: number;
  comment: string;
}

/** Body of a set-base request. Null clears the base back to HEAD. */
export interface ReviewBaseBody {
  rev: string | null;
}
