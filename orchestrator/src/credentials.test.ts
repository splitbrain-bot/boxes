import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { CredentialStore } from './credentials.ts';
import { openDb, type Db } from './db.ts';

/**
 * The credential store: what it keeps, what it never gives back, and that a
 * write is announced — which is what makes a pasted token reach the proxy
 * before the page has finished saving it.
 */

let dir: string;
let db: Db;
let changes: number;
let store: CredentialStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-credentials-'));
  db = openDb(dir);
  changes = 0;
  store = new CredentialStore(db, () => {
    changes += 1;
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a pasted secret is stored whole and shown as its last four characters', () => {
  const row = store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');

  assert.equal(row.secret, 'sk-ant-oat01-abcdefgh1234');
  assert.equal(row.account, '1234');
  assert.equal(row.status, 'ok');
  assert.equal(row.expires_at, null);
  assert.equal(store.get('claude')?.secret, 'sk-ant-oat01-abcdefgh1234');
});

test('a secret with nothing to spare is shown as nothing rather than as itself', () => {
  assert.equal(store.put('github', 'token', 'ghp_').account, null);
});

test('a login passes the account it was told, instead of the derived one', () => {
  const row = store.put('claude', 'oauth', '{"access_token":"a"}', {
    account: 'someone@example.com',
    expires_at: 1000,
  });
  assert.equal(row.account, 'someone@example.com');
  assert.equal(row.expires_at, 1000);
});

test('a replacement keeps the credential created_at and clears the old error', () => {
  const first = store.put('github', 'token', 'ghp_oldtoken');
  store.markStatus('github', 'failing', '401 from GitHub');
  assert.equal(store.get('github')?.status, 'failing');

  const second = store.put('github', 'token', 'ghp_newtoken');
  assert.equal(second.created_at, first.created_at);
  assert.ok(second.updated_at >= first.updated_at);
  // Pasting a new token is the answer to whatever the old one's error said.
  assert.equal(second.status, 'ok');
  assert.equal(second.last_error, null);
  assert.equal(store.list().length, 1);
});

test('a status is recorded without touching the secret', () => {
  store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  store.markStatus('claude', 'expired', 'the token is a year old');

  const row = store.get('claude');
  assert.equal(row?.status, 'expired');
  assert.equal(row?.last_error, 'the token is a year old');
  // Still the token the proxy has to send, and still the one the page names.
  assert.equal(row?.secret, 'sk-ant-oat01-abcdefgh1234');
  assert.equal(row?.account, '1234');
});

test('a summary carries everything but the secret', () => {
  const row = store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  const summary = store.summarize(row);

  assert.deepEqual(summary, {
    id: 'claude',
    method: 'token',
    account: '1234',
    status: 'ok',
    lastError: null,
    expiresAt: null,
    refreshedAt: null,
    updatedAt: row.updated_at,
  });
  assert.ok(!JSON.stringify(summary).includes('sk-ant-oat01-abcdefgh1234'));
});

test('every write is announced, because the policy is composed from these rows', () => {
  store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  assert.equal(changes, 1);
  store.markStatus('claude', 'failing', 'nope');
  assert.equal(changes, 2);
  store.remove('claude');
  assert.equal(changes, 3);
  assert.equal(store.get('claude'), undefined);
});

test('the list is in the order the settings page shows them', () => {
  store.put('github', 'token', 'ghp_therealgithubtoken');
  store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');

  assert.deepEqual(
    store.list().map((r) => r.id),
    ['claude', 'github'],
  );
});
