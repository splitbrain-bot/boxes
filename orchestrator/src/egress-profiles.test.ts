import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { type Db, openDb } from './db.ts';
import { EgressProfileStore, MAX_PROFILE_HOSTS } from './egress-profiles.ts';
import { HttpError } from './http-error.ts';

/** The temporary data directory of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The number of calls of the change callback. */
let changes: number;
/** The store under test. */
let store: EgressProfileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-egress-profiles-'));
  db = openDb(dir);
  changes = 0;
  store = new EgressProfileStore(db, () => {
    changes += 1;
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Inserts a box of a user.
 *
 * @param id The id of the box.
 * @param owner The owner of the box.
 * @param profile The selected egress profile, or null for the default profile.
 * @param status The status of the box.
 */
function insertBox(id: string, owner: string, profile: string | null, status = 'running'): void {
  db.prepare(
    `INSERT INTO boxes (id, name, owner, status, egress_profile_id, created_at, last_active_at)
     VALUES (?, 'a box', ?, ?, ?, 1000, 2000)`,
  ).run(id, owner, status, profile);
}

/**
 * Reads the selected egress profile of a box.
 *
 * @param id The id of the box.
 * @returns The id of the profile, or null for the default profile.
 */
function profileOf(id: string): string | null {
  const row = db.prepare('SELECT egress_profile_id FROM boxes WHERE id = ?').get(id) as {
    egress_profile_id: string | null;
  };
  return row.egress_profile_id;
}

/**
 * Asserts that a call fails with an HTTP error.
 *
 * @param fn The call.
 * @param status The expected status.
 * @param message The pattern that the message must match.
 */
function assertHttpError(fn: () => unknown, status: number, message: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.statusCode, status);
    assert.match(err.message, message);
    return true;
  });
}

test('each user gets one open default profile without hosts at the first use', () => {
  const list = store.list('alice');

  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, 'Default');
  assert.equal(list[0]?.isDefault, true);
  assert.equal(list[0]?.open, true);
  assert.deepEqual(store.get('alice', list[0]!.id).hosts, []);
  assert.match(list[0]!.id, /^ep[0-9a-f]{10}$/);

  // The store makes the default profile one time only.
  assert.equal(store.defaultId('alice'), list[0]!.id);
  assert.equal(store.list('alice').length, 1);
  assert.notEqual(store.defaultId('bob'), list[0]!.id);
  // The default profile keeps the policy of a box without a profile, so its creation is no change.
  assert.equal(changes, 0);
});

test('a profile is closed and has no hosts when the request gives none', () => {
  const profile = store.create('alice', { name: ' Work ' });

  assert.equal(profile.name, 'Work');
  assert.equal(profile.isDefault, false);
  assert.equal(profile.open, false);
  assert.deepEqual(profile.hosts, []);
  assert.equal(changes, 1);
  assert.deepEqual(
    store.list('alice').map((p) => p.name),
    ['Default', 'Work'],
  );
});

test('a profile changes only the fields that the request gives', () => {
  const profile = store.create('alice', { name: 'Work', hosts: ['github.com'] });

  const renamed = store.update('alice', profile.id, { name: 'Office' });
  assert.equal(renamed.name, 'Office');
  assert.equal(renamed.open, false);
  assert.deepEqual(renamed.hosts, ['github.com']);

  const opened = store.update('alice', profile.id, { open: true, hosts: [] });
  assert.equal(opened.name, 'Office');
  assert.equal(opened.open, true);
  assert.deepEqual(opened.hosts, []);
  assert.equal(changes, 3);
});

test('a name must not be empty or too long', () => {
  assertHttpError(() => store.create('alice', { name: '  ' }), 400, /name is required/);
  assertHttpError(() => store.create('alice', { name: 'a'.repeat(101) }), 400, /100 characters/);
  assertHttpError(() => store.create('alice', { name: 'Work', open: 'yes' }), 400, /true or false/);
  assert.equal(changes, 0);
});

test('the hosts are trimmed, in lower case and without duplicates', () => {
  const profile = store.create('alice', {
    name: 'Work',
    hosts: [' GitHub.com ', 'github.com', '', '*.NPMjs.org', 'mcp.example.com:8443'],
  });

  assert.deepEqual(profile.hosts, ['github.com', '*.npmjs.org', 'mcp.example.com:8443']);
});

test('a host pattern must follow the host grammar', () => {
  assertHttpError(() => store.create('alice', { name: 'W', hosts: ['*'] }), 400, /bare \*/);
  assertHttpError(
    () => store.create('alice', { name: 'W', hosts: ['api.*.com'] }),
    400,
    /leading \*\./,
  );
  assertHttpError(
    () => store.create('alice', { name: 'W', hosts: ['mcp.example.com:70000'] }),
    400,
    /no valid port/,
  );
  assertHttpError(
    () => store.create('alice', { name: 'W', hosts: 'github.com' }),
    400,
    /list of host patterns/,
  );
  const profile = store.create('alice', { name: 'Work' });
  assertHttpError(() => store.update('alice', profile.id, { hosts: ['*'] }), 400, /bare \*/);
});

test(`a profile holds at most ${MAX_PROFILE_HOSTS} hosts`, () => {
  const hosts = Array.from({ length: MAX_PROFILE_HOSTS + 1 }, (_, i) => `h${i}.example.com`);

  assertHttpError(
    () => store.create('alice', { name: 'W', hosts }),
    400,
    new RegExp(`at most ${MAX_PROFILE_HOSTS} hosts`),
  );
  assert.equal(
    store.create('alice', { name: 'W', hosts: hosts.slice(1) }).hosts.length,
    MAX_PROFILE_HOSTS,
  );
  // The limit counts the hosts after the removal of duplicates.
  assert.equal(
    store.create('alice', { name: 'X', hosts: [...hosts.slice(1), 'h1.example.com'] }).hosts.length,
    MAX_PROFILE_HOSTS,
  );
});

test('the default profile cannot be deleted', () => {
  const id = store.defaultId('alice');

  assertHttpError(() => store.delete('alice', id), 400, /default profile cannot be deleted/);
  assert.equal(store.list('alice').length, 1);
  assert.equal(changes, 0);
});

test('the boxes of a deleted profile move to the default profile', () => {
  const work = store.create('alice', { name: 'Work', hosts: ['github.com'] });
  insertBox('b1', 'alice', work.id);
  insertBox('b2', 'alice', null);

  store.delete('alice', work.id);

  assert.equal(profileOf('b1'), null);
  assert.equal(profileOf('b2'), null);
  assert.equal(store.forBox('alice', null).id, store.defaultId('alice'));
  assertHttpError(() => store.get('alice', work.id), 404, /not found/);
  assert.deepEqual(
    store.list('alice').map((p) => [p.name, p.boxCount]),
    [['Default', 2]],
  );
  assert.equal(changes, 2);
});

test('a user cannot read, change or delete the profile of another user', () => {
  const work = store.create('alice', { name: 'Work' });

  assertHttpError(() => store.get('bob', work.id), 404, /not found/);
  assertHttpError(() => store.update('bob', work.id, { name: 'Mine' }), 404, /not found/);
  assertHttpError(() => store.delete('bob', work.id), 404, /not found/);
  assert.equal(store.has('bob', work.id), false);
  assert.equal(store.has('alice', work.id), true);
  assert.deepEqual(
    store.list('bob').map((p) => p.name),
    ['Default'],
  );
  assert.equal(store.forBox('bob', work.id).id, store.defaultId('bob'));
  assert.equal(store.get('alice', work.id).name, 'Work');
});

test('the box count of the default profile includes the boxes without a profile', () => {
  const work = store.create('alice', { name: 'Work' });
  insertBox('b1', 'alice', null);
  insertBox('b2', 'alice', store.defaultId('alice'));
  insertBox('b3', 'alice', work.id);
  insertBox('b4', 'alice', work.id);
  // The count covers only the live boxes of the owner.
  insertBox('b5', 'alice', null, 'deleted');
  insertBox('b6', 'bob', null);

  assert.deepEqual(
    store.list('alice').map((p) => [p.name, p.boxCount]),
    [
      ['Default', 2],
      ['Work', 2],
    ],
  );
  assert.deepEqual(
    store.list('bob').map((p) => [p.name, p.boxCount]),
    [['Default', 1]],
  );
});
