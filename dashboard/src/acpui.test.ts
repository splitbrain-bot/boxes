import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertAgent, type AgentFields } from './acpui.ts';

const fields: AgentFields = {
  id: 'boxes-a1b2',
  name: 'refactor auth (a1b2)',
  url: 'wss://agents.example.com/ws/sessions/a1b2/acp',
  token: 'tok123',
};

test('seeds a fresh store with a websocket agent and bearer header', () => {
  const out = JSON.parse(upsertAgent(null, fields)) as Array<Record<string, unknown>>;
  assert.equal(out.length, 1);
  assert.equal(out[0]!['url'], fields.url);
  assert.equal(out[0]!['transport'], 'websocket');
  assert.deepEqual(out[0]!['headers'], { Authorization: 'Bearer tok123' });
});

test('appends to an existing array without disturbing other agents', () => {
  const existing = JSON.stringify([{ id: 'other', name: 'Other', url: 'wss://x/1' }]);
  const out = JSON.parse(upsertAgent(existing, fields)) as Array<Record<string, unknown>>;
  assert.equal(out.length, 2);
  assert.equal(out[0]!['id'], 'other');
  assert.equal(out[1]!['url'], fields.url);
});

test('clones the shape of an entry acp-ui already stores', () => {
  // acp-ui uses `address` rather than `url` here; our entry must match.
  const existing = JSON.stringify([
    { id: 'other', label: 'Other', address: 'wss://x/1', kind: 'ws', extra: 7 },
  ]);
  const out = JSON.parse(upsertAgent(existing, fields)) as Array<Record<string, unknown>>;
  const added = out[1]!;
  assert.equal(added['address'], fields.url, 'uses the alias the store already uses');
  assert.equal(added['label'], fields.name);
  assert.equal(added['kind'], 'ws', 'unknown fields are carried over from the template');
  assert.equal(added['extra'], 7);
  assert.equal(added['url'], undefined, 'does not invent a second url field');
});

test('updates in place when the session is already configured', () => {
  const first = upsertAgent(null, fields);
  const out = JSON.parse(upsertAgent(first, { ...fields, token: 'rotated' })) as Array<
    Record<string, unknown>
  >;
  assert.equal(out.length, 1, 'no duplicate entry');
  assert.deepEqual(out[0]!['headers'], { Authorization: 'Bearer rotated' });
});

test('matches an existing entry by url even when the id differs', () => {
  const existing = JSON.stringify([{ id: 'manually-added', name: 'Mine', url: fields.url }]);
  const out = JSON.parse(upsertAgent(existing, fields)) as unknown[];
  assert.equal(out.length, 1, 'updates the manual entry instead of duplicating it');
});

test('preserves a { agents: [...] } container', () => {
  const existing = JSON.stringify({ version: 2, agents: [], theme: 'dark' });
  const parsed = JSON.parse(upsertAgent(existing, fields)) as Record<string, unknown>;
  assert.equal(parsed['version'], 2);
  assert.equal(parsed['theme'], 'dark');
  assert.equal((parsed['agents'] as unknown[]).length, 1);
});

test('preserves a record-keyed container', () => {
  const existing = JSON.stringify({ other: { id: 'other', name: 'Other', url: 'wss://x/1' } });
  const parsed = JSON.parse(upsertAgent(existing, fields)) as Record<string, Record<string, unknown>>;
  assert.ok(parsed['other'], 'other agent kept');
  assert.equal(parsed['boxes-a1b2']!['url'], fields.url);
});

test('preserves other headers already configured on the template', () => {
  const existing = JSON.stringify([
    { id: 'other', name: 'Other', url: 'wss://x/1', headers: { 'X-Trace': '1' } },
  ]);
  const out = JSON.parse(upsertAgent(existing, fields)) as Array<Record<string, unknown>>;
  assert.deepEqual(out[1]!['headers'], { 'X-Trace': '1', Authorization: 'Bearer tok123' });
});

test('recovers from a corrupt stored value instead of throwing', () => {
  const out = JSON.parse(upsertAgent('not json at all', fields)) as unknown[];
  assert.equal(out.length, 1);
});
