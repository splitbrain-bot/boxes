import type { SessionSummary } from '../../shared/types.ts';

/**
 * One-click connect.
 *
 * acp-ui keeps its agent list in per-origin `localStorage` and has no
 * URL-prefill mechanism. The orchestrator serves acp-ui at `/ui` and this
 * dashboard at `/`, so the two are the same origin: we can write that config
 * ourselves and then navigate there. Nothing is typed, on any device.
 *
 * The stored value is acp-ui's own `AgentsConfig`: one object whose `agents`
 * record is keyed by the agent's display name. acp-ui ignores a stored value
 * that has no `agents` record at all, so the container shape matters as much
 * as the entry shape. The orchestrator image build asserts that STORAGE_KEY
 * still appears in the acp-ui bundle, so a rename upstream fails the build
 * rather than shipping a button that silently does nothing.
 */

/** acp-ui's own storage key. Asserted against the bundle at image build time. */
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

type Entry = Record<string, unknown>;

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the stored config the way acp-ui reads it: anything without an
 * `agents` record is treated as absent rather than repaired.
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
 * store. Pure, so it can be tested without a DOM.
 *
 * Fields acp-ui may have added to its own entry are preserved; only the three
 * this dashboard owns are overwritten. Per plan §2, acp-ui turns the
 * `Authorization` header into the `bearer.<token>` subprotocol entry, because
 * browsers cannot set real headers on a WebSocket.
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
 * This session's ACP endpoint on the current origin.
 *
 * Derived from the browser's own location rather than from the API: the
 * dashboard, acp-ui and the gateway are all served by the orchestrator, so the
 * page already knows the right scheme and host. That keeps the button correct
 * with no deployment configuration, behind TLS or on a plain local port.
 */
export function wsUrlFor(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/sessions/${sessionId}/acp`;
}

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
