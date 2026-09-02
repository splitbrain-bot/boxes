import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigError, AgentStore, agentConfigPath } from './agents.ts';
import { openDb, type Db } from './db.ts';

/**
 * Agent sets: what merges, what overrides, and what the container is handed.
 *
 * The materialized directory is the contract with the session image, so these
 * assert its bytes and its manifest rather than only the store's own answers —
 * the entrypoint copies what is written here and interprets nothing.
 */

let dir: string;
let db: Db;
let store: AgentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-agents-'));
  db = openDb(dir);
  store = new AgentStore(db, dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The materialized manifest of a session, as lines. */
function manifest(sessionId: string): string[] {
  const text = readFileSync(join(agentConfigPath(dir, sessionId), 'manifest'), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

/** One materialized file's content. */
function materialized(sessionId: string, rel: string): string {
  return readFileSync(join(agentConfigPath(dir, sessionId), rel), 'utf8');
}

/** Inserts a session row, which is all the set's session count reads. */
function insertSession(id: string, agentSetId: string | null): void {
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, agent_set_id,
       created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       ?, '10.200.0.0/24', '', ?, 'running', ?, 0, 0)`,
  ).run(id, `sn-${id}`, `home-${id}`, agentSetId);
}

// --- the global set ----------------------------------------------------------

test('the global set exists from the first boot and cannot be deleted', () => {
  const sets = store.listSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0]!.id, 'global');
  assert.equal(sets[0]!.global, true);

  assert.throws(
    () => store.deleteSet('global'),
    (err: unknown) => err instanceof AgentConfigError && err.statusCode === 400,
  );
});

test('the global set is listed first, and the rest by name', () => {
  store.createSet('zebra');
  store.createSet('alpha');
  assert.deepEqual(
    store.listSets().map((s) => s.name),
    ['Global', 'alpha', 'zebra'],
  );
});

// --- merging -----------------------------------------------------------------

test('an AGENTS.md accumulates: the global one first, then the set own', () => {
  store.updateSet('global', { agentsMd: 'House rules.' });
  const set = store.createSet('go');
  store.updateSet(set.id, { agentsMd: 'Go rules.' });

  assert.equal(store.bundle(set.id).agentsMd, 'House rules.\n\nGo rules.');
  // The global set alone is what a session naming none gets.
  assert.equal(store.bundle(null).agentsMd, 'House rules.');
});

test('a set that adds no AGENTS.md leaves no blank joiner behind', () => {
  store.updateSet('global', { agentsMd: 'House rules.\n' });
  const set = store.createSet('empty');
  assert.equal(store.bundle(set.id).agentsMd, 'House rules.');
});

test('skills and commands are a union, and the set wins a name clash', () => {
  store.putItem('global', { kind: 'skill', name: 'review', content: 'global review' });
  store.putItem('global', { kind: 'command', name: 'ship', content: 'global ship' });
  const set = store.createSet('go');
  store.putItem(set.id, { kind: 'skill', name: 'review', content: 'go review' });
  store.putItem(set.id, { kind: 'command', name: 'bench', content: 'go bench' });

  const bundle = store.bundle(set.id);
  assert.deepEqual(
    bundle.items.map((i) => `${i.kind}/${i.name}`).sort(),
    ['command/bench', 'command/ship', 'skill/review'],
  );
  assert.equal(bundle.items.find((i) => i.name === 'review')!.content, 'go review');
  // An override is silent in the merged result, so it is reported separately.
  assert.deepEqual(bundle.overrides, [{ kind: 'skill', name: 'review' }]);
});

test('naming the global set as the extra one changes nothing', () => {
  store.putItem('global', { kind: 'skill', name: 'review', content: 'x' });
  assert.deepEqual(store.bundle('global'), store.bundle(null));
});

// --- materializing -----------------------------------------------------------

test('a merged set is written in the layout the entrypoint copies', () => {
  store.updateSet('global', { agentsMd: 'House rules.' });
  store.putItem('global', { kind: 'skill', name: 'review', content: '---\nname: review\n---\n' });
  const set = store.createSet('go');
  store.putItem(set.id, { kind: 'command', name: 'bench', content: 'Run the benchmarks.' });

  store.materialize('s1', set.id);

  assert.deepEqual(manifest('s1').sort(), [
    'CLAUDE.md',
    'commands/bench.md',
    'skills/review',
  ]);
  // What the dashboard calls AGENTS.md lands as Claude's user-level memory.
  assert.equal(materialized('s1', 'CLAUDE.md'), 'House rules.\n');
  assert.equal(materialized('s1', 'skills/review/SKILL.md'), '---\nname: review\n---\n');
  assert.equal(materialized('s1', 'commands/bench.md'), 'Run the benchmarks.\n');
});

test('a session with nothing configured still gets a manifest', () => {
  // An empty manifest is not the same as no mount: it is what tells the
  // entrypoint to remove whatever a previous start installed.
  store.materialize('s1', null);
  assert.deepEqual(manifest('s1'), []);
  assert.deepEqual(readdirSync(agentConfigPath(dir, 's1')), ['manifest']);
});

test('materializing again removes what the previous set left', () => {
  store.putItem('global', { kind: 'command', name: 'ship', content: 'one' });
  store.materialize('s1', null);
  assert.deepEqual(manifest('s1'), ['commands/ship.md']);

  store.deleteItem('global', 'command', 'ship');
  store.putItem('global', { kind: 'skill', name: 'review', content: 'two' });
  store.materialize('s1', null);

  assert.deepEqual(manifest('s1'), ['skills/review']);
  assert.deepEqual(readdirSync(agentConfigPath(dir, 's1')).sort(), ['manifest', 'skills']);
});

test('re-materializing keeps the directory a running container is mounted on', () => {
  store.materialize('s1', null);
  const before = statSync(agentConfigPath(dir, 's1')).ino;
  store.putItem('global', { kind: 'skill', name: 'review', content: 'x' });
  store.materialize('s1', null);
  assert.equal(statSync(agentConfigPath(dir, 's1')).ino, before);
});

test('deleting a session takes its materialized directory with it', () => {
  store.materialize('s1', null);
  store.removeMaterialized('s1');
  assert.equal(readdirSync(join(dir, 'agents')).includes('s1'), false);
});

// --- validation --------------------------------------------------------------

test('an item name that is not a safe path component is refused', () => {
  for (const name of ['../escape', 'a/b', '-lead', 'sk ill', '.hidden', '', 'a'.repeat(65)]) {
    assert.throws(
      () => store.putItem('global', { kind: 'skill', name, content: 'x' }),
      (err: unknown) => err instanceof AgentConfigError && err.statusCode === 400,
      `expected ${JSON.stringify(name)} to be refused`,
    );
  }
});

test('a name is lowercased rather than refused for its case alone', () => {
  // Typing "Review" and getting /review is a convenience; what is stored is
  // the safe form, and it is the only form anything downstream sees.
  const set = store.putItem('global', { kind: 'command', name: 'Review', content: 'x' });
  assert.equal(set.items[0]!.name, 'review');
});

test('an unknown kind is refused rather than written somewhere', () => {
  assert.throws(
    () =>
      store.putItem('global', {
        kind: 'settings' as 'skill',
        name: 'x',
        content: 'x',
      }),
    (err: unknown) => err instanceof AgentConfigError && err.statusCode === 400,
  );
});

test('CRLF is normalised, because the agent reads these as files', () => {
  store.putItem('global', { kind: 'command', name: 'ship', content: 'a\r\nb\rc' });
  assert.equal(store.getSet('global').items[0]!.content, 'a\nb\nc');
});

test('writing an item under a name that exists replaces it', () => {
  store.putItem('global', { kind: 'command', name: 'ship', content: 'one' });
  const set = store.putItem('global', { kind: 'command', name: 'ship', content: 'two' });
  assert.equal(set.items.length, 1);
  assert.equal(set.items[0]!.content, 'two');
});

test('an unknown set is a 404 on every route into it', () => {
  for (const call of [
    () => store.getSet('nope'),
    () => store.updateSet('nope', { name: 'x' }),
    () => store.deleteSet('nope'),
    () => store.putItem('nope', { kind: 'skill', name: 'x', content: '' }),
    () => store.deleteItem('nope', 'skill', 'x'),
  ]) {
    assert.throws(
      call,
      (err: unknown) => err instanceof AgentConfigError && err.statusCode === 404,
    );
  }
});

// --- sessions ----------------------------------------------------------------

test('a set counts the live sessions that selected it', () => {
  const set = store.createSet('go');
  insertSession('s1', set.id);
  insertSession('s2', null);
  assert.equal(store.getSet(set.id).sessionCount, 1);
});

test('deleting a set leaves its sessions alone and falls them back to global', () => {
  const set = store.createSet('go');
  insertSession('s1', set.id);

  store.deleteSet(set.id);

  const row = db.prepare('SELECT agent_set_id, status FROM sessions WHERE id = ?').get('s1') as {
    agent_set_id: string | null;
    status: string;
  };
  assert.equal(row.status, 'running');
  assert.equal(row.agent_set_id, null);
});

test('a set going away takes its items with it', () => {
  const set = store.createSet('go');
  store.putItem(set.id, { kind: 'skill', name: 'review', content: 'x' });
  store.deleteSet(set.id);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM agent_items').get() as { n: number };
  assert.equal(rows.n, 0);
});
