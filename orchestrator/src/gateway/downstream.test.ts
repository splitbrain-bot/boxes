import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkUpgrade } from './downstream.ts';
import type { Config } from '../config.ts';

const TOKEN = 'a'.repeat(64);
const cfg = { WS_AUTH_TOKEN: TOKEN } as Config;

test('accepts an upgrade offering acp.v1 and the right bearer token', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN}`, cfg);
  assert.deepEqual(result, { ok: true, select: 'acp.v1' });
});

test('tolerates whitespace and ordering in the subprotocol list', () => {
  const result = checkUpgrade(`bearer.${TOKEN} ,acp.v1`, cfg);
  assert.deepEqual(result, { ok: true, select: 'acp.v1' });
});

test('rejects a missing acp.v1 subprotocol', () => {
  const result = checkUpgrade(`bearer.${TOKEN}`, cfg);
  assert.equal(result.ok, false);
});

test('rejects a missing bearer entry', () => {
  const result = checkUpgrade('acp.v1', cfg);
  assert.equal(result.ok, false);
});

test('rejects a wrong token', () => {
  const result = checkUpgrade(`acp.v1, bearer.${'b'.repeat(64)}`, cfg);
  assert.equal(result.ok, false);
});

test('rejects a token that is a prefix of the real one', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN.slice(0, 32)}`, cfg);
  assert.equal(result.ok, false);
});

test('rejects a token with the real one as a prefix', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN}extra`, cfg);
  assert.equal(result.ok, false);
});

test('rejects an absent header', () => {
  const result = checkUpgrade(undefined, cfg);
  assert.equal(result.ok, false);
});
