/**
 * Types and constants shared by the orchestrator, the dashboard and the proxy.
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

/** An agent harness a box can run. */
export type HarnessId = 'claude' | 'codex';

/** A credential the deployment holds, named by the service it authenticates to. */
export type CredentialId = 'claude' | 'openai' | 'github' | 'gitlab' | 'devtunnels';

/**
 * How a credential was obtained, which decides what the secret is: a token
 * pasted from `claude setup-token`, an API key, or the whole JSON document a
 * CLI wrote when somebody logged in.
 */
export type CredentialMethod = 'token' | 'api_key' | 'oauth';

/** Whether a stored credential is believed to work. */
export type CredentialStatus = 'ok' | 'expired' | 'failing';

/** One stored credential as the API reports it, without the secret. */
export interface CredentialSummary {
  /** Which credential this is. */
  id: CredentialId;
  /** How it was obtained. */
  method: CredentialMethod;
  /**
   * What a person recognises the credential by: the account name a login
   * reported, or the last four characters of a pasted secret.
   */
  account: string | null;
  /** Whether it is believed to work. */
  status: CredentialStatus;
  /** Why it last failed, or null. */
  lastError: string | null;
  /** When the secret stops working, in epoch milliseconds, or null for a static one. */
  expiresAt: number | null;
  /** When it was last refreshed, in epoch milliseconds, or null if it never has been. */
  refreshedAt: number | null;
  /** When it was last stored, in epoch milliseconds. */
  updatedAt: number;
}

/** What one harness needs before a thread on it can run, and whether it has it. */
export interface HarnessHealth {
  /** Which harness this is. */
  id: HarnessId;
  /** What the dashboard calls it. */
  label: string;
  /** Null when no credential is stored for this harness. */
  credential: CredentialSummary | null;
  /** True when a thread of this harness can run a turn right now. */
  runnable: boolean;
}

/**
 * The modes an adapter advertises for a thread, and the one it is in. The
 * shape is ACP's, as the `session/new`, `session/load` and `session/fork`
 * answers carry it.
 */
export interface ThreadModeState {
  /** The mode the thread is in. */
  currentModeId: string;
  /** Every mode the adapter offers. */
  availableModes: Array<{ id: string; name?: string; description?: string | null }>;
}

/** One thread setting the adapter lets a client change, and its current value. */
export interface ThreadConfigOption {
  /** The adapter's id for the option. */
  id: string;
  /** What the option is called. */
  name?: string;
  /** What the adapter says the option does, where it says anything. */
  description?: string | null;
  /**
   * `select` carries an options list; another kind carries none. Absent means
   * a select, which is what both adapters send for everything they offer.
   */
  type?: string;
  /**
   * What the option is for. The gateway finds the model selector by it, and
   * leaves the option that echoes the mode out of a thread's config map,
   * because the mode travels through `session/set_mode` alone.
   */
  category?: string | null;
  /** The value the option has now. */
  currentValue?: string;
  /** The values a select offers. */
  options?: Array<{ value: string; name?: string; description?: string | null }>;
}

/**
 * What one harness's adapter last advertised, cached against the harness.
 *
 * A dialog offers these before the thread exists, so it cannot ask the
 * adapter. The adapter corrects them on the thread's first answer.
 */
export interface HarnessCatalog {
  /** The modes of the last answer, or null when it carried none. */
  modes: ThreadModeState | null;
  /** The config options of the last answer; empty when it carried none. */
  configOptions: ThreadConfigOption[];
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
 * the same settings from any device. The dashboard writes and reads it; the
 * orchestrator only stores it.
 */
export interface ThreadDialogDefaults {
  /** The mode chosen last. */
  modeId?: string;
  /** The config option values chosen last, by option id. */
  config?: Record<string, string>;
}

/**
 * The deployment's plain settings: everything that is configuration rather
 * than a secret.
 */
export interface Settings {
  /** The name every box commits as. */
  gitName: string;
  /** The email address every box commits as. */
  gitEmail: string;
  /** What the thread dialogs last chose, by harness id. */
  dialogs: Record<string, ThreadDialogDefaults>;
}

/** Body of a request to store a credential by pasting its secret. */
export interface PutCredentialBody {
  /** What kind of secret this is. */
  method: CredentialMethod;
  /** The pasted secret. */
  secret: string;
}

/**
 * Where a login stands, as the settings page polls it.
 *
 * A login runs the harness's own CLI in a throwaway container. Codex prints a
 * URL and a one-time code and then waits on its own. Claude prints a URL and
 * then waits for the person to paste back the code the login page gave them.
 */
export type LoginState =
  /** The CLI has not shown a URL yet. */
  | { state: 'starting' }
  /** The CLI is waiting for a browser. `code` is Codex's one-time code, where there is one. */
  | { state: 'awaiting_browser'; url: string; code: string | null }
  /**
   * The CLI is blocked on a code the page has to paste back. `error` is what
   * it said about the last code it refused, so a rejection is visible rather
   * than looking like nothing happened; null until one is refused.
   */
  | { state: 'awaiting_code'; url: string; error: string | null }
  /** The credential is stored. */
  | { state: 'done' }
  /** The login ended badly. `error` says why, in a sentence worth showing. */
  | { state: 'failed'; error: string };

/** What starting a login answers with: the id every later call names. */
export interface StartLoginResponse {
  /** The login's id. */
  loginId: string;
}

/** Body of the paste-back: the code the login page gave the person. */
export interface LoginCodeBody {
  /** The code, as pasted. */
  code: string;
}

/**
 * One task a conversation has left running in its box, as its adapter
 * announced it.
 *
 * The adapter sends a spawn when the task starts and a state update when it
 * ends. A task whose end nobody hears is dropped when its adapter process
 * exits.
 */
export interface BackgroundProcess {
  /** The adapter's asyncTaskId, which is what a stop names. */
  id: string;
  /** What the adapter calls the task: the command for a shell, a description otherwise. */
  command: string;
  /** `shell`, `workflow`, `monitor` or `task` from Claude; `shell` from Codex. */
  kind: string;
  /** `canStop` from the spawn. */
  stoppable: boolean;
  /** When the spawn arrived, in epoch milliseconds. */
  startedAt: number;
}

/**
 * One process that a reading of a box's process table found running.
 *
 * It names no task and belongs to no conversation. It explains a busy box
 * whose task bars are empty.
 */
export interface BoxWork {
  /**
   * The pid as the reading saw it, which tells two identical command lines
   * apart. A stop does not signal this pid: it looks the pid up again inside
   * the box.
   */
  pid: number;
  /** The whole command line, which is how a process is recognised. */
  command: string;
  /** How long it has been running, or null where `ps` would not say. */
  elapsedSeconds: number | null;
}

/** One conversation of a box, as the API reports it. */
export interface ThreadSummary {
  /** The thread's id. */
  id: string;
  /**
   * Which agent runs this conversation. It is set per thread, so two agents
   * can work on one checkout.
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
   * option that echoes the mode is never in here.
   */
  config: Record<string, string>;
  /**
   * True when this thread's adapter advertised `sessionCapabilities.fork` in
   * its `initialize` answer. False while the adapter has not been reached.
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
  /** The thread's number within its box, never reused. It names an untitled thread. */
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
   * Whether the reader has marked this conversation as finished. The mark
   * only affects the list: a thread marked done still takes prompts.
   */
  done: boolean;
  /** When the thread was created, in epoch milliseconds. */
  createdAt: number;
  /** When the thread was last active, in epoch milliseconds. */
  lastActiveAt: number;
}

/** One port of a dev tunnel a box hosts, as the box's views show it. */
export interface BoxTunnel {
  /** The tunnel id. */
  id: string;
  /** The region the tunnel lives in, such as `euw`. */
  cluster: string;
  /** The port in the box the tunnel forwards to. */
  port: number;
  /** The public URL of that port. */
  url: string;
}

/** A box as returned by the list endpoint. */
export interface BoxSummary {
  /** The box's id. */
  id: string;
  /** The name the user gave the box. */
  name: string;
  /** The profile stored with the box. */
  profile: string;
  /** Lifecycle status, as stored. */
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
   * Whether the box still has work running in it, such as a command left
   * running or a monitor, with no turn to say so. What is running, and which
   * thread owns it, is on {@link TurnStateParams.background}.
   */
  backgroundBusy: boolean;
  /**
   * How many pieces of background work the box has running: the tasks its
   * adapters announced, or what the box reading found where none did. Zero
   * while {@link backgroundBusy} is false.
   */
  backgroundCount: number;
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
   * The agent set selected when this box was created, or null for the
   * global set alone. Null is also what a box whose set has since been
   * deleted reports.
   */
  agentSetId: string | null;
  /** That set's current name, for the UI. Null whenever `agentSetId` is. */
  agentSetName: string | null;
  /**
   * How much disk this box takes up, in bytes: its workspace, its home and its
   * Nix store together. Null when there is no measurement yet, or no directory
   * to measure.
   *
   * The value is the last measurement, so it lags. A running box is measured
   * again at most every fifteen minutes, and a stopped one is not measured
   * again.
   */
  diskBytes: number | null;
  /**
   * The dev tunnel ports the box hosts, as the orchestrator read them at its
   * last minute tick. Empty when it hosts none.
   */
  tunnels: BoxTunnel[];
  /** When the box was created, in epoch milliseconds. */
  createdAt: number;
  /** When the box was last active, in epoch milliseconds. */
  lastActiveAt: number;
}

/** A single box with the extra detail the detail view needs. */
export interface BoxDetail extends BoxSummary {
  /** The image the box's container runs. */
  image: string;
  /** The Docker container's id, or null while there is none. */
  containerId: string | null;
  /** The box's own Docker network. */
  networkName: string;
  /** The subnet of that network. */
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
  /** The adapter's id for the box's most recently active thread, or null before one exists. */
  acpSessionId: string | null;
  /** True when the egress proxy is attached to this box's network. */
  proxyAttached: boolean;
  /**
   * What the last reading found running in the box, which is what the
   * box-wide stop would signal. Empty for a box that is not up or has not
   * been read yet. It is on the detail only, because the list polls every box
   * at once.
   */
  boxWork: BoxWork[];
}

/**
 * What a new thread is to run and be configured with. An absent field means
 * the harness's own default.
 */
export interface ThreadOptions {
  /** The agent the thread runs. */
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
  /** True to mark the thread done, false to take the mark off. */
  done: boolean;
}

/** Body of a create-box request. */
export interface CreateBoxBody {
  /** The name the user gives the box. */
  name: string;
  /**
   * Ignored. Every box uses the deployment's one set of credentials. The field
   * is accepted so that older clients still create a box rather than get a 400.
   */
  profile?: string;
  /**
   * Id of the agent set whose AGENTS.md, skills and commands are merged over
   * the global ones for this box. Absent, empty or the global set's id means
   * the global set alone, which every box gets.
   */
  agentSet?: string | null;
  /**
   * What the box's first thread runs. Every box is created with one thread.
   * Absent means Claude on its defaults.
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
  /** The orchestrator's image. */
  orchestrator: ImageInfo | null;
  /** The egress proxy's image. */
  proxy: ImageInfo | null;
  /** The image boxes run. */
  box: ImageInfo | null;
}

/** Answer to a health probe. */
export interface HealthResponse {
  /** Always true: an answer at all means the orchestrator is up. */
  ok: boolean;
  /** The orchestrator's version. */
  version: string;
  /** How many boxes exist that are not deleted. */
  boxes: number;
  /** Box ids whose network is missing the egress proxy. */
  proxyWarnings: string[];
  /** Egress policy state, or null before the first push has been attempted. */
  egress: EgressHealth | null;
  /**
   * Every harness this deployment can run, and whether each has a credential
   * that works. The threads of a harness that is not runnable fail at their
   * first turn.
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
  /** True only when every check passed. */
  ready: boolean;
  /** The orchestrator's version. */
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
  /** The push service URL the browser was given. */
  endpoint: string;
  /** The browser's keys for encrypting messages to it. */
  keys: { p256dh: string; auth: string };
  /** What this browser calls itself, for the deployment's own reference. */
  label?: string;
}

/** Body of any 4xx or 5xx answer from the API. */
export interface ApiError {
  /** What went wrong. */
  error: string;
}

/** One file the user attached to a prompt, as the upload endpoint reports it back. */
export interface StoredAttachment {
  /** The stored file name. It is sanitised, and a collision gets a suffix. */
  name: string;
  /**
   * Path relative to the workspace, slash-separated. A client puts it in the
   * prompt, and the agent uses it in a tool call.
   */
  path: string;
  /** Size in bytes. */
  size: number;
}

// --- egress policy: the orchestrator -> proxy control channel ---------------

/**
 * One credential the proxy swaps in on the wire.
 *
 * A box holds `placeholder`. Only the orchestrator and the proxy hold
 * `secret`. The proxy rewrites a request to one of `hosts` that carries
 * `placeholder` in one of `headers` to carry `secret`. It refuses a request
 * that carries any other value there, unless that value uses one of
 * `passthroughSchemes`.
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
  /**
   * Authorization schemes, lowercased, whose values the host issues itself,
   * such as a token it minted for one resource. A header value under one of
   * these schemes passes unchanged instead of counting as a foreign
   * credential. Absent means none.
   */
  passthroughSchemes?: string[];
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
  /** Hostnames a box may reach. Empty means every public host. */
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
  /** Fingerprint of the applied policy. */
  policyHash: string;
  /** Number of entries in the applied allowlist; 0 means the allowlist is off. */
  allowedHostCount: number;
  /** Ids of the credentials being translated. */
  credentialIds: string[];
  /** Denials since the proxy booted, counted by category. */
  denials: Record<string, number>;
  /** Seconds since the proxy booted. */
  uptimeSeconds: number;
}

/** The egress half of a health probe, as the orchestrator sees the proxy. */
export interface EgressHealth {
  /** True when the proxy applied the last push of the composed policy. */
  inSync: boolean;
  /** True when an allowlist is configured. */
  allowlistActive: boolean;
  /** Credentials being translated, by id. Never the values. */
  credentialIds: string[];
  /** Denials the proxy has counted since it booted, by category. */
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
 * One repository the workspace holds. A review covers the whole workspace,
 * which may hold several.
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
   * base or the revision names nothing in this repository. The working tree
   * is then compared against its own HEAD.
   */
  baseCommit: string;
}

/**
 * The revision a review is compared against: one expression for the whole
 * workspace, resolved independently in each repository. `main` means
 * main-in-each, through the merge base with that repository's own HEAD.
 *
 * Empty compares each repository against its own HEAD, which is the default.
 * Where it landed is on {@link ReviewRepo.baseCommit}.
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
  /** The revision the review compares against. */
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
  /** The line the comment is on, counted from 1. */
  line: number;
  /** The comment's text. */
  comment: string;
  /** True when the code the comment was written against is gone. */
  outdated: boolean;
}

/** A diff hunk, with the range of lines it covers in the current file. */
export interface ReviewDiffHunk {
  /** First line of the current file the hunk covers. */
  startLine: number;
  /** Last line of the current file the hunk covers. */
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
  /** The file's diff hunks. */
  hunks: ReviewDiffHunk[];
  /** Where lines were deleted. */
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
  /** The diff markers for the gutter. */
  diff: ReviewFileDiff;
  /** The file's comments. */
  annotations: ReviewAnnotation[];
}

/** A file's comments, as the mutation endpoints answer with. */
export interface ReviewAnnotationsResponse {
  /** The file's path, relative to the workspace. */
  path: string;
  /** Every comment the file now has. */
  annotations: ReviewAnnotation[];
}

/** Body of a create-or-update annotation request. */
export interface ReviewAnnotationBody {
  /** The file's path, relative to the workspace. */
  path: string;
  /** The line to comment on. */
  line: number;
  /** The comment's text. */
  comment: string;
}

/** Body of a save-file request. */
export interface ReviewFileBody {
  /** The file's path, relative to the workspace. */
  path: string;
  /** The file's new content. */
  content: string;
  /**
   * The hash the browser last read. The save is refused when the file on disk
   * no longer matches it.
   */
  hash: string;
}

/** Body of a set-base request. */
export interface ReviewBaseBody {
  /** The revision to compare against. Null clears the base back to HEAD. */
  rev: string | null;
}

/**
 * What setting a base answers with: the expression, and where it landed in
 * each repository. A revision can resolve in one repository and name nothing
 * in another.
 */
export interface ReviewBaseResponse {
  /** The expression as stored, or '' when the base was cleared. */
  rev: string;
  /** Every repository, with the commit the base resolved to in it. */
  repos: ReviewRepo[];
}

// --- agent configuration ----------------------------------------------------

/**
 * The id of the one set that is applied to every box. The migration that
 * creates the table seeds it.
 */
export const GLOBAL_AGENT_SET = 'global';

/** What an item of an agent set becomes inside the box container. */
export type AgentItemKind = 'skill' | 'command';

/** One skill or one slash command, as stored and as the API reports it. */
export interface AgentItem {
  /** Whether the item is a skill or a command. */
  kind: AgentItemKind;
  /**
   * The name the agent sees: a skill's directory (`skills/<name>/SKILL.md`) and
   * a command's file (`commands/<name>.md`), which is also what invokes it as
   * `/<name>`. Lowercase, digits and dashes, so it is a safe path component.
   */
  name: string;
  /** The file's whole content: a SKILL.md, or a command's markdown. */
  content: string;
  /** When the item was last written, in epoch milliseconds. */
  updatedAt: number;
}

/** An agent set as the list endpoint reports it, without the content. */
export interface AgentSetSummary {
  /** The set's id. */
  id: string;
  /** The name the user gave the set. */
  name: string;
  /** True for the one set every box gets. It cannot be deleted. */
  global: boolean;
  /** True when this set contributes an AGENTS.md of its own. */
  hasAgentsMd: boolean;
  /** How many skills the set holds. */
  skillCount: number;
  /** How many commands the set holds. */
  commandCount: number;
  /** How many live boxes were created with this set selected. */
  boxCount: number;
  /** When the set was created, in epoch milliseconds. */
  createdAt: number;
  /** When the set or one of its items last changed, in epoch milliseconds. */
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
  /** The new set's name. */
  name: string;
}

/** Body of a set update. An absent field is left as it stands. */
export interface UpdateAgentSetBody {
  /** The set's new name. */
  name?: string;
  /** The set's new AGENTS.md. */
  agentsMd?: string;
}

/** Body of an item write. Creates the item, or replaces it under its name. */
export interface AgentItemBody {
  /** Whether the item is a skill or a command. */
  kind: AgentItemKind;
  /** The item's name. */
  name: string;
  /** The item's whole file content. */
  content: string;
}

/**
 * What one box's merged configuration comes to: the global set, with the
 * selected set laid over it.
 */
export interface AgentBundlePreview {
  /** The global AGENTS.md and the set's, joined by a blank line. */
  agentsMd: string;
  /** Every item the box gets, after the selected set's overrides. */
  items: AgentItem[];
  /** Names the selected set took over from the global one, by kind. */
  overrides: Array<{ kind: AgentItemKind; name: string }>;
}

// --- the gateway's own ACP extensions ---------------------------------------

/**
 * Method of the notification the gateway sends a browser about the state of
 * the thread it watches.
 *
 * In ACP, a client learns that a turn is running by awaiting its own prompt.
 * A browser that reconnects never sent that prompt. The gateway sends this
 * after the replay and again on every change. The underscore is ACP's
 * extension prefix, so a client that does not know the method ignores it.
 */
export const TURN_STATE_METHOD = '_boxes/turn_state';

/**
 * Params of a `_boxes/turn_state` notification: what a thread is doing, as far
 * as a browser cannot work it out itself.
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
  /** What this conversation has left running in the box. */
  background: BackgroundProcess[];
}

/**
 * Method of the notification the gateway sends a browser when it opens a
 * thread. It says whether the updates that follow start at the browser's
 * resume point.
 *
 * It arrives before the first update. A browser that gets the whole thread
 * then drops what it holds, and a browser that gets only the tail keeps it.
 * The underscore is ACP's extension prefix, so a client that does not know
 * the method ignores it.
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
  /**
   * True when the gateway no longer holds the start of the thread, so what it
   * sends lacks the oldest messages. A browser can ask for the full history
   * with {@link LoadMeta.full}.
   */
  truncated: boolean;
}

/**
 * The `_meta` key a browser puts its own `session/load` options under. The
 * adapter reads only its own key in `_meta`, so neither side has to strip
 * this one.
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
  /**
   * True to ask for the full history of the thread, which the adapter
   * replays again. The gateway refuses this while the thread works.
   */
  full?: boolean;
}
