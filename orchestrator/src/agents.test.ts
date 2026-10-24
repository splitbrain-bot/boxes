import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extract } from 'tar-stream';
import { afterEach, beforeEach, test } from 'vitest';
import { AgentStore } from './agents.ts';
import type { ApiKeyRow } from './api-keys.ts';
import { type Db, openDb } from './db.ts';
import { HttpError } from './http-error.ts';

/** The temporary DATA_DIR of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The store under test, with a fake fetcher. */
let store: AgentStore;

/** The files of each fake remote, by URL. A string is the error message of a failed fetch. */
let remotes: Record<string, Record<string, string> | string>;

/** Each fetch that the store started, as `url@ref`. */
let fetches: string[];

/** The owner of the set of each fetch, in the order of the fetches. */
let owners: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-agents-'));
  db = openDb(dir);
  remotes = {};
  fetches = [];
  owners = [];
  store = new AgentStore(db, dir, async (repo, url, ref, _keep, owner) => {
    fetches.push(`${url}@${ref}`);
    owners.push(owner);
    const remote = remotes[url];
    if (remote === undefined || typeof remote === 'string') throw new Error(remote ?? 'not found');
    rmSync(join(repo, 'tree'), { recursive: true, force: true });
    files(join(repo, 'tree'), remote);
    return 'c0ffee';
  });
});

/**
 * Writes files under `root`, and creates the missing directories.
 *
 * @param root The directory to write into.
 * @param contents The content of each file, by its path relative to `root`.
 */
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

/**
 * Packs a set and reads the tar back. It fails when the tar holds a path more than once.
 *
 * @param setId The id of the selected set, or null for only the global set.
 * @returns The content and the mode of each file, by its path relative to the home.
 */
async function packed(
  setId: string | null,
): Promise<Map<string, { content: string; mode: number }>> {
  const files = new Map<string, { content: string; mode: number }>();
  const twice: string[] = [];
  const entries = extract();
  entries.on('entry', (header, stream, next) => {
    if (files.has(header.name)) twice.push(header.name);
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => {
      files.set(header.name, {
        content: Buffer.concat(chunks).toString('utf8'),
        mode: header.mode,
      });
      next();
    });
  });
  await new Promise<void>((resolve, reject) => {
    entries.on('finish', resolve);
    entries.on('error', reject);
    store.pack('', setId).pipe(entries);
  });
  assert.deepEqual(twice, [], 'paths packed more than once');
  return files;
}

/**
 * Packs a set and lists its paths.
 *
 * @param setId The id of the selected set, or null for only the global set.
 * @returns The paths relative to the home, sorted.
 */
async function paths(setId: string | null): Promise<string[]> {
  return [...(await packed(setId)).keys()].sort();
}

/**
 * Inserts a running box row with the columns that the box count of a set reads.
 *
 * @param id The id of the box.
 * @param agentSetId The id of the set that the box selected, or null.
 */
function insertBox(id: string, agentSetId: string | null): void {
  db.prepare(
    `INSERT INTO boxes (id, name, profile, status, agent_set_id, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'running', ?, 0, 0)`,
  ).run(id, agentSetId);
}

test('the global set exists from the first boot and cannot be deleted', () => {
  const sets = store.listSets('');
  assert.equal(sets.length, 1);
  assert.equal(sets[0]!.id, 'global');
  assert.equal(sets[0]!.global, true);

  assert.throws(
    () => store.deleteSet('', 'global'),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400,
  );
});

test('the global set is listed first, and the rest by name', () => {
  store.createSet('', 'zebra');
  store.createSet('', 'alpha');
  assert.deepEqual(
    store.listSets('').map((s) => s.name),
    ['Global', 'alpha', 'zebra'],
  );
});

test('an AGENTS.md accumulates: the global one first, then the set own', () => {
  store.updateSet('', 'global', { agentsMd: 'House rules.' });
  const set = store.createSet('', 'go');
  store.updateSet('', set.id, { agentsMd: 'Go rules.' });

  assert.equal(store.bundle('', set.id).agentsMd, 'House rules.\n\nGo rules.');
  // A box without a set gets only the global set.
  assert.equal(store.bundle('', null).agentsMd, 'House rules.');
});

test('a set that adds no AGENTS.md leaves no blank joiner behind', () => {
  store.updateSet('', 'global', { agentsMd: 'House rules.\n' });
  const set = store.createSet('', 'empty');
  assert.equal(store.bundle('', set.id).agentsMd, 'House rules.');
});

test('skills are a union, and the set wins a name clash', async () => {
  store.putItem('', 'global', { name: 'review', content: 'global review' });
  store.putItem('', 'global', { name: 'ship', content: 'global ship' });
  const set = store.createSet('', 'go');
  store.putItem('', set.id, { name: 'review', content: 'go review' });
  store.putItem('', set.id, { name: 'bench', content: 'go bench' });

  const bundle = store.bundle('', set.id);
  assert.deepEqual(
    bundle.skills.map((i) => i.name),
    ['bench', 'review', 'ship'],
  );
  // `overrides` names the global skill that the set replaces.
  assert.deepEqual(bundle.overrides, ['review']);
  assert.equal(
    (await packed(set.id)).get('.claude/skills/review/SKILL.md')?.content,
    'go review\n',
  );
});

test('naming the global set as the extra one changes nothing', () => {
  store.putItem('', 'global', { name: 'review', content: 'x' });
  assert.deepEqual(store.bundle('', 'global'), store.bundle('', null));
});

test('a merged set is packed in every harness layout', async () => {
  store.updateSet('', 'global', { agentsMd: 'House rules.' });
  store.putItem('', 'global', { name: 'review', content: '---\nname: review\n---\n' });
  const set = store.createSet('', 'go');
  store.putItem('', set.id, { name: 'bench', content: 'Run the benchmarks.' });

  const files = await packed(set.id);

  assert.deepEqual([...files.keys()].sort(), [
    '.agents/skills/bench/SKILL.md',
    '.agents/skills/review/SKILL.md',
    '.claude/CLAUDE.md',
    '.claude/skills/bench/SKILL.md',
    '.claude/skills/review/SKILL.md',
    '.codex/AGENTS.md',
    '.config/opencode/AGENTS.md',
  ]);
  // The AGENTS.md of the set becomes the user instructions file of each harness.
  assert.equal(files.get('.claude/CLAUDE.md')?.content, 'House rules.\n');
  assert.equal(files.get('.codex/AGENTS.md')?.content, 'House rules.\n');
  assert.equal(files.get('.config/opencode/AGENTS.md')?.content, 'House rules.\n');
  // In both layouts, a skill is a directory with a SKILL.md.
  assert.equal(files.get('.claude/skills/review/SKILL.md')?.content, '---\nname: review\n---\n');
  assert.equal(files.get('.agents/skills/review/SKILL.md')?.content, '---\nname: review\n---\n');
  assert.equal(files.get('.claude/skills/bench/SKILL.md')?.content, 'Run the benchmarks.\n');
});

test('every packed path is home-relative and inside a layout', async () => {
  // The file service installs each path relative to the home.
  // It refuses a path outside the five prefixes below.
  store.updateSet('', 'global', { agentsMd: 'House rules.' });
  store.putItem('', 'global', { name: 'review', content: 'x' });

  for (const rel of await paths(null)) {
    assert.match(
      rel,
      /^(\.claude\/(CLAUDE\.md|skills\/)|\.codex\/AGENTS\.md|\.config\/opencode\/AGENTS\.md|\.agents\/skills\/)/,
      `${rel} is not in a layout the file service accepts`,
    );
  }
});

test('a box with nothing configured gets an empty set', async () => {
  assert.deepEqual(await paths(null), []);
});

test('the skills of the orchestrator are packed, and a skill of the set wins', async () => {
  let builtins = [
    { name: 'diagrams', content: 'orchestrator diagrams' },
    { name: 'share-app', content: 'orchestrator share-app' },
  ];
  store = new AgentStore(db, dir, undefined, () => builtins);
  store.putItem('', 'global', { name: 'diagrams', content: 'own diagrams' });

  const files = await packed(null);
  assert.equal(files.get('.claude/skills/diagrams/SKILL.md')?.content, 'own diagrams\n');
  assert.equal(files.get('.agents/skills/share-app/SKILL.md')?.content, 'orchestrator share-app\n');

  // The next tar holds only the skills of the set, so the next install removes the built-in skills.
  builtins = [];
  assert.deepEqual(await paths(null), [
    '.agents/skills/diagrams/SKILL.md',
    '.claude/skills/diagrams/SKILL.md',
  ]);
});

test('a repository is pulled when it is added, and its skills are listed', async () => {
  remotes['https://example.com/skills'] = {
    'skills/pdf/SKILL.md': 'pdf',
    'skills/pdf/reference.md': 'more',
  };
  const set = await store.addRepo('', 'global', { url: 'https://example.com/skills', ref: 'v1' });

  assert.deepEqual(fetches, ['https://example.com/skills@v1']);
  assert.equal(set.repoCount, 1);
  assert.deepEqual(
    set.repos.map(({ url, ref, commit, skills, error }) => ({ url, ref, commit, skills, error })),
    [
      {
        url: 'https://example.com/skills',
        ref: 'v1',
        commit: 'c0ffee',
        skills: ['pdf'],
        error: null,
      },
    ],
  );
  assert.deepEqual(store.bundle('', null).skills, [
    { name: 'pdf', repo: 'https://example.com/skills' },
  ]);
});

test('a skill of the set wins over a repository, and an earlier repository over a later one', async () => {
  remotes['https://example.com/one'] = { 'review/SKILL.md': 'one', 'lint/SKILL.md': 'one' };
  remotes['https://example.com/two'] = { 'lint/SKILL.md': 'two', 'ship/SKILL.md': 'two' };
  await store.addRepo('', 'global', { url: 'https://example.com/one' });
  await store.addRepo('', 'global', { url: 'https://example.com/two' });
  store.putItem('', 'global', { name: 'review', content: 'mine' });

  assert.deepEqual(store.bundle('', null).skills, [
    { name: 'lint', repo: 'https://example.com/one' },
    { name: 'review', repo: null },
    { name: 'ship', repo: 'https://example.com/two' },
  ]);
});

test('a repository of the selected set wins over a skill of the global set', async () => {
  remotes['https://example.com/go'] = { 'review/SKILL.md': 'go' };
  store.putItem('', 'global', { name: 'review', content: 'global' });
  const set = store.createSet('', 'go');
  await store.addRepo('', set.id, { url: 'https://example.com/go' });

  const bundle = store.bundle('', set.id);
  assert.deepEqual(bundle.skills, [{ name: 'review', repo: 'https://example.com/go' }]);
  assert.deepEqual(bundle.overrides, ['review']);
});

test('a repository skill is copied with all its files, without its links', async () => {
  remotes['https://example.com/skills'] = {
    'skills/pdf/SKILL.md': 'pdf',
    'skills/pdf/scripts/run.sh': '#!/bin/sh\n',
  };
  const set = await store.addRepo('', 'global', { url: 'https://example.com/skills' });
  const tree = join(dir, 'skill-repos', set.repos[0]!.id, 'tree', 'skills', 'pdf');
  chmodSync(join(tree, 'scripts', 'run.sh'), 0o755);
  symlinkSync('/etc/passwd', join(tree, 'passwd'));

  const files = await packed(null);

  assert.deepEqual([...files.keys()].sort(), [
    '.agents/skills/pdf/SKILL.md',
    '.agents/skills/pdf/scripts/run.sh',
    '.claude/skills/pdf/SKILL.md',
    '.claude/skills/pdf/scripts/run.sh',
  ]);
  assert.equal(files.get('.claude/skills/pdf/SKILL.md')?.content, 'pdf');
  assert.equal(files.get('.agents/skills/pdf/scripts/run.sh')?.content, '#!/bin/sh\n');
  assert.equal((files.get('.claude/skills/pdf/scripts/run.sh')?.mode ?? 0) & 0o111, 0o111);
});

test('a skill that changes source leaves no file of the old one behind', async () => {
  remotes['https://example.com/skills'] = {
    'pdf/SKILL.md': 'repo',
    'pdf/extra.md': 'extra',
  };
  await store.addRepo('', 'global', { url: 'https://example.com/skills' });
  store.putItem('', 'global', { name: 'pdf', content: 'mine' });

  assert.deepEqual(await paths(null), [
    '.agents/skills/pdf/SKILL.md',
    '.claude/skills/pdf/SKILL.md',
  ]);
});

test('a failed pull is recorded, and the skills of the last good pull stay', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const set = await store.addRepo('', 'global', { url: 'https://example.com/skills' });
  remotes['https://example.com/skills'] = 'repository not found';

  const after = await store.refreshRepo('', 'global', set.repos[0]!.id);

  assert.equal(after.repos[0]!.error, 'repository not found');
  assert.deepEqual(after.repos[0]!.skills, ['pdf']);
  assert.equal((await packed(null)).get('.claude/skills/pdf/SKILL.md')?.content, 'pdf');
});

test('a repository that cannot be pulled at all is still added', async () => {
  const set = await store.addRepo('', 'global', { url: 'https://example.com/missing' });
  assert.equal(set.repos[0]!.error, 'not found');
  assert.equal(set.repos[0]!.commit, null);
  assert.deepEqual(store.bundle('', null).skills, []);
});

test('removing a repository removes its checkout and its skills', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const set = await store.addRepo('', 'global', { url: 'https://example.com/skills' });
  const id = set.repos[0]!.id;

  const after = store.deleteRepo('', 'global', id);

  assert.deepEqual(after.repos, []);
  assert.equal(existsSync(join(dir, 'skill-repos', id)), false);
  assert.deepEqual(store.bundle('', null).skills, []);
});

test('deleting a set removes the checkouts of its repositories', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const set = store.createSet('', 'go');
  const id = (await store.addRepo('', set.id, { url: 'https://example.com/skills' })).repos[0]!.id;

  store.deleteSet('', set.id);

  assert.equal(existsSync(join(dir, 'skill-repos', id)), false);
});

test('the daily pull takes the repositories pulled a day ago, and removes stray checkouts', async () => {
  remotes['https://example.com/old'] = { 'a/SKILL.md': 'a' };
  remotes['https://example.com/new'] = { 'b/SKILL.md': 'b' };
  const old = (await store.addRepo('', 'global', { url: 'https://example.com/old' })).repos[0]!;
  await store.addRepo('', 'global', { url: 'https://example.com/new' });
  db.prepare('UPDATE agent_repos SET pulled_at = 0 WHERE id = ?').run(old.id);
  mkdirSync(join(dir, 'skill-repos', 'stray'));
  fetches = [];

  await store.pullDue();

  assert.deepEqual(fetches, ['https://example.com/old@']);
  assert.equal(existsSync(join(dir, 'skill-repos', 'stray')), false);
});

test('two pulls of one repository at the same time fetch once', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const id = (await store.addRepo('', 'global', { url: 'https://example.com/skills' })).repos[0]!
    .id;
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
      store.addRepo('', 'global', body),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400,
      `expected ${JSON.stringify(body)} to be refused`,
    );
  }
  assert.deepEqual(fetches, []);
});

test('an unknown repository is a 404, also in another set', async () => {
  remotes['https://example.com/skills'] = { 'pdf/SKILL.md': 'pdf' };
  const id = (await store.addRepo('', 'global', { url: 'https://example.com/skills' })).repos[0]!
    .id;
  const other = store.createSet('', 'other');
  for (const call of [
    () => store.refreshRepo('', other.id, id),
    async () => store.deleteRepo('', other.id, id),
    () => store.refreshRepo('', 'global', 'nope'),
  ]) {
    await assert.rejects(
      call(),
      (err: unknown) => err instanceof HttpError && err.statusCode === 404,
    );
  }
});

test('a skill name that is not a safe path component is refused', () => {
  for (const name of ['../escape', 'a/b', '-lead', 'sk ill', '.hidden', '', 'a'.repeat(65)]) {
    assert.throws(
      () => store.putItem('', 'global', { name, content: 'x' }),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400,
      `expected ${JSON.stringify(name)} to be refused`,
    );
  }
});

test('a name is lowercased rather than refused for its case alone', () => {
  const set = store.putItem('', 'global', { name: 'Review', content: 'x' });
  assert.equal(set.items[0]!.name, 'review');
});

test('CRLF is normalised, because the agent reads these as files', () => {
  store.putItem('', 'global', { name: 'ship', content: 'a\r\nb\rc' });
  assert.equal(store.getSet('', 'global').items[0]!.content, 'a\nb\nc');
});

test('writing a skill under a name that exists replaces it', () => {
  store.putItem('', 'global', { name: 'ship', content: 'one' });
  const set = store.putItem('', 'global', { name: 'ship', content: 'two' });
  assert.equal(set.items.length, 1);
  assert.equal(set.items[0]!.content, 'two');
});

test('an unknown set is a 404 on every route into it', () => {
  for (const call of [
    () => store.getSet('', 'nope'),
    () => store.updateSet('', 'nope', { name: 'x' }),
    () => store.deleteSet('', 'nope'),
    () => store.putItem('', 'nope', { name: 'x', content: '' }),
    () => store.deleteItem('', 'nope', 'x'),
  ]) {
    assert.throws(call, (err: unknown) => err instanceof HttpError && err.statusCode === 404);
  }
});

test('a set counts the live boxes that selected it', () => {
  const set = store.createSet('', 'go');
  insertBox('s1', set.id);
  insertBox('s2', null);
  assert.equal(store.getSet('', set.id).boxCount, 1);
});

test('deleting a set leaves its boxes alone and falls them back to global', () => {
  const set = store.createSet('', 'go');
  insertBox('s1', set.id);

  store.deleteSet('', set.id);

  const row = db.prepare('SELECT agent_set_id, status FROM boxes WHERE id = ?').get('s1') as {
    agent_set_id: string | null;
    status: string;
  };
  assert.equal(row.status, 'running');
  assert.equal(row.agent_set_id, null);
});

test('a set going away takes its skills with it', () => {
  const set = store.createSet('', 'go');
  store.putItem('', set.id, { name: 'review', content: 'x' });
  store.deleteSet('', set.id);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM agent_items').get() as { n: number };
  assert.equal(rows.n, 0);
});

test('each user has their own sets and global set, and a pull uses the owner of the set', async () => {
  remotes['https://example.com/skills.git'] = { 'skills/one/SKILL.md': 'one' };
  const aliceGlobal = store.globalId('alice');
  store.updateSet('alice', aliceGlobal, { agentsMd: 'Alice rules' });
  const set = store.createSet('bob', 'Bob set');
  await store.addRepo('bob', set.id, { url: 'https://example.com/skills.git' });

  assert.deepEqual(owners, ['bob']);
  assert.deepEqual(
    store.listSets('alice').map((s) => [s.name, s.global]),
    [['Global', true]],
  );
  assert.deepEqual(
    store.listSets('bob').map((s) => [s.name, s.global]),
    [
      ['Global', true],
      ['Bob set', false],
    ],
  );
  assert.throws(() => store.getSet('alice', set.id), /not found/);
  assert.equal(store.bundle('alice', null).agentsMd, 'Alice rules');
  assert.equal(store.bundle('bob', null).agentsMd, '');
  // A set of another user counts as no selection.
  assert.deepEqual(store.bundle('alice', set.id).skills, []);
});

/**
 * Makes an API key row of the empty user.
 *
 * @param name The environment variable name of the key.
 * @param hosts The hosts of the key.
 * @returns The row, with a fixed placeholder.
 */
function apiKey(name: string, hosts: string[]): ApiKeyRow {
  return {
    owner: '',
    name,
    hosts,
    secret: `secret-of-${name}`,
    placeholder: `placeholder-of-${name}`,
    created_at: 0,
    updated_at: 0,
  };
}

/** The API keys that the MCP store of a test reads. */
let keys: ApiKeyRow[];

/** The egress allowlist that the MCP store of a test reads. */
let allowlist: string[];

/**
 * Makes a store that reads {@link keys} and {@link allowlist}.
 *
 * @returns The store.
 */
function mcpStore(): AgentStore {
  keys = [apiKey('GITHUB_MCP_TOKEN', ['api.githubcopilot.com', 'mcp.example.com:8443'])];
  allowlist = [];
  return new AgentStore(db, dir, undefined, undefined, () => ({
    keys,
    allowedHosts: allowlist,
  }));
}

/** A server with a bearer token from an API key. */
const GITHUB_MCP = {
  name: 'github',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: [{ name: 'Authorization', value: `Bearer \${GITHUB_MCP_TOKEN}` }],
};

test('an MCP server is stored with its references and replaced under its name', () => {
  const mcp = mcpStore();
  const set = mcp.createSet('', 'Work');

  mcp.putMcpServer('', set.id, { ...GITHUB_MCP, name: ' GitHub ' });
  const after = mcp.putMcpServer('', set.id, {
    ...GITHUB_MCP,
    headers: [...GITHUB_MCP.headers, { name: 'X-Tenant', value: 'engineering' }],
  });

  assert.deepEqual(after.mcpServers, [
    {
      ...GITHUB_MCP,
      headers: [...GITHUB_MCP.headers, { name: 'X-Tenant', value: 'engineering' }],
      warning: null,
    },
  ]);
  const stored = db.prepare('SELECT headers FROM agent_mcp_servers').get() as { headers: string };
  assert.ok(!stored.headers.includes('placeholder-of'));
  assert.ok(!stored.headers.includes('secret-of'));

  assert.deepEqual(mcp.deleteMcpServer('', set.id, 'github').mcpServers, []);
  assert.throws(() => mcp.deleteMcpServer('', set.id, 'github'), /No such MCP server/);
});

test('an MCP server is checked at save', () => {
  const mcp = mcpStore();
  const id = mcp.globalId('');
  /**
   * Saves a variant of the GitHub server.
   *
   * @param over The fields to replace.
   * @returns The changed set.
   */
  const put = (over: Partial<typeof GITHUB_MCP>) =>
    mcp.putMcpServer('', id, { ...GITHUB_MCP, ...over });
  /**
   * Makes the headers field with one header.
   *
   * @param name The header name.
   * @param value The header value.
   * @returns The field.
   */
  const header = (name: string, value: string) => ({ headers: [{ name, value }] });

  assert.throws(() => put({ name: 'a'.repeat(33) }), /32 characters/);
  assert.throws(() => put({ name: '-x' }), /lowercase/);
  assert.throws(() => put({ url: 'mcp.example.com' }), /absolute/);
  assert.throws(() => put({ url: 'ftp://mcp.example.com/' }), /absolute/);
  assert.throws(() => put({ url: 'https://user:pw@api.githubcopilot.com/' }), /credentials/);
  assert.throws(() => put({ url: 'https://10.0.0.5/mcp', headers: [] }), /private address/);
  assert.throws(() => put({ url: 'https://[::1]/mcp', headers: [] }), /private address/);
  assert.throws(() => put({ url: 'http://api.githubcopilot.com/mcp/' }), /https/);
  assert.throws(() => put({ url: 'https://other.example.com:9000/', headers: [] }), /port 9000/);
  assert.throws(() => put(header('Bad Name', 'x')), /not a valid header name/);
  assert.throws(() => put(header('Mcp-Session-Id', 'x')), /sets Mcp-Session-Id itself/);
  assert.throws(() => put(header('Authorization', 'Bearer ghp_literal')), /into an API key/);
  assert.throws(() => put(header('X-Key', `\${UNKNOWN}`)), /no API key UNKNOWN/);
  assert.throws(() => put(header('X-Key', '${GITHUB_MCP_TOKEN')), /not a reference/);
  assert.throws(() => put(header('X-Key', 'a\r\nX-Other: b')), /control character/);
  assert.throws(() => put(header('X-Key', 'x'.repeat(4097))), /longer than 4096/);
  assert.throws(
    () =>
      put({
        ...header('Authorization', `Bearer \${GITHUB_MCP_TOKEN}`),
        url: 'https://other.example.com/',
      }),
    /do not include other.example.com/,
  );
  assert.throws(
    () => put({ headers: [GITHUB_MCP.headers[0]!, { name: 'authorization', value: 'x' }] }),
    /given twice/,
  );
  assert.throws(
    () => put({ headers: Array.from({ length: 21 }, (_, i) => ({ name: `X-${i}`, value: 'v' })) }),
    /at most 20 headers/,
  );

  // A port that a key names for the host, and a server without authentication.
  assert.doesNotThrow(() => put({ url: 'https://mcp.example.com:8443/mcp' }));
  assert.doesNotThrow(() => put({ name: 'open', url: 'http://open.example.com/mcp', headers: [] }));

  for (let i = 0; i < 18; i++)
    put({ name: `s${i}`, headers: [], url: 'https://open.example.com/' });
  assert.throws(() => put({ name: 'one-too-many' }), /at most 20 MCP servers/);
});

test('an MCP server shows a warning when the agent will probably not reach it', () => {
  const mcp = mcpStore();
  const id = mcp.globalId('');
  mcp.putMcpServer('', id, GITHUB_MCP);
  mcp.putMcpServer('', id, { name: 'open', url: 'https://open.example.com/mcp', headers: [] });

  allowlist = ['registry.npmjs.org'];
  keys = [apiKey('GITHUB_MCP_TOKEN', ['github.com'])];
  assert.deepEqual(
    mcp.getSet('', id).mcpServers.map((server) => server.warning),
    [
      'The hosts of the API key GITHUB_MCP_TOKEN do not include api.githubcopilot.com',
      'The egress proxy does not allow open.example.com. Ask the admin to add it to the allowlist',
    ],
  );

  allowlist = ['*.example.com'];
  keys = [];
  assert.deepEqual(
    mcp.getSet('', id).mcpServers.map((server) => server.warning),
    ['The API key GITHUB_MCP_TOKEN does not exist, so the agent does not get this server', null],
  );
});

test('the MCP servers of a set replace the servers of the global set with the same name', () => {
  const mcp = mcpStore();
  const globalId = mcp.globalId('');
  const set = mcp.createSet('', 'Work');
  mcp.putMcpServer('', globalId, GITHUB_MCP);
  mcp.putMcpServer('', globalId, {
    name: 'docs',
    url: 'https://docs.example.com/mcp',
    headers: [],
  });
  mcp.putMcpServer('', set.id, { name: 'docs', url: 'https://docs.example.org/mcp', headers: [] });

  const preview = mcp.bundle('', set.id);
  assert.deepEqual(preview.mcpServers, [
    { name: 'docs', url: 'https://docs.example.org/mcp' },
    { name: 'github', url: GITHUB_MCP.url },
  ]);
  assert.deepEqual(preview.mcpOverrides, ['docs']);
  assert.deepEqual(mcp.bundle('', null).mcpOverrides, []);
  assert.deepEqual(
    mcp.mcpSnapshot('', set.id).map((server) => server.url),
    ['https://docs.example.org/mcp', GITHUB_MCP.url],
  );
});

test('the references of an MCP server become the placeholders, and a server without its key is left out', () => {
  const mcp = mcpStore();
  const servers = [
    GITHUB_MCP,
    {
      name: 'gone',
      url: 'https://gone.example.com/',
      headers: [{ name: 'X-Key', value: `\${GONE}` }],
    },
  ];

  assert.deepEqual(mcp.mcpServersFor('', servers), [
    {
      type: 'http',
      name: 'github',
      url: GITHUB_MCP.url,
      headers: [{ name: 'Authorization', value: 'Bearer placeholder-of-GITHUB_MCP_TOKEN' }],
    },
  ]);
});
