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

/** A session as returned by the list endpoint. */
export interface SessionSummary {
  id: string;
  name: string;
  profile: string;
  status: SessionStatus;
  /** Live container state, resolved against Docker on every request. */
  dockerState: DockerState;
  /** True while a prompt turn is running upstream. */
  turnActive: boolean;
  /** Permission requests waiting for a browser to answer them. */
  pendingCount: number;
  /** Number of browsers currently attached to the session's /ws route. */
  attachedCount: number;
  /**
   * Bearer token an ACP client authenticates the WebSocket upgrade with,
   * carried in the subprotocol. One token covers the whole deployment, and
   * the list carries it so opening a thread needs no further request.
   */
  wsToken: string;
  createdAt: number;
  lastActiveAt: number;
}

/** A single session with the extra detail the detail view needs. */
export interface SessionDetail extends SessionSummary {
  image: string;
  containerId: string | null;
  networkName: string;
  subnet: string;
  wsVolume: string;
  homeVolume: string;
  acpSessionId: string | null;
  /** True when the egress proxy is attached to this session's network. */
  proxyAttached: boolean;
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
