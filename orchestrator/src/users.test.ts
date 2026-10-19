import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { type Db, openDb } from './db.ts';
import { claimUnownedData, hasUnownedData, requestUser } from './users.ts';

/** The temporary data directory of the current test. */
let dir: string;
/** The database of the current test. */
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-users-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Stores a credential row for a user.
 *
 * @param owner The user.
 * @param secret The secret.
 */
function credential(owner: string, secret: string): void {
  db.prepare(
    `INSERT INTO credentials (owner, id, method, secret, placeholder, created_at, updated_at)
     VALUES (?, 'github', 'token', ?, ?, 0, 0)`,
  ).run(owner, secret, `ghp_${owner}`);
}

/**
 * Gives the owner of each credential row by its secret.
 *
 * @returns The pairs of secret and owner.
 */
function credentialOwners(): Array<{ secret: string; owner: string }> {
  return db.prepare('SELECT secret, owner FROM credentials ORDER BY secret').all() as Array<{
    secret: string;
    owner: string;
  }>;
}

test('single user mode ignores each header and gives the empty user', () => {
  assert.equal(requestUser({ 'remote-user': 'alice' }, ''), '');
  assert.equal(requestUser({}, ''), '');
});

test('the username comes from the header, trimmed and in lowercase', () => {
  assert.equal(requestUser({ 'remote-user': '  Alice ' }, 'remote-user'), 'alice');
  assert.equal(requestUser({ 'remote-user': ['Bob', 'eve'] }, 'remote-user'), 'bob');
});

test('a missing, empty or too long username is no user', () => {
  assert.equal(requestUser({}, 'remote-user'), null);
  assert.equal(requestUser({ 'remote-user': '  ' }, 'remote-user'), null);
  assert.equal(requestUser({ 'remote-user': 'a'.repeat(201) }, 'remote-user'), null);
});

test('the first claim takes the data without an owner, and a second claim finds none', () => {
  db.prepare(
    `INSERT INTO boxes (id, name, status, created_at, last_active_at)
     VALUES ('b1', 'one', 'running', 0, 0)`,
  ).run();
  credential('', 'ghp_old');
  assert.ok(hasUnownedData(db));

  assert.ok(claimUnownedData(db, 'alice') > 0);
  assert.equal(claimUnownedData(db, 'bob'), 0);

  assert.ok(!hasUnownedData(db));
  const box = db.prepare("SELECT owner FROM boxes WHERE id = 'b1'").get();
  assert.deepEqual(box, { owner: 'alice' });
  assert.deepEqual(credentialOwners(), [{ secret: 'ghp_old', owner: 'alice' }]);
});

test('a row whose key the user has already stays with the empty user', () => {
  credential('alice', 'ghp_alice');
  credential('', 'ghp_old');
  db.prepare(
    `INSERT INTO agent_sets (id, owner, global, name, created_at, updated_at)
     VALUES ('as-alice', 'alice', 1, 'Global', 0, 0)`,
  ).run();

  claimUnownedData(db, 'alice');

  assert.deepEqual(credentialOwners(), [
    { secret: 'ghp_alice', owner: 'alice' },
    { secret: 'ghp_old', owner: '' },
  ]);
  // A user has one global set, so the global set of the empty user stays too.
  const globals = db.prepare('SELECT id, owner FROM agent_sets WHERE global = 1 ORDER BY id').all();
  assert.deepEqual(globals, [
    { id: 'as-alice', owner: 'alice' },
    { id: 'global', owner: '' },
  ]);
});
