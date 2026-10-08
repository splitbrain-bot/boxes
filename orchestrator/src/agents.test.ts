import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentStore, agentConfigPath } from './agents.ts';
import { openDb, type Db } from './db.ts';
import { HttpError } from './http-error.ts';

let dir: string;
let db: Db;
let store: AgentStore;

/** The fake fetcher's checkouts, by URL. A string is the error the fetch fails with. */
let remotes: Record<string, Record<string, string> | string>;

/** Every fetch the store asked for, as URL and ref. */
let fetches: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-agents-'));
  db = openDb(dir);
  remotes = {};
  fetches = [];
  store = new AgentStore(db, dir, async (repo, url, ref) => {
    fetches.push(`${url}@${ref}`);
    const remote = remotes[url];
    if (remote === undefined || typeof remote === 'string') throw new Error(remote ?? 'not found');
    rmSync(join(repo, 'tree'), { recursive: true, force: true });
    files(join(repo, 'tree'), remote);
    return 'c0ffee';
  });
});

/** Writes files under `root`, creating the directories on the way. */
function files(root: string, contents: Record<string, string>): void {
  for (const [rel, content] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The materialized manifest of a box, as lines. */
function manifest(boxId: string): string[] {
  const text = readFileSync(join(agentConfigPath(dir, boxId), 'manifest'), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

/** One materialized file's content. */
function materialized(boxId: string, rel: string): string {
  return readFileSync(join(agentConfigPath(dir, boxId), rel), 'utf8');
}

/** Inserts a box row, which is all the set's box count reads. */
function insertBox(id: string, agentSetId: string | null): void {
  db.prepare(
    `INSERT INTO boxes (id, name, profile, image, container_id,
       network_name, subnet, status, agent_set_id, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', 'c1',
       ?, '10.200.0.0/24', 'running', ?, 0, 0)`,
  ).run(id, `bn-${id}`, agentSetId);
}

// --- the global set ----------------------------------------------------------

test('the global set exists from the first boot and cannot be deleted', () => {
  const sets = store.listSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0]!.id, 'global');
  assert.equal(sets[0]!.global, true);

  assert.throws(
    () => store.deleteSet('global'),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400,
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
  // The global set alone is what a box naming none gets.
  assert.equal(store.bundle(null).agentsMd, 'House rules.');
});

test('a set that adds no AGENTS.md leaves no blank joiner behind', () => {
  store.updateSet('global', { agentsMd: 'House rules.\n' });
  const set = store.createSet('empty');
  assert.equal(store.bundle(set.id).agentsMd, 'House rules.');
});

test('skills are a union, and the set wins a name clash', () => {
  store.putItem('global', { name: 'review', content: 'global review' });
  store.putItem('global', { name: 'ship', content: 'global ship' });
  const set = store.createSet('go');
  store.putItem(set.id, { name: 'review', content: 'go review' });
  store.putItem(set.id, { name: 'bench', content: 'go bench' });

  const bundle = store.bundle(set.id);
  assert.deepEqual(
    bundle.skills.map((i) => i.name),
    ['bench', 'review', 'ship'],
  );
  // An override is silent in the merged result, so it is reported separately.
  assert.deepEqual(bundle.overrides, ['review']);
  store.materialize('s1', set.id);
  assert.equal(materialized('s1', '.claude/skills/review/SKILL.md'), 'go review\n');
});

test('naming the global set as the extra one changes nothing', () => {
  store.putItem('global', { name: 'review', content: 'x' });
  assert.deepEqual(store.bundle('global'), store.bundle(null));
});

// --- materializing -----------------------------------------------------------

test('a merged set is written in every harness layout the entrypoint copies', () => {
  store.updateSet('global', { agentsMd: 'House rules.' });
  store.putItem('global', { name: 'review', content: '---\nname: review\n---\n' });
  const set = store.createSet('go');
  store.putItem(set.id, { name: 'bench', content: 'Run the benchmarks.' });

  store.materialize('s1', set.id);

  // Both layouts, always: a box holds threads of either harness, and which it
  // will hold is not known when this is written.
  assert.deepEqual(manifest('s1').sort(), [
    '.agents/skills/bench',
    '.agents/skills/review',
    '.claude/CLAUDE.md',
    '.claude/skills/bench',
    '.claude/skills/review',
    '.codex/AGENTS.md',
  ]);
  // What the dashboard calls AGENTS.md lands as each agent's user-level memory.
  assert.equal(materialized('s1', '.claude/CLAUDE.md'), 'House rules.\n');
  assert.equal(materialized('s1', '.codex/AGENTS.md'), 'House rules.\n');
  // A skill is a directory with a SKILL.md in it under both layouts.
  assert.equal(
    materialized('s1', '.claude/skills/review/SKILL.md'),
    '---\nname: review\n---\n',
  );
  assert.equal(
    materialized('s1', '.agents/skills/review/SKILL.md'),
    '---\nname: review\n---\n',
  );
  assert.equal(materialized('s1', '.claude/skills/bench/SKILL.md'), 'Run the benchmarks.\n');
});

test('every manifest path is home-relative and inside a layout', () => {
  // The entrypoint installs these relative to $HOME and skips any line
  // outside these four prefixes.
  store.updateSet('global', { agentsMd: 'House rules.' });
  store.putItem('global', { name: 'review', content: 'x' });
  store.materialize('s1', null);

  for (const rel of manifest('s1')) {
    assert.match(
      rel,
      /^(\.claude\/(CLAUDE\.md|skills\/)|\.codex\/AGENTS\.md|\.agents\/skills\/)/,
      `${rel} is not in a layout the entrypoint accepts`,
    );
  }
});

test('a box with nothing configured still gets a manifest', () => {
  store.materialize('s1', null);
  assert.deepEqual(manifest('s1'), []);
  assert.deepEqual(readdirSync(agentConfigPath(dir, 's1')), ['manifest']);
});

test('materializing again removes what the previous set left, in both layouts', () => {
  store.updateSet('global', { agentsMd: 'House rules.' });
  store.putItem('global', { name: 'ship', content: 'one' });
  store.materialize('s1', null);
  assert.deepEqual(manifest('s1').sort(), [
    '.agents/skills/ship',
    '.claude/CLAUDE.md',
    '.claude/skills/ship',
    '.codex/AGENTS.md',
  ]);

  store.updateSet('global', { agentsMd: '' });
  store.deleteItem('global', 'ship');
  store.putItem('global', { name: 'review', content: 'two' });
  store.materialize('s1', null);

  // Gone from the manifest and from the directory the container reads, so the
  // next start removes it from both layouts in the home.
  assert.deepEqual(manifest('s1').sort(), ['.agents/skills/review', '.claude/skills/review']);
  assert.deepEqual(readdirSync(join(agentConfigPath(dir, 's1'), '.claude')), ['skills']);
  assert.deepEqual(readdirSync(agentConfigPath(dir, 's1')).sort(), [
    '.agents',
    '.claude',
    'manifest',
  ]);
});

test('re-materializing keeps the directory a running container is mounted on', () => {
  store.materialize('s1', null);
  const before = statSync(agentConfigPath(dir, 's1')).ino;
  store.putItem('global', { name: 'review', content: 'x' });
  store.materialize('s1', null);
  assert.equal(statSync(agentConfigPath(dir, 's1')).ino, before);
});

test('deleting a box takes its materialized directory with it', () => {
  store.materialize('s1', null);
  store.removeMaterialized('s1');
  assert.equal(readdirSync(join(dir, 'agents')).includes('s1'), false);
});

// --- repositories ------------------------------------------------------------

test('a repository is pulled when it is added, and its skills are listed', async () => {
  remotes['https://example.com/skills'] = {
    'skills/pdf/SKILL.md': 'pdf',
    'skills/pdf/reference.md': 'more',
  };
  const set = await store.addRepo('global', { url: 'https://example.com/skills', ref: 'v1' });

  assert.deepEqual(fetches, ['https://example.com/skills@v1']);
  assert.equal(set.repoCount, 1);
  assert.deepEqual(
    set.repos.map(({ url, ref, commit, skills, error }) => ({ url, ref, commit, skills, error })),
    [{ url: 'https://example.com/skills', ref: 'v1', commit: 'c0ffee', skills: ['pdf'], error: null }],
  );
  assert.deepEqual(store.bundle(null).skills, [{ name: 'pdf', repo: 'https://example.com/skills' }]);
});

test('a skill of the set wins over a repository, and an earlier repository over a later one', async () => {
  remotes['https://example.com/one'] = { 'review/SKILL.md': 'one', 'lint/SKILL.md': 'one' };
  remotes['https://example.com/two'] = { 'lint/SKILL.md': 'two', 'ship/SKILL.md': 'two' };
  await store.addRepo('global', { url: 'https://example.com/one' });
  await store.addRepo('global', { url: 'https://example.com/two' });
  store.putItem('global', { name: 'review', content: 'mine' });

  assert.deepEqual(store.bundle(null).skills, [
    { name: 'lint', repo: 'https://example.com/one' },
    { name: 'review', repo: null },
    { name: 'ship', repo: 'https://example.com/two' },
  ]);
});

test('a repository of the selected set wins over a skill of the global set', async () => {
  remotes['https://example.com/go'] = { 'review/SKILL.md': 'go' };
  store.putItem('global', { name: 'review', content: 'global' });
  const set = store.createSet('go');
  await store.addRepo(set.id, { url: 'https://example.com/go' });

  const bundle = store.bundle(set.id);
  assert.deepEqual(bundle.skills, [{ name: 'review', repo: 'https://example.com/go' }]);
  assert.deepEqual(bundle.overrides, ['review']);
});

test('a repository skill is copied with all its files, without its links', async () => {
  remotes['https://example.com/skills'] = {
    'skills/pdf/SKILL.md': 'pdf',
    'skills/pdf/scripts/run.sh': '#!/bin/sh\n',
  };
  const set = await store.addRepo('global', { url: 'https://example.com/skills' });
  const tree = join(dir, 'skill-repos', set.repos[0]!.id, 'tree', 'skills', 'pdf');
  chmodSync(join(tree, 'scripts', 'run.sh'), 0o755);
  symlinkSync('/etc/passwd', join(tree, 'passwd'));

  store.materialize('s1', null);

  assert.deepEqual(manifest('s1').sort(), ['.agents/skills/pdf', '.claude/skills/pdf']);
  assert.equal(materialized('s1', '.claude/skills/pdf/SKILL.md'), 'pdf');
  assert.equal(materialized('s1', '.agents/skills/pdf/scripts/run.sh'), '#!/bin/sh\n');
  const mode = statSync(join(agentConfigPath(dir, 's1'), '.claude/skills/pdf/scripts/run.sh')).mode;
  assert.equal(mode & 0o111, 0o111);
  assert.equal(existsSync(join(agentConfigPath(dir, 's1'), '.claude/skills/pdf/passwd')), false);
});

test('a skill that changes source leaves no file of the old one behind', async () => {
  remotes['https://example.com/skills'] = {
    'pdf/SKILL.md': 'repo',
    'pdf/extra.md': 'extra',
  };
  await store.addRepo('global', { url: 'https://example.com/skills' });
  store.materialize('s1', null);
  store.putItem('global', { name: 'pdf', content: 'mine' });
  store.materialize('s1', null);

  assert.deepEqual(readdirSync(join(agentConfigPath(dir, 's1'), '.claude/skills/pdf')), [
    'SKILL.md',
  ]);
});

test('a failed pull is recorded, and the skills of the last good pull stay', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const set = await store.addRepo('global', { url: 'https://example.com/skills' });
  remotes['https://example.com/skills'] = 'repository not found';

  const after = await store.refreshRepo('global', set.repos[0]!.id);

  assert.equal(after.repos[0]!.error, 'repository not found');
  assert.deepEqual(after.repos[0]!.skills, ['pdf']);
  store.materialize('s1', null);
  assert.equal(materialized('s1', '.claude/skills/pdf/SKILL.md'), 'pdf');
});

test('a repository that cannot be pulled at all is still added', async () => {
  const set = await store.addRepo('global', { url: 'https://example.com/missing' });
  assert.equal(set.repos[0]!.error, 'not found');
  assert.equal(set.repos[0]!.commit, null);
  assert.deepEqual(store.bundle(null).skills, []);
});

test('removing a repository removes its checkout and its skills', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const set = await store.addRepo('global', { url: 'https://example.com/skills' });
  const id = set.repos[0]!.id;

  const after = store.deleteRepo('global', id);

  assert.deepEqual(after.repos, []);
  assert.equal(existsSync(join(dir, 'skill-repos', id)), false);
  assert.deepEqual(store.bundle(null).skills, []);
});

test('deleting a set removes the checkouts of its repositories', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const set = store.createSet('go');
  const id = (await store.addRepo(set.id, { url: 'https://example.com/skills' })).repos[0]!.id;

  store.deleteSet(set.id);

  assert.equal(existsSync(join(dir, 'skill-repos', id)), false);
});

test('the daily pull takes the repositories pulled a day ago, and removes stray checkouts', async () => {
  remotes['https://example.com/old'] = { 'a/SKILL.md': 'a' };
  remotes['https://example.com/new'] = { 'b/SKILL.md': 'b' };
  const old = (await store.addRepo('global', { url: 'https://example.com/old' })).repos[0]!;
  await store.addRepo('global', { url: 'https://example.com/new' });
  db.prepare('UPDATE agent_repos SET pulled_at = 0 WHERE id = ?').run(old.id);
  mkdirSync(join(dir, 'skill-repos', 'stray'));
  fetches = [];

  await store.pullDue();

  assert.deepEqual(fetches, ['https://example.com/old@']);
  assert.equal(existsSync(join(dir, 'skill-repos', 'stray')), false);
});

test('two pulls of one repository at the same time fetch once', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const id = (await store.addRepo('global', { url: 'https://example.com/skills' })).repos[0]!.id;
  fetches = [];

  await Promise.all([store.pullRepo(id), store.pullRepo(id)]);

  assert.equal(fetches.length, 1);
});

test('a repository URL must be HTTPS and carry no credentials, and a ref must look like one', async () => {
  for (const body of [
    { url: 'http://example.com/skills' },
    { url: 'git@github.com:a/b.git' },
    { url: 'file:///etc' },
    { url: 'https://user:secret@example.com/skills' },
    { url: 'https://example.com/skills', ref: '--upload-pack=x' },
    { url: 'https://example.com/skills', ref: 'a b' },
  ]) {
    await assert.rejects(
      store.addRepo('global', body),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400,
      `expected ${JSON.stringify(body)} to be refused`,
    );
  }
  assert.deepEqual(fetches, []);
});

test('an unknown repository is a 404, also in another set', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const id = (await store.addRepo('global', { url: 'https://example.com/skills' })).repos[0]!.id;
  const other = store.createSet('other');
  for (const call of [
    () => store.refreshRepo(other.id, id),
    async () => store.deleteRepo(other.id, id),
    () => store.refreshRepo('global', 'nope'),
  ]) {
    await assert.rejects(
      call(),
      (err: unknown) => err instanceof HttpError && err.statusCode === 404,
    );
  }
});

// --- validation --------------------------------------------------------------

test('a skill name that is not a safe path component is refused', () => {
  for (const name of ['../escape', 'a/b', '-lead', 'sk ill', '.hidden', '', 'a'.repeat(65)]) {
    assert.throws(
      () => store.putItem('global', { name, content: 'x' }),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400,
      `expected ${JSON.stringify(name)} to be refused`,
    );
  }
});

test('a name is lowercased rather than refused for its case alone', () => {
  // Only the lowercase form is stored.
  const set = store.putItem('global', { name: 'Review', content: 'x' });
  assert.equal(set.items[0]!.name, 'review');
});

test('CRLF is normalised, because the agent reads these as files', () => {
  store.putItem('global', { name: 'ship', content: 'a\r\nb\rc' });
  assert.equal(store.getSet('global').items[0]!.content, 'a\nb\nc');
});

test('writing a skill under a name that exists replaces it', () => {
  store.putItem('global', { name: 'ship', content: 'one' });
  const set = store.putItem('global', { name: 'ship', content: 'two' });
  assert.equal(set.items.length, 1);
  assert.equal(set.items[0]!.content, 'two');
});

test('an unknown set is a 404 on every route into it', () => {
  for (const call of [
    () => store.getSet('nope'),
    () => store.updateSet('nope', { name: 'x' }),
    () => store.deleteSet('nope'),
    () => store.putItem('nope', { name: 'x', content: '' }),
    () => store.deleteItem('nope', 'x'),
  ]) {
    assert.throws(
      call,
      (err: unknown) => err instanceof HttpError && err.statusCode === 404,
    );
  }
});

// --- boxes ----------------------------------------------------------------

test('a set counts the live boxes that selected it', () => {
  const set = store.createSet('go');
  insertBox('s1', set.id);
  insertBox('s2', null);
  assert.equal(store.getSet(set.id).boxCount, 1);
});

test('deleting a set leaves its boxes alone and falls them back to global', () => {
  const set = store.createSet('go');
  insertBox('s1', set.id);

  store.deleteSet(set.id);

  const row = db.prepare('SELECT agent_set_id, status FROM boxes WHERE id = ?').get('s1') as {
    agent_set_id: string | null;
    status: string;
  };
  assert.equal(row.status, 'running');
  assert.equal(row.agent_set_id, null);
});

test('a set going away takes its skills with it', () => {
  const set = store.createSet('go');
  store.putItem(set.id, { name: 'review', content: 'x' });
  store.deleteSet(set.id);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM agent_items').get() as { n: number };
  assert.equal(rows.n, 0);
});
