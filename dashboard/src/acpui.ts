import type { SessionSummary } from '../../shared/types.ts';

/**
 * One-click connect.
 *
 * acp-ui keeps its agent list in per-origin localStorage and has no way to
 * prefill it from a URL. The orchestrator serves acp-ui at /ui and this
 * dashboard at /, so the two share an origin and the dashboard can write that
 * config itself before sending the browser there.
 */

/** acp-ui's own storage key, asserted against the bundle at image build time. */
export const STORAGE_KEY = 'acp-ui:agents';

/** Where the orchestrator serves acp-ui. */
export const ACP_UI_PATH = '/ui';

/** What this dashboard needs to describe one session to acp-ui. */
export interface AgentFields {
  /** Display name, which is also the key of acp-ui's agents record. */
  name: string;
  url: string;
  token: string;
}

/** A JSON object, which is all this module needs to know about acp-ui's shapes. */
type Entry = Record<string, unknown>;

/** True for a JSON object, excluding null and arrays. */
function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the stored config the way acp-ui reads it: anything without an agents
 * record counts as absent. Returns the agents record and the settings beside
 * it.
 */
function parseConfig(raw: string | null): { rest: Entry; agents: Entry } {
  if (!raw) return { rest: {}, agents: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rest: {}, agents: {} };
  }
  if (!isEntry(parsed)) return { rest: {}, agents: {} };
  const { agents, ...rest } = parsed;
  return { rest, agents: isEntry(agents) ? agents : {} };
}

/**
 * Upserts this session into acp-ui's stored config and returns the JSON to
 * store. The entry is keyed by display name, and any field acp-ui added to it
 * survives; only transport, url and the Authorization header are overwritten.
 *
 * acp-ui turns that header into the bearer.<token> subprotocol entry, because
 * a browser cannot set real headers on a WebSocket.
 */
export function upsertAgent(raw: string | null, fields: AgentFields): string {
  const { rest, agents } = parseConfig(raw);
  const previous = agents[fields.name];
  const previousEntry = isEntry(previous) ? previous : {};
  const previousHeaders = previousEntry['headers'];

  return JSON.stringify({
    ...rest,
    agents: {
      ...agents,
      [fields.name]: {
        ...previousEntry,
        transport: 'websocket',
        url: fields.url,
        headers: {
          ...(isEntry(previousHeaders) ? previousHeaders : {}),
          Authorization: `Bearer ${fields.token}`,
        },
      },
    },
  });
}

/**
 * This session's ACP endpoint on the current origin. The dashboard, acp-ui and
 * the gateway are all served by the orchestrator, so the page's own location
 * carries the right scheme and host.
 */
export function wsUrlFor(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/sessions/${sessionId}/acp`;
}

/** Describes one session as an acp-ui agent entry. */
export function agentFieldsFor(session: SessionSummary): AgentFields {
  return {
    name: `${session.name} (${session.id})`,
    url: wsUrlFor(session.id),
    token: session.wsToken,
  };
}

/**
 * Writes the config and navigates to acp-ui. Returns false if storage was
 * unavailable (private mode, disabled cookies), so the caller can fall back
 * to showing the manual details.
 */
export function connectToSession(session: SessionSummary): boolean {
  const fields = agentFieldsFor(session);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    window.localStorage.setItem(STORAGE_KEY, upsertAgent(raw, fields));
  } catch {
    return false;
  }
  window.location.assign(ACP_UI_PATH);
  return true;
}
