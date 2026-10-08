import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fetchRepo, findSkills, repoName } from './skill-repos.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-skill-repos-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes files under `root`, creating the directories on the way. */
function files(root: string, contents: Record<string, string>): void {
  for (const [rel, content] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

/** Runs git in `cwd` without any user configuration. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { cwd, env: { PATH: process.env['PATH'], GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' },
  ).trim();
}

/** Creates a source repository with one commit of `contents` on `main`. Returns its path. */
function source(contents: Record<string, string>): string {
  const src = join(dir, 'src');
  mkdirSync(src);
  git(src, 'init', '--quiet', '--initial-branch', 'main');
  files(src, contents);
  git(src, 'add', '.');
  git(src, 'commit', '--quiet', '-m', 'one');
  return src;
}

/** Accepts the names the agent store accepts. */
const valid = (name: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);

// --- fetching -----------------------------------------------------------------

test('a fetch checks out the default branch and returns its commit', async () => {
  const src = source({ 'skills/a/SKILL.md': 'one' });
  const repo = join(dir, 'repo');

  const commit = await fetchRepo(repo, src, '', null, () => true);

  assert.equal(commit, git(src, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(repo, 'tree', 'skills/a/SKILL.md'), 'utf8'), 'one');
  // Only the checkout stays; the git directory goes after each fetch.
  assert.equal(existsSync(join(repo, 'git.new')), false);
  assert.equal(existsSync(join(repo, 'tree', '.git')), false);
});

test('a fetch at a branch or a commit checks out that one', async () => {
  const src = source({ 'skills/a/SKILL.md': 'one' });
  const first = git(src, 'rev-parse', 'HEAD');
  git(src, 'checkout', '--quiet', '-b', 'next');
  files(src, { 'skills/a/SKILL.md': 'two' });
  git(src, 'commit', '--quiet', '-am', 'two');
  git(src, 'checkout', '--quiet', 'main');
  const repo = join(dir, 'repo');

  await fetchRepo(repo, src, 'next', null, () => true);
  assert.equal(readFileSync(join(repo, 'tree', 'skills/a/SKILL.md'), 'utf8'), 'two');

  assert.equal(await fetchRepo(repo, src, first, null, () => true), first);
  assert.equal(readFileSync(join(repo, 'tree', 'skills/a/SKILL.md'), 'utf8'), 'one');
});

test('a failed fetch names the cause and keeps the checkout it had', async () => {
  const src = source({ 'skills/a/SKILL.md': 'one' });
  const repo = join(dir, 'repo');
  await fetchRepo(repo, src, '', null, () => true);

  await assert.rejects(
    fetchRepo(repo, src, 'nope', null, () => true),
    /couldn't find remote ref nope/,
  );
  assert.equal(readFileSync(join(repo, 'tree', 'skills/a/SKILL.md'), 'utf8'), 'one');
  assert.equal(existsSync(join(repo, 'tree.new')), false);
});

test('a fetch for a repository removed meanwhile leaves nothing behind', async () => {
  const src = source({ 'skills/a/SKILL.md': 'one' });
  const repo = join(dir, 'repo');

  await fetchRepo(repo, src, '', null, () => false);

  assert.equal(existsSync(repo), false);
});

// --- finding skills -----------------------------------------------------------

test('every directory with a SKILL.md is a skill, at any depth', () => {
  const tree = join(dir, 'tree');
  files(tree, {
    'skills/pdf/SKILL.md': '',
    'skills/pdf/scripts/run.sh': '',
    '.claude/skills/dev/SKILL.md': '',
    'plugins/x/skills/deep/SKILL.md': '',
    'README.md': '',
  });

  assert.deepEqual(findSkills(tree, 'repo', valid, 100), [
    { name: 'pdf', path: 'skills/pdf' },
    { name: 'dev', path: '.claude/skills/dev' },
    { name: 'deep', path: 'plugins/x/skills/deep' },
  ]);
});

test('a SKILL.md at the root is named after the repository', () => {
  const tree = join(dir, 'tree');
  files(tree, { 'SKILL.md': '', 'sub/SKILL.md': '' });
  // A skill is not searched for skills of its own.
  assert.deepEqual(findSkills(tree, 'my-skill', valid, 100), [{ name: 'my-skill', path: '' }]);
});

test('the shallower of two skills of the same name wins', () => {
  const tree = join(dir, 'tree');
  files(tree, { 'a/b/review/SKILL.md': '', 'z/review/SKILL.md': '' });
  assert.deepEqual(findSkills(tree, 'repo', valid, 100), [{ name: 'review', path: 'z/review' }]);
});

test('names that cannot be installed are skipped, and the count is capped', () => {
  const tree = join(dir, 'tree');
  files(tree, {
    'skills/Upper/SKILL.md': '',
    'skills/has space/SKILL.md': '',
    'skills/a/SKILL.md': '',
    'skills/b/SKILL.md': '',
    'skills/c/SKILL.md': '',
  });
  // Upper case is lowered, as a skill name of a set is.
  assert.deepEqual(
    findSkills(tree, 'repo', valid, 3).map((s) => s.name),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    findSkills(tree, 'repo', valid, 100).map((s) => s.name),
    ['a', 'b', 'c', 'upper'],
  );
});

test('the search does not follow a link out of the checkout', () => {
  const tree = join(dir, 'tree');
  files(tree, { 'README.md': '' });
  files(join(dir, 'outside'), { 'secret/SKILL.md': '' });
  symlinkSync(join(dir, 'outside'), join(tree, 'linked'));
  assert.deepEqual(findSkills(tree, 'repo', valid, 100), []);
});

test('a repository name is the last path segment without .git', () => {
  assert.equal(repoName('https://github.com/anthropics/skills'), 'skills');
  assert.equal(repoName('https://example.com/a/b/my-skill.git/'), 'my-skill');
});
