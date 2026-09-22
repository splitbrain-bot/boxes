import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ACP_SUBPROTOCOL } from '../../../shared/acp.ts';
import { TERMINAL_SUBPROTOCOL } from '../../../shared/terminal.ts';
import { checkUpgrade } from './downstream.ts';

/** The token of the box being connected to. */
const TOKEN = 'a'.repeat(64);

/** The token of some other box of the same deployment. */
const OTHER_TOKEN = 'b'.repeat(64);

test('accepts an upgrade offering acp.v1 and the box own token', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN}`, TOKEN, ACP_SUBPROTOCOL);
  assert.deepEqual(result, { ok: true });
});

test('tolerates whitespace and ordering in the subprotocol list', () => {
  const result = checkUpgrade(`bearer.${TOKEN} ,acp.v1`, TOKEN, ACP_SUBPROTOCOL);
  assert.deepEqual(result, { ok: true });
});

test('rejects a missing acp.v1 subprotocol', () => {
  const result = checkUpgrade(`bearer.${TOKEN}`, TOKEN, ACP_SUBPROTOCOL);
  assert.equal(result.ok, false);
});

test('rejects a missing bearer entry', () => {
  const result = checkUpgrade('acp.v1', TOKEN, ACP_SUBPROTOCOL);
  assert.equal(result.ok, false);
});

test('rejects another box token on this box', () => {
  // The whole point of a token per box: one that opens a box somewhere
  // else in this deployment opens nothing here.
  const result = checkUpgrade(`acp.v1, bearer.${OTHER_TOKEN}`, TOKEN, ACP_SUBPROTOCOL);
  assert.equal(result.ok, false);
});

test('rejects a token no box has', () => {
  const result = checkUpgrade(`acp.v1, bearer.${'c'.repeat(64)}`, TOKEN, ACP_SUBPROTOCOL);
  assert.equal(result.ok, false);
});

test('rejects every token for a box that is not there', () => {
  // A box id nobody holds has no token, so an upgrade to it is refused
  // the way a wrong token is rather than saying the box is missing.
  assert.equal(checkUpgrade(`acp.v1, bearer.${TOKEN}`, null, ACP_SUBPROTOCOL).ok, false);
  assert.equal(checkUpgrade('acp.v1, bearer.', null, ACP_SUBPROTOCOL).ok, false);
});

test('rejects a token that is a prefix of the real one', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN.slice(0, 32)}`, TOKEN, ACP_SUBPROTOCOL);
  assert.equal(result.ok, false);
});

test('rejects a token with the real one as a prefix', () => {
  const result = checkUpgrade(`acp.v1, bearer.${TOKEN}extra`, TOKEN, ACP_SUBPROTOCOL);
  assert.equal(result.ok, false);
});

test('rejects an absent header', () => {
  const result = checkUpgrade(undefined, TOKEN, ACP_SUBPROTOCOL);
  assert.equal(result.ok, false);
});

test('accepts a terminal upgrade offering its own subprotocol', () => {
  const result = checkUpgrade(
    `${TERMINAL_SUBPROTOCOL}, bearer.${TOKEN}`,
    TOKEN,
    TERMINAL_SUBPROTOCOL,
  );
  assert.deepEqual(result, { ok: true });
});

test('rejects each endpoint the handshake the other one makes', () => {
  // The two endpoints are opened by the same token, and what tells them apart
  // is the protocol offered: neither answers a client holding the other's.
  assert.equal(checkUpgrade(`acp.v1, bearer.${TOKEN}`, TOKEN, TERMINAL_SUBPROTOCOL).ok, false);
  assert.equal(
    checkUpgrade(`${TERMINAL_SUBPROTOCOL}, bearer.${TOKEN}`, TOKEN, ACP_SUBPROTOCOL).ok,
    false,
  );
});
