import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkUpgrade } from './downstream.ts';

/** The token of the session being connected to. */
const TOKEN = 'a'.repeat(64);

/** The token of some other session of the same deployment. */
const OTHER_TOKEN = 'b'.repeat(64);

test('accepts an upgrade offering acp.v1 and the session own token', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN}`, TOKEN);
  assert.deepEqual(result, { ok: true });
});

test('tolerates whitespace and ordering in the subprotocol list', () => {
  const result = checkUpgrade(`bearer.${TOKEN} ,acp.v1`, TOKEN);
  assert.deepEqual(result, { ok: true });
});

test('rejects a missing acp.v1 subprotocol', () => {
  const result = checkUpgrade(`bearer.${TOKEN}`, TOKEN);
  assert.equal(result.ok, false);
});

test('rejects a missing bearer entry', () => {
  const result = checkUpgrade('acp.v1', TOKEN);
  assert.equal(result.ok, false);
});

test('rejects another session token on this session', () => {
  // The whole point of a token per session: one that opens a box somewhere
  // else in this deployment opens nothing here.
  const result = checkUpgrade(`acp.v1, bearer.${OTHER_TOKEN}`, TOKEN);
  assert.equal(result.ok, false);
});

test('rejects a token no session has', () => {
  const result = checkUpgrade(`acp.v1, bearer.${'c'.repeat(64)}`, TOKEN);
  assert.equal(result.ok, false);
});

test('rejects every token for a session that is not there', () => {
  // A session id nobody holds has no token, so an upgrade to it is refused
  // the way a wrong token is rather than saying the session is missing.
  assert.equal(checkUpgrade(`acp.v1, bearer.${TOKEN}`, null).ok, false);
  assert.equal(checkUpgrade('acp.v1, bearer.', null).ok, false);
});

test('rejects a token that is a prefix of the real one', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN.slice(0, 32)}`, TOKEN);
  assert.equal(result.ok, false);
});

test('rejects a token with the real one as a prefix', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN}extra`, TOKEN);
  assert.equal(result.ok, false);
});

test('rejects an absent header', () => {
  const result = checkUpgrade(undefined, TOKEN);
  assert.equal(result.ok, false);
});
