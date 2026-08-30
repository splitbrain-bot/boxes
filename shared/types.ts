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
  repoUrl: string | null;
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
   * Bearer token acp-ui must be configured with, carried in the WebSocket
   * subprotocol. One token covers the whole deployment, and the list carries
   * it so a card can connect without a further request.
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
  /** https:// only; validated server-side. */
  repoUrl?: string;
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
