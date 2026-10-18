import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { ApiKeyStore, placeholderFor } from './api-keys.ts';
import { type Db, openDb } from './db.ts';

/** The temporary data directory of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The number of calls of the change callback. */
let changes: number;
/** The store under test. */
let store: ApiKeyStore;

/** A key in the format of OpenRouter. */
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-api-keys-'));
  db = openDb(dir);
  changes = 0;
  store = new ApiKeyStore(db, () => {
    changes += 1;
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a key is stored with its hosts and shown as its last four characters', () => {
  store.put('OPENROUTER_API_KEY', ['OpenRouter.ai', ' openrouter.ai '], KEY);

  const row = store.get('OPENROUTER_API_KEY');
  assert.equal(row?.secret, KEY);
  assert.deepEqual(row?.hosts, ['openrouter.ai']);
  assert.deepEqual(store.summarize(row!), {
    name: 'OPENROUTER_API_KEY',
    hosts: ['openrouter.ai'],
    account: 'cdef',
    updatedAt: row!.updated_at,
  });
  assert.equal(changes, 1);
});

test('a placeholder copies the prefix and the length of the key, never the key', () => {
  const placeholder = placeholderFor(KEY);

  assert.match(placeholder, /^sk-or-v1-[A-Za-z0-9]{32}$/);
  assert.equal(placeholder.length, KEY.length);
  assert.notEqual(placeholder, KEY);
});

test('a placeholder leaves out what looks like the random part of a key', () => {
  // The underscore sits in the random part, after a segment too long for a prefix.
  assert.match(placeholderFor('sk-proj-AbCdEfGhIjK_LmNoPqRsTuVwXyZ'), /^sk-proj-[A-Za-z0-9]+$/);
  assert.match(placeholderFor('abcdefghijklmnop_qrstuv'), /^[A-Za-z0-9]{23}$/);
});

test('a short key gets a placeholder with enough random characters', () => {
  assert.match(placeholderFor('ab-12'), /^ab-[A-Za-z0-9]{16}$/);
});

test('the placeholder stays while the key keeps its shape, and changes with it', () => {
  const first = store.put('OPENROUTER_API_KEY', ['openrouter.ai'], KEY).placeholder;

  const sameShape = KEY.replace('0123', '9999');
  assert.equal(store.put('OPENROUTER_API_KEY', ['openrouter.ai'], sameShape).placeholder, first);

  const longer = `${KEY}0000`;
  const second = store.put('OPENROUTER_API_KEY', ['openrouter.ai'], longer).placeholder;
  assert.notEqual(second, first);
  assert.equal(second.length, longer.length);
});

test('without a secret only the hosts change', () => {
  const first = store.put('OPENROUTER_API_KEY', ['openrouter.ai'], KEY);
  const second = store.put('OPENROUTER_API_KEY', ['openrouter.ai', '*.openrouter.ai'], undefined);

  assert.equal(second.secret, KEY);
  assert.equal(second.placeholder, first.placeholder);
  assert.deepEqual(second.hosts, ['openrouter.ai', '*.openrouter.ai']);
});

test('a new key needs a secret', () => {
  assert.throws(() => store.put('OPENROUTER_API_KEY', ['openrouter.ai'], undefined), /secret/);
});

test('a name must be a variable name that Boxes does not set itself', () => {
  assert.throws(() => store.put('1KEY', ['openrouter.ai'], KEY), /not a valid/);
  assert.throws(() => store.put('MY-KEY', ['openrouter.ai'], KEY), /not a valid/);
  const taken = ['GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'PATH'];
  for (const name of taken) {
    assert.throws(() => store.put(name, ['openrouter.ai'], KEY), /set by Boxes/, name);
  }
  assert.equal(changes, 0);
});

test('hosts must be hostnames or one-label wildcards', () => {
  assert.throws(() => store.put('KEY', [], KEY), /at least one host/);
  assert.throws(() => store.put('KEY', ['*'], KEY), /not a hostname/);
  assert.throws(() => store.put('KEY', ['api.*.com'], KEY), /not a hostname/);
  assert.throws(() => store.put('KEY', ['https://openrouter.ai'], KEY), /not a hostname/);
  assert.doesNotThrow(() => store.put('KEY', ['*.example.com', 'api.example.com'], KEY));
});

test('removing a key forgets it, and an unknown name is a 404', () => {
  store.put('OPENROUTER_API_KEY', ['openrouter.ai'], KEY);
  store.remove('OPENROUTER_API_KEY');

  assert.equal(store.get('OPENROUTER_API_KEY'), undefined);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.remove('OPENROUTER_API_KEY'), /No API key/);
});
