/**
 * REST API shapes shared by the orchestrator handlers and the dashboard's
 * api.ts. Importing this from both sides is what keeps the API boundary from
 * drifting silently (plan §4).
 */

/** Lifecycle status of a Boxes session. Mirrors the `status` column. */
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
   * Bearer token acp-ui must be configured with; rides the WS subprotocol.
   * Present on the list so the dashboard can connect straight from a card with
   * no per-session round trip. Global rather than per-session, and already
   * behind the same basicauth as the rest of /api.
   *
   * The endpoint URL is deliberately not here: the dashboard, acp-ui and the
   * gateway are all served by the orchestrator, so the browser derives it from
   * its own location (dashboard/src/acpui.ts) and no deployment setting can
   * make it wrong.
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

export interface CreateSessionBody {
  name: string;
  /** https:// only; validated server-side. */
  repoUrl?: string;
  profile?: string;
}

export interface AcpLogEntry {
  id: number;
  direction: 'up' | 'down' | 'stderr';
  ts: number;
  payload: string;
}

export interface AcpLogPage {
  entries: AcpLogEntry[];
  /** Pass as `after` to poll for newer entries. */
  cursor: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  sessions: number;
  /** Session ids whose network is missing the egress proxy (plan §8.4). */
  proxyWarnings: string[];
}

export interface ApiError {
  error: string;
}
