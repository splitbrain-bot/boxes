import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertAgent, type AgentFields } from './acpui.ts';

/**
 * Reads a stored config the way acp-ui does, ignoring any value without an
 * agents record. Every assertion below runs against this, so the tests hold
 * acp-ui's reading of the output rather than its shape.
 */
function readBack(raw: string | null): Record<string, Record<string, unknown>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.agents) return parsed.agents;
  } catch {
    // fall through
  }
  return {};
}

const fields: AgentFields = {
  name: 'demo (a1b2c3d4)',
  url: 'wss://agents.example.com/ws/sessions/a1b2c3d4/acp',
  token: 'tok-1',
};

test('a fresh browser gets an agent acp-ui can actually read', () => {
  const agents = readBack(upsertAgent(null, fields));
  assert.deepEqual(agents[fields.name], {
    transport: 'websocket',
    url: fields.url,
    headers: { Authorization: 'Bearer tok-1' },
  });
});

test('the entry is keyed by display name, which is how acp-ui labels it', () => {
  const agents = readBack(upsertAgent(null, fields));
  assert.deepEqual(Object.keys(agents), ['demo (a1b2c3d4)']);
});

test('agents acp-ui already stored are left alone', () => {
  const existing = JSON.stringify({
    agents: {
      'my laptop': {
        transport: 'websocket',
        url: 'wss://other/acp',
        headers: { Authorization: 'Bearer other' },
      },
    },
  });
  const agents = readBack(upsertAgent(existing, fields));
  assert.equal(Object.keys(agents).length, 2);
  assert.deepEqual(agents['my laptop'], {
    transport: 'websocket',
    url: 'wss://other/acp',
    headers: { Authorization: 'Bearer other' },
  });
  assert.equal(agents[fields.name]?.['url'], fields.url);
});

test('reconnecting the same session updates in place rather than duplicating', () => {
  const first = upsertAgent(null, fields);
  const second = upsertAgent(first, { ...fields, url: 'wss://new/acp', token: 'tok-2' });
  const agents = readBack(second);
  assert.equal(Object.keys(agents).length, 1);
  assert.equal(agents[fields.name]?.['url'], 'wss://new/acp');
  assert.deepEqual(agents[fields.name]?.['headers'], { Authorization: 'Bearer tok-2' });
});

test('fields acp-ui added to our entry survive a rewrite', () => {
  const existing = JSON.stringify({
    agents: {
      [fields.name]: {
        transport: 'websocket',
        url: 'wss://stale/acp',
        headers: { Authorization: 'Bearer stale', 'X-Extra': 'keep' },
        lastUsed: 12345,
      },
    },
  });
  const entry = readBack(upsertAgent(existing, fields))[fields.name];
  assert.equal(entry?.['lastUsed'], 12345);
  assert.deepEqual(entry?.['headers'], { Authorization: 'Bearer tok-1', 'X-Extra': 'keep' });
  assert.equal(entry?.['url'], fields.url);
});

test('unknown top-level keys are preserved for forward compatibility', () => {
  const existing = JSON.stringify({ agents: {}, someFutureSetting: true });
  const stored = JSON.parse(upsertAgent(existing, fields)) as Record<string, unknown>;
  assert.equal(stored['someFutureSetting'], true);
});

test('a corrupt stored value is replaced with something readable', () => {
  const agents = readBack(upsertAgent('not json at all', fields));
  assert.equal(agents[fields.name]?.['url'], fields.url);
});

test('a stored value with a non-record agents field is replaced', () => {
  const agents = readBack(upsertAgent(JSON.stringify([{ id: 'boxes-x' }]), fields));
  assert.equal(agents[fields.name]?.['url'], fields.url);
});
