/**
 * REST API shapes shared by the orchestrator handlers and the dashboard.
 */

/** Lifecycle status of a box, as stored in the boxes table. */
export type BoxStatus =
  | 'creating'
  | 'running'
  | 'stopped'
  | 'error'
  | 'deleted';

/** What Docker reports right now, independent of what the DB believes. */
export type DockerState = 'running' | 'exited' | 'missing' | 'unknown';

/**
 * Which agent harness a box can run.
 *
 * Declared here rather than only in the orchestrator's registry because the
 * dashboard reads it off the health probe; `orchestrator/src/harness.ts`
 * re-exports it, and is still the one place a harness is described.
 */
export type HarnessId = 'claude' | 'codex';

/**
 * A credential the deployment holds, by the service it authenticates to.
 *
 * Same reasoning as HarnessId: the settings page names these, so they are
 * part of the API. `orchestrator/src/credentials.ts` owns the store and
 * re-exports the three types below.
 */
export type CredentialId = 'claude' | 'openai' | 'github' | 'gitlab';

/**
 * How a credential was obtained, which decides what the secret is: a token
 * pasted from `claude setup-token`, an API key, or the whole JSON document a
 * CLI wrote when somebody logged in.
 */
export type CredentialMethod = 'token' | 'api_key' | 'oauth';

/** Whether a stored credential is believed to work. */
export type CredentialStatus = 'ok' | 'expired' | 'failing';

/**
 * One stored credential, as everything outside the orchestrator sees it.
 *
 * Never the secret. `account` is what a person recognises the credential by:
 * the last four characters of a pasted secret, or the account name where a
 * login reported one.
 */
export interface CredentialSummary {
  id: CredentialId;
  method: CredentialMethod;
  account: string | null;
  status: CredentialStatus;
  lastError: string | null;
  /** When the secret stops working, in epoch milliseconds, or null for a static one. */
  expiresAt: number | null;
  /** When it was last refreshed, in epoch milliseconds, or null if it never has been. */
  refreshedAt: number | null;
  updatedAt: number;
}

/** What one harness needs before a thread on it can run, and whether it has it. */
export interface HarnessHealth {
  id: HarnessId;
  /** What the dashboard calls it. */
  label: string;
  /** Null when no credential is stored for this harness. */
  credential: CredentialSummary | null;
  /** True when a thread of this harness can run a turn right now. */
  runnable: boolean;
}

/**
 * The modes an adapter advertises for a thread, and the one it is in.
 *
 * An ACP shape rather than one of ours: the gateway reads it off every
 * `session/new`, `session/load` and `session/fork` answer, and it is here so
 * the dialog that offers the modes and the gateway that applies them agree
 * about what one is.
 */
export interface SessionModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name?: string; description?: string | null }>;
}

/**
 * One thing about a thread the adapter lets a client set, and its current
 * value.
 *
 * `category` says what the option is for, which is how the model selector is
 * found without depending on the adapter's own id for it — and how the option
 * that merely echoes the mode is kept out of a thread's config map, since the
 * mode travels through `session/set_mode` alone.
 */
export interface SessionConfigOption {
  id: string;
  name?: string;
  /** What the adapter says the option does, where it says anything. */
  description?: string | null;
  /**
   * `select` carries an options list; another kind carries none. Absent means
   * a select, which is what both adapters send for everything they offer.
   */
  type?: string;
  category?: string | null;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string | null }>;
}

/**
 * What one harness's adapter last advertised, cached against the harness.
 *
 * A dialog cannot ask an adapter what it offers, because the thread it would
 * ask about does not exist yet — and starting a box to find out would cost a
 * container per dialog. So what an adapter answered the last time one ran is
 * kept, and the dialog offers that. The adapter corrects it on the thread's
 * first answer.
 */
export interface HarnessCatalog {
  /** The modes of the last answer, or null when it carried none. */
  modes: SessionModeState | null;
  /** The config options of the last answer; empty when it carried none. */
  configOptions: SessionConfigOption[];
  /** When the answer arrived, in epoch milliseconds. */
  seenAt: number;
}

/**
 * One harness as the dialogs see it: what the registry says, what its adapter
 * last advertised, and whether it can run right now.
 */
export interface HarnessInfo extends HarnessHealth {
  /** Mode a fresh thread of this harness is put in. */
  defaultModeId: string;
  /** Mode a fork of one starts in instead. */
  forkModeId: string;
  /** Config option values a fresh thread starts with, by option id. */
  defaultConfig: Record<string, string>;
  /** Null on a deployment that has never run this harness's adapter. */
  catalog: HarnessCatalog | null;
}

/**
 * What a thread dialog last chose for one harness, so the next box starts on
 * the same settings from any device.
 *
 * Written by the dashboard and read back by it; the orchestrator only stores
 * it. Nothing fills it before the dialogs exist.
 */
export interface ThreadDialogDefaults {
  modeId?: string;
  config?: Record<string, string>;
}

/**
 * The deployment's plain settings: everything that is configuration rather
 * than a secret, and so lives beside the credentials instead of in them.
 *
 * The git identity is what every box commits as. It used to come from the
 * environment, and only did so because the credentials did.
 */
export interface Settings {
  gitName: string;
  gitEmail: string;
  /** Keyed by harness id; see ThreadDialogDefaults. */
  dialogs: Record<string, ThreadDialogDefaults>;
}

/** Body of a request to store a credential by pasting its secret. */
export interface PutCredentialBody {
  method: CredentialMethod;
  secret: string;
}

/**
 * Where a login has got to, as the settings page polls it.
 *
 * A credential that is an account rather than a string is obtained by running
 * the harness's own CLI in a throwaway container, and the two CLIs want
 * different things from the person at the browser. Codex prints a URL and a
 * one-time code and then polls on its own, so the page shows both and waits;
 * Claude prints a URL and then blocks on a prompt, so the page shows the URL,
 * takes the code the page it opened gave back, and posts it in. Both end the
 * same way, and a login that ended badly says why in a sentence worth showing.
 */
export type LoginState =
  | { state: 'starting' }
  /** The CLI is waiting for a browser. `code` is Codex's one-time code, where there is one. */
  | { state: 'awaiting_browser'; url: string; code: string | null }
  /**
   * The CLI is blocked on a code the page has to paste back. `error` is what
   * it said about the last code it refused, so a rejection is visible rather
   * than looking like nothing happened; null until one is refused.
   */
  | { state: 'awaiting_code'; url: string; error: string | null }
  | { state: 'done' }
  | { state: 'failed'; error: string };

/** What starting a login answers with: the id every later call names. */
export interface StartLoginResponse {
  loginId: string;
}

/** Body of the paste-back: the code the login page gave the person. */
export interface LoginCodeBody {
  code: string;
}

/**
 * One thing a conversation has left running in its box.
 *
 * What the harness's adapter announced as an async task: both adapters send a
 * spawn when a task starts and a state update when it ends, and a task that
 * nobody hears the end of is dropped when its adapter process goes. Nothing is
 * read off the process table here — a task's id is the adapter's own, and it is
 * what a stop names.
 */
export interface BackgroundProcess {
  /** The adapter's asyncTaskId, which is what a stop names. */
  id: string;
  /** `name` from the spawn: the command for a shell, a description otherwise. */
  command: string;
  /** `shell`, `workflow`, `monitor` or `task` from Claude; `shell` from Codex. */
  kind: string;
  /** `canStop` from the spawn. Both adapters send true today. */
  stoppable: boolean;
  /** When the spawn arrived, in epoch milliseconds. */
  startedAt: number;
}

/**
 * One process a reading of a box found running in it.
 *
 * The other answer to "what is running", taken off the process table rather
 * than from an adapter. It names no task and belongs to no conversation — a
 * reading knows what runs in a box and not whose it is — so this is what a
 * reader gets when the bars are empty and the box says it is busy anyway.
 */
export interface BoxWork {
  /**
   * The pid as the reading took it, which tells two identical command lines
   * apart. Not what a stop signals: that is read again in the numbering a
   * kill inside the box takes.
   */
  pid: number;
  /** The whole command line, which is how a process is recognised. */
  command: string;
  /** How long it has been running, or null where `ps` would not say. */
  elapsedSeconds: number | null;
}

/** One conversation of a box, as the API reports it. */
export interface ThreadSummary {
  id: string;
  /**
   * Which agent runs this conversation. A property of the thread rather than
   * of the box: one checkout with two agents working on it is the point.
   */
  harness: HarnessId;
  /**
   * The mode the thread is meant to be in, or null for its harness's default.
   * What the adapter is in right now arrives over ACP; this is what a respawn
   * puts it back into.
   */
  modeId: string | null;
  /**
   * Everything else the thread is configured with, by the adapter's own id for
   * each option: the model, an effort level, whatever else it offers. The
   * option that echoes the mode is never in here — see `modeId`.
   */
  config: Record<string, string>;
  /**
   * True when this thread's adapter advertised `sessionCapabilities.fork`.
   *
   * Per thread rather than per box, because a box may hold threads of two
   * harnesses and the answer comes from each adapter's own `initialize`. The
   * capability is unstable in the ACP schema, so an adapter may omit it, and
   * false is also what a thread whose adapter has not been reached reports.
   */
  canFork: boolean;
  /**
   * The adapter's own id for the thread, or null while the adapter has
   * forgotten it. A thread minted and never prompted does not survive the
   * adapter restarting.
   */
  acpSessionId: string | null;
  /**
   * What the thread is called: the agent's own title, or the first line of a
   * prompt sent on it while it has none. Null until it has been prompted.
   */
  title: string | null;
  /** Per box and never reused; what an untitled thread is called. */
  ordinal: number;
  /**
   * True while a prompt this gateway forwarded is still open on this thread.
   *
   * An open turn is not the agent working: a turn that spawned a background
   * subagent stays open after the agent has gone quiet. `speaking` says
   * whether the agent is working.
   */
  turnActive: boolean;
  /**
   * Whether this conversation has work still running in its box, with no turn
   * to say so.
   */
  backgroundBusy: boolean;
  /**
   * True while the agent is producing output on this thread — text, thinking,
   * a tool call of its own.
   *
   * Independent of `turnActive`: a thread woken by a task reporting in speaks
   * with no prompt open, and a thread holding a subagent's turn open is
   * silent with one.
   */
  speaking: boolean;
  /** Permission requests from this thread waiting for a browser to answer. */
  pendingCount: number;
  /**
   * Whether the reader has marked this conversation finished with.
   *
   * A note for the list and nothing else. A thread marked done still runs and
   * still takes prompts, and the mark can be taken off again.
   */
  done: boolean;
  createdAt: number;
  lastActiveAt: number;
}

/** A box as returned by the list endpoint. */
export interface BoxSummary {
  id: string;
  name: string;
  profile: string;
  status: BoxStatus;
  /** Live container state, resolved against Docker on every request. */
  dockerState: DockerState;
  /**
   * True while a prompt this gateway forwarded is open on any of the
   * box's threads. Derived from the threads rather than stored.
   */
  turnActive: boolean;
  /** True while the agent is producing output on any of them. */
  speaking: boolean;
  /**
   * Whether the box still has work running in it — a command left running, a
   * monitor watching something — with no turn to say so.
   *
   * About the box rather than any one conversation. What is running, and
   * which thread owns it, is on {@link TurnStateParams.background}.
   */
  backgroundBusy: boolean;
  /** Permission requests waiting for a browser to answer them, on any thread. */
  pendingCount: number;
  /**
   * Number of browsers currently attached to the box, across all of its
   * threads. Two tabs on two threads is two attachments.
   */
  attachedCount: number;
  /**
   * Bearer token an ACP client authenticates the WebSocket upgrade with,
   * carried in the subprotocol. This box's own: it opens this box and
   * no other one in the deployment.
   */
  wsToken: string;
  /** Every conversation this box owns, oldest first. */
  threads: ThreadSummary[];
  /**
   * The thread a connection that names none gets: `/boxes/:id`, the short
   * WebSocket path, an external ACP client. A default rather than what any
   * browser has loaded, and null before the box has any thread.
   */
  currentThreadId: string | null;
  /**
   * The agent set selected when this box was created, or null for the
   * global set alone. Null is also what a box whose set has since been
   * deleted reports.
   */
  agentSetId: string | null;
  /** That set's current name, for the UI. Null whenever `agentSetId` is. */
  agentSetName: string | null;
  /**
   * How much disk this box is taking up, in bytes, or null when there is
   * no measurement yet.
   *
   * Its workspace and its home together. Measured in the background and read
   * from the last measurement, so it lags: a running box is re-measured at
   * most every fifteen minutes, and a stopped one is not re-measured at all.
   * Null covers both a box not measured yet and one with no directory to
   * walk.
   */
  diskBytes: number | null;
  createdAt: number;
  lastActiveAt: number;
}

/** A single box with the extra detail the detail view needs. */
export interface BoxDetail extends BoxSummary {
  image: string;
  containerId: string | null;
  networkName: string;
  subnet: string;
  /**
   * The named volume holding the workspace of a box created before
   * workspaces became directories. Empty for a directory-backed box,
   * which a volume-backed one becomes at its next start.
   */
  wsVolume: string;
  /**
   * Where the box's files are on the orchestrator's own filesystem, or
   * null while the box is still volume-backed.
   */
  workspaceDir: string | null;
  /**
   * The named volume holding the home of a box created before homes
   * became directories. Empty for a directory-backed box.
   */
  homeVolume: string;
  /**
   * Where the box's home is on the orchestrator's own filesystem — its
   * thread history, its tool caches, whatever a login inside the box wrote —
   * or null for one still backed by a named volume.
   */
  homeDir: string | null;
  /** The adapter's id for the box's default thread, or null before one exists. */
  acpSessionId: string | null;
  /** True when the egress proxy is attached to this box's network. */
  proxyAttached: boolean;
  /**
   * What the last reading found running in the box, which is what the
   * box-wide stop would signal.
   *
   * Empty for a box nothing has read yet and for one that is not up, both of
   * which are boxes with nothing known to be running in them. Not on the
   * summary: the list is polled for every box at once, and a command line
   * is only wanted by somebody looking at one box.
   */
  boxWork: BoxWork[];
}

/**
 * What a new thread is to run and be configured with.
 *
 * Every field but the harness is optional, and an absent one means the
 * harness's own default: a client that knows nothing about modes or models
 * still creates a usable thread by naming an agent.
 */
export interface ThreadOptions {
  harness: HarnessId;
  /** Registry default when absent. */
  modeId?: string;
  /** The harness's `defaultConfig` when absent. */
  config?: Record<string, string>;
}

/** Body of a request to add a thread to a box. */
export interface CreateThreadBody {
  /**
   * Fork this thread, carrying its context into the new one. Absent means a
   * fresh, empty thread on the same workspace.
   */
  from?: string;
  /**
   * What the new thread runs. Ignored when `from` is set: a transcript can
   * only be loaded by the adapter that wrote it, so a fork stays on its
   * source's harness. Absent means Claude on its defaults.
   */
  options?: ThreadOptions;
}

/** Body of a request to mark a thread done, or to take the mark off again. */
export interface ThreadDoneBody {
  done: boolean;
}

/** Body of a create-box request. */
export interface CreateBoxBody {
  name: string;
  /**
   * Ignored. Every box runs on the one set of credentials the settings page
   * manages, so there is no profile to name; the field is kept so a client
   * from before that still creates a box rather than a 400.
   */
  profile?: string;
  /**
   * Id of the agent set whose AGENTS.md, skills and commands are merged over
   * the global ones for this box. Absent, empty or the global set's own id
   * all mean "the global set alone" — it is applied either way.
   */
  agentSet?: string | null;
  /**
   * What the box's first conversation runs. A box is made to be worked in, so
   * it is made with a thread in it, and the dialog that names the box names
   * the agent in the same request. Absent means Claude on its defaults.
   */
  thread?: ThreadOptions;
}

/**
 * Which copy of one image the deployment is running, and when it was built.
 *
 * The digest is the registry's manifest digest where there is one. An image
 * built on this host has never been in a registry, so its config digest
 * stands in.
 */
export interface ImageInfo {
  /** `sha256:...`, of the manifest where there is one and of the config otherwise. */
  digest: string;
  /** When the image was built, in epoch milliseconds, or null where it says nothing. */
  builtAt: number | null;
  /**
   * What the image takes on this host, in bytes, or null where it says
   * nothing.
   *
   * The daemon's figure: the uncompressed size of every layer, not the
   * download. A layer shared with another image is counted here as well.
   */
  sizeBytes: number | null;
}

/**
 * The three images a deployment runs, each null where the daemon could not be
 * asked or has nothing under that name.
 */
export interface DeploymentImages {
  orchestrator: ImageInfo | null;
  proxy: ImageInfo | null;
  box: ImageInfo | null;
}

/** Answer to a health probe. */
export interface HealthResponse {
  ok: boolean;
  version: string;
  boxes: number;
  /** Box ids whose network is missing the egress proxy. */
  proxyWarnings: string[];
  /** Egress policy state, or null before the first push has been attempted. */
  egress: EgressHealth | null;
  /**
   * Every harness this deployment can run, and whether each of them has a
   * credential that works. A harness that is not runnable is one whose
   * threads fail at their first turn, which is why the dashboard says so
   * before anybody prompts one.
   */
  harnesses: HarnessHealth[];
  /** Every stored credential, GitHub included. Never the secrets. */
  credentials: CredentialSummary[];
  /** How many browsers are registered for Web Push. */
  pushSubscriptions: number;
  /** Which build of each of the deployment's own images is running. */
  images: DeploymentImages;
}

/**
 * What the readiness probe answers, ready or not.
 *
 * The status code carries the same answer, so a probe that reads nothing but
 * the code is served. This body is for a person looking at why.
 */
export interface ReadyResponse {
  /** True only when every check below passed. */
  ready: boolean;
  version: string;
  /** Each thing a box needs before it can be served, and whether it is there. */
  checks: {
    /** The database answered a query. */
    database: boolean;
    /** The proxy holds the egress policy this orchestrator composed. */
    egress: boolean;
    /** The Docker daemon answered. */
    docker: boolean;
  };
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

/**
 * One file the user attached to a prompt, as the upload endpoint reports it
 * back.
 *
 * The path is workspace-relative and slash-separated, which is what a client
 * puts in the prompt and what the agent types into a tool call. The name may
 * differ from the one that was uploaded: it is sanitised, and a collision is
 * suffixed.
 */
export interface StoredAttachment {
  name: string;
  path: string;
  size: number;
}

// --- egress policy: the orchestrator -> proxy control channel ---------------

/**
 * One credential the proxy swaps in on the wire.
 *
 * A box holds `placeholder`; `secret` never leaves the orchestrator's and
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
  /** What the box holds. Shaped like the real thing, worth nothing. */
  placeholder: string;
  /** The real credential. */
  secret: string;
}

/**
 * The proxy's entire configuration. The proxy holds it in memory only, and
 * has none of it until the orchestrator pushes.
 */
export interface EgressPolicy {
  /**
   * Hostnames a box may reach. Empty means every public host, which is
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

// --- code review over a box's workspace ---------------------------------

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

/**
 * One repository the workspace holds.
 *
 * A review is over the workspace rather than over one repository in it, so
 * these describe the paths in the tree.
 */
export interface ReviewRepo {
  /**
   * Where it sits relative to the workspace, slash-separated. Empty when the
   * workspace is itself the repository.
   */
  path: string;
  /** What to call it: its own directory name. */
  name: string;
  /** The commit its HEAD names, or '' before its first commit. */
  head: string;
  /**
   * What the review's base revision resolved to here, or '' when there is no
   * base or the revision names nothing in this repository — in which case it
   * is compared against its own working tree.
   */
  baseCommit: string;
}

/**
 * The revision a review is compared against: one expression for the whole
 * workspace, resolved independently in each repository. `main` means
 * main-in-each, through the merge base with that repository's own HEAD.
 *
 * Empty means each repository's own working tree, which is the default. Where
 * it landed is on {@link ReviewRepo.baseCommit}.
 */
export interface ReviewBase {
  /** What the user asked for: a branch, a tag, a short id. */
  rev: string;
}

/**
 * One entry of a review directory: a file, or a folder of them.
 *
 * A file carries its own git status and its own comment count. A folder
 * carries what its whole subtree holds, so a closed one still says there is
 * something inside it to look at. The optional fields are absent rather than
 * empty, because a directory of a thousand files goes to a phone.
 */
export interface ReviewDirEntry {
  /** The entry's own name inside its directory. */
  name: string;
  /** Path relative to the workspace, slash-separated. */
  path: string;
  /** True for a folder. */
  isDir: boolean;
  /** A file's git status. Absent when it has none, and on a folder. */
  status?: ReviewFileStatus;
  /** How many comments a file has. Absent when it has none, and on a folder. */
  comments?: number;
  /** True on a folder whose subtree holds a changed file. Absent elsewhere. */
  changed?: boolean;
  /** True on a folder whose subtree holds a commented file. Absent elsewhere. */
  commented?: boolean;
  /** True on the folder a repository is rooted at. Absent elsewhere. */
  repo?: boolean;
}

/**
 * What a review is, apart from the files: which repositories the workspace
 * holds, what they are compared against, and whether there is a review at all.
 *
 * Every directory answer carries them, so the first screen is one request and
 * the header never waits on a second.
 */
export interface ReviewFacts {
  /** Every repository the workspace holds, sorted by path. */
  repos: ReviewRepo[];
  /** False when the workspace holds no repository at all. */
  hasGit: boolean;
  base: ReviewBase;
  /** True when the workspace holds a REVIEW.md. */
  hasReview: boolean;
  /** The date the review was started, or '' when there is no review yet. */
  started: string;
  /** How many comments the whole review holds, over every file. */
  commentCount: number;
}

/** One directory of the review, and the facts the whole view needs. */
export interface ReviewDirResponse extends ReviewFacts {
  /** The directory listed, relative to the workspace. Empty for the root. */
  path: string;
  /** Its children: folders first, then files, each in name order. */
  entries: ReviewDirEntry[];
  /** True when this directory hit the entry cap and the rest were left out. */
  truncated: boolean;
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
  /** The file's path, relative to the workspace. */
  path: string;
  /**
   * The path of the repository this file belongs to, or null when no
   * repository claims it — in which case it has no status and no diff.
   */
  repo: string | null;
  /** Plain text; the browser tokenizes it. */
  content: string;
  /**
   * A hash of the file as it was read, which a save sends back so a write
   * over an agent's edit is refused rather than made. Empty for a file that
   * is not there.
   */
  hash: string;
  /** True when the file was longer than the cap and the rest was dropped. */
  truncated: boolean;
  /** True when the file holds a NUL byte, in which case content is empty. */
  binary: boolean;
  /**
   * True when the change under review deleted the file. The tree still lists
   * it, and there is nothing on disk to show.
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

/** Body of a create-or-update annotation request. */
export interface ReviewAnnotationBody {
  path: string;
  line: number;
  comment: string;
}

/**
 * Body of a save-file request.
 *
 * `hash` is what the browser last read, and the save is refused when the file
 * on disk no longer matches it.
 */
export interface ReviewFileBody {
  path: string;
  content: string;
  hash: string;
}

/** Body of a set-base request. Null clears the base back to the working tree. */
export interface ReviewBaseBody {
  rev: string | null;
}

/**
 * What setting a base answers with: the expression, and where it landed in
 * each repository — a revision can resolve in one and name nothing in another,
 * and the picker says so.
 */
export interface ReviewBaseResponse {
  rev: string;
  repos: ReviewRepo[];
}

// --- agent configuration ----------------------------------------------------

/**
 * The id of the set that is applied to every box.
 *
 * There is exactly one, seeded by the migration that creates the table.
 */
export const GLOBAL_AGENT_SET = 'global';

/** What an item of an agent set becomes inside the box container. */
export type AgentItemKind = 'skill' | 'command';

/** One skill or one slash command, as stored and as the API reports it. */
export interface AgentItem {
  kind: AgentItemKind;
  /**
   * The name the agent sees: a skill's directory (`skills/<name>/SKILL.md`) and
   * a command's file (`commands/<name>.md`), which is also what invokes it as
   * `/<name>`. Lowercase, digits and dashes, so it is a safe path component.
   */
  name: string;
  /** The file's whole content: a SKILL.md, or a command's markdown. */
  content: string;
  updatedAt: number;
}

/** An agent set as the list endpoint reports it, without the content. */
export interface AgentSetSummary {
  id: string;
  name: string;
  /** True for the one set every box gets. It cannot be deleted. */
  global: boolean;
  /** True when this set contributes an AGENTS.md of its own. */
  hasAgentsMd: boolean;
  skillCount: number;
  commandCount: number;
  /** How many live boxes were created with this set selected. */
  boxCount: number;
  createdAt: number;
  updatedAt: number;
}

/** An agent set with everything in it, which is what the editor loads. */
export interface AgentSetDetail extends AgentSetSummary {
  /** This set's own AGENTS.md, or '' when it contributes none. */
  agentsMd: string;
  /** Its skills and commands, by kind and then by name. */
  items: AgentItem[];
}

/** Body of a create-set request. */
export interface CreateAgentSetBody {
  name: string;
}

/** Body of a set update. An absent field is left as it stands. */
export interface UpdateAgentSetBody {
  name?: string;
  agentsMd?: string;
}

/** Body of an item write. Creates the item, or replaces it under its name. */
export interface AgentItemBody {
  kind: AgentItemKind;
  name: string;
  content: string;
}

/**
 * What one box's merged configuration comes to: the global set, with the
 * selected set laid over it.
 */
export interface AgentBundlePreview {
  /** The global AGENTS.md and the set's, joined by a blank line. */
  agentsMd: string;
  items: AgentItem[];
  /** Names the selected set took over from the global one, by kind. */
  overrides: Array<{ kind: AgentItemKind; name: string }>;
}

// --- the gateway's own ACP extensions ---------------------------------------

/**
 * Notification the gateway sends a browser about the thread it is watching:
 * whether a prompt turn is running, whether the agent is talking, and what it
 * has left running in the background.
 *
 * ACP has no method for this: a client learns a turn is running by awaiting
 * the prompt it sent, which a browser that navigated away and came back never
 * sent. Sent to each browser after its replay, and again on every transition.
 *
 * The underscore is ACP's extension prefix, and a notification takes no
 * reply, so a client that has never heard of this ignores it.
 */
export const TURN_STATE_METHOD = '_boxes/turn_state';

/**
 * Params of a `_boxes/turn_state` notification: everything the gateway knows
 * about what a thread is doing that a browser cannot work out for itself.
 */
export interface TurnStateParams {
  /** The adapter's own id for the thread, as every ACP message names it. */
  sessionId: string;
  /**
   * True while a prompt the gateway forwarded is still open on that thread.
   *
   * The adapter holds a prompt open until the background subagents its turn
   * spawned settle, so this stays true after the agent has gone quiet.
   */
  active: boolean;
  /** True while the agent is producing output on that thread, now. */
  speaking: boolean;
  /**
   * What this conversation has left running in the box, and nothing another
   * conversation left there.
   */
  background: BackgroundProcess[];
}

/**
 * Notification the gateway sends a browser when it opens a thread, saying
 * whether what follows was picked up where the browser said it could be.
 *
 * It arrives before any of the updates, so a browser that is about to be
 * sent the thread whole knows to drop what it holds before the first of them
 * lands, and a browser that is being sent only a tail knows to keep what it
 * holds. Nothing else in the stream tells the two apart.
 *
 * The underscore is ACP's extension prefix, and a notification takes no
 * reply, so a client that has never heard of this ignores it.
 */
export const REPLAY_METHOD = '_boxes/replay';

/** Params of a `_boxes/replay` notification. */
export interface ReplayParams {
  /** The adapter's own id for the thread being opened. */
  sessionId: string;
  /**
   * True when what follows starts at the browser's resume point. False when
   * it is the whole thread, which is the answer whenever the point was not
   * asked for or the gateway no longer holds the message it names.
   */
  resumed: boolean;
}

/**
 * The `_meta` key a browser puts its own `session/load` options under.
 *
 * ACP reserves `_meta` for extensions, and the adapter reads its own key
 * there, so a key of Boxes' own reaches the gateway without either side
 * having to strip it.
 */
export const BOXES_META = 'boxes';

/** What a browser may ask of a `session/load`, under `_meta.boxes`. */
export interface LoadMeta {
  /**
   * The adapter's id for the last message the browser holds. The gateway
   * sends the thread from that message onward; absent, it sends the thread
   * whole.
   */
  resumeFrom?: string;
}
