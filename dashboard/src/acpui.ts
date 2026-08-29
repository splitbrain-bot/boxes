import type { SessionSummary } from '../../shared/types.ts';

/**
 * One-click connect.
 *
 * acp-ui keeps its agent list in per-origin `localStorage` under
 * `acp-ui:agents` and has no URL-prefill mechanism (plan §2). But acp-ui is
 * served at `/ui` on the same host as this dashboard, so it is the *same
 * origin* — which means we can write its config for it and then navigate
 * there. That turns the plan's "one-time copy/paste per device" onboarding
 * into a button.
 *
 * The container and entry shapes below are the one thing here that depends on
 * acp-ui's internals. Two things keep that from being fragile:
 *   1. `frontend/Dockerfile` asserts at build time that STORAGE_KEY actually
 *      appears in the built bundle, so a key rename fails the image build
 *      loudly instead of producing a button that silently does nothing.
 *   2. When acp-ui has already stored an agent, we clone *that* entry's shape
 *      rather than imposing ours, so the format is correct by construction
 *      from then on.
 */

/** Verified in plan §2. Asserted against the bundle at image build time. */
export const STORAGE_KEY = 'acp-ui:agents';

/** Where acp-ui is mounted (compose routes PathPrefix `/ui` to it). */
export const ACP_UI_PATH = '/ui';

export interface AgentFields {
  id: string;
  name: string;
  url: string;
  token: string;
}

/** Field-name aliases, so a clone target is updated whichever name it uses. */
const URL_KEYS = ['url', 'address', 'endpoint', 'uri', 'wsUrl'];
const NAME_KEYS = ['name', 'label', 'title'];

type Entry = Record<string, unknown>;

/**
 * The shape we write when acp-ui has stored nothing yet: a websocket agent
 * with an `Authorization: Bearer` header. Per plan §2, acp-ui turns that
 * header into the `bearer.<token>` subprotocol entry, because browsers cannot
 * set real headers on a WebSocket.
 */
function defaultEntry(fields: AgentFields): Entry {
  return {
    id: fields.id,
    name: fields.name,
    transport: 'websocket',
    url: fields.url,
    headers: { Authorization: `Bearer ${fields.token}` },
  };
}

/** Applies our values onto an entry, honouring whichever field names it uses. */
function applyFields(entry: Entry, fields: AgentFields): Entry {
  const out: Entry = { ...entry };

  const urlKey = URL_KEYS.find((k) => k in out) ?? 'url';
  out[urlKey] = fields.url;

  const nameKey = NAME_KEYS.find((k) => k in out) ?? 'name';
  out[nameKey] = fields.name;

  if ('id' in out || !('id' in entry)) out['id'] = fields.id;

  const auth = `Bearer ${fields.token}`;
  const existingHeaders = out['headers'];
  out['headers'] =
    existingHeaders && typeof existingHeaders === 'object' && !Array.isArray(existingHeaders)
      ? { ...(existingHeaders as Record<string, unknown>), Authorization: auth }
      : { Authorization: auth };

  return out;
}

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Does this entry already represent the given session? */
function matches(entry: Entry, fields: AgentFields): boolean {
  if (entry['id'] === fields.id) return true;
  return URL_KEYS.some((k) => entry[k] === fields.url);
}

/**
 * Upserts our agent into acp-ui's stored config, preserving whatever
 * container shape it uses (bare array, `{agents: [...]}`, or a record keyed
 * by id) and whatever entry shape its own entries use.
 *
 * Pure, so it can be tested without a DOM. Returns the JSON to store.
 */
export function upsertAgent(raw: string | null, fields: AgentFields): string {
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt or foreign value: start clean rather than throwing away the
      // user's ability to connect.
      parsed = null;
    }
  }

  // Container: { agents: [...] }
  if (isEntry(parsed) && Array.isArray(parsed['agents'])) {
    const agents = upsertIntoArray(parsed['agents'] as unknown[], fields);
    return JSON.stringify({ ...parsed, agents });
  }

  // Container: bare array
  if (Array.isArray(parsed)) {
    return JSON.stringify(upsertIntoArray(parsed, fields));
  }

  // Container: record keyed by agent id
  if (isEntry(parsed)) {
    const entries = Object.values(parsed).filter(isEntry);
    const template = entries.find((e) => matches(e, fields)) ?? entries[0];
    return JSON.stringify({
      ...parsed,
      [fields.id]: applyFields(template ?? defaultEntry(fields), fields),
    });
  }

  // Nothing stored yet.
  return JSON.stringify([defaultEntry(fields)]);
}

function upsertIntoArray(list: unknown[], fields: AgentFields): unknown[] {
  const entries = list.filter(isEntry);
  const existingIndex = list.findIndex((e) => isEntry(e) && matches(e, fields));
  // Clone the shape of whatever acp-ui already stores, so we match its format
  // rather than imposing ours.
  const template = existingIndex >= 0 ? (list[existingIndex] as Entry) : entries[0];
  const entry = applyFields(template ?? defaultEntry(fields), fields);

  if (existingIndex >= 0) {
    const next = [...list];
    next[existingIndex] = entry;
    return next;
  }
  return [...list, entry];
}

export function agentFieldsFor(session: SessionSummary): AgentFields {
  return {
    id: `boxes-${session.id}`,
    name: `${session.name} (${session.id})`,
    url: session.wsUrl,
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
