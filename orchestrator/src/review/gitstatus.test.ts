import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { fileService, setFileServiceSpawnerForTests } from '../files.ts';
import { inProcessFileService } from '../files-in-process.ts';
import { type GitRunner, type GitTarget, setGitRunnerForTests } from './git.ts';
import {
  baseRev,
  fileStatuses,
  NO_BASE,
  parseNameStatus,
  parsePathList,
  parsePorcelain,
  resolveBase,
  resolveBases,
  workspaceStatuses,
} from './gitstatus.ts';
import { discoverRepos } from './repos.ts';

/**
 * A runner that starts git on this machine, in the directory the target names,
 * over repositories that the tests build.
 *
 * @param target The target whose directory git runs in.
 * @param argv The command line.
 * @param env The variables added to the environment.
 * @returns The result of git.
 */
const localGit: GitRunner = async (target, argv, env) => {
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), {
      cwd: target.dir,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (err) {
    const failed = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      code: failed.status ?? null,
    };
  }
};

/**
 * Makes a git target for a local directory.
 *
 * @param dir The local directory.
 * @returns The git target.
 */
function at(dir: string): GitTarget {
  return { boxId: 'box-1', dir };
}

describe('parsePorcelain', () => {
  /**
   * Builds `git status -z` output, with a NUL byte at the end of each record.
   *
   * @param entries The records.
   * @returns The output.
   */
  function records(entries: string[]): string {
    return entries.map((entry) => `${entry}\0`).join('');
  }

  test('classifies the index and work-tree pairs', () => {
    const out = records([
      '?? new.txt',
      ' M modified.txt',
      'M  staged.txt',
      'MM staged-then-modified.txt',
      'A  added.txt',
      'D  deleted-staged.txt',
      ' D deleted.txt',
      'UU conflict.txt',
      'AA both-added.txt',
      'DD both-deleted.txt',
    ]);
    assert.deepEqual(parsePorcelain(out), {
      'new.txt': 'untracked',
      'modified.txt': 'modified',
      'staged.txt': 'staged',
      // A change in the work tree after the staged change shows as modified.
      'staged-then-modified.txt': 'modified',
      'added.txt': 'added',
      'deleted-staged.txt': 'deleted',
      'deleted.txt': 'deleted',
      'conflict.txt': 'conflict',
      'both-added.txt': 'conflict',
      'both-deleted.txt': 'conflict',
    });
  });

  test('an arrow in a name is part of the name, not a rename', () => {
    assert.deepEqual(parsePorcelain(records(['?? a -> b.txt'])), { 'a -> b.txt': 'untracked' });
  });

  test('a leading or a trailing space in a name survives', () => {
    assert.deepEqual(parsePorcelain(records(['??  leading.txt', '?? trailing.txt '])), {
      ' leading.txt': 'untracked',
      'trailing.txt ': 'untracked',
    });
  });

  test('short and empty records are skipped', () => {
    assert.deepEqual(parsePorcelain(''), {});
    assert.deepEqual(parsePorcelain(records(['', 'xy'])), {});
  });

  test('a path with a leading ./ is cleaned to match the tree', () => {
    assert.deepEqual(parsePorcelain(records(['?? ./a/b.txt'])), { 'a/b.txt': 'untracked' });
  });
});

describe('parseNameStatus', () => {
  test('maps the diff letters onto statuses', () => {
    const out = ['A\tadded.txt', 'D\tgone.txt', 'M\tchanged.txt', 'T\ttypechange.txt'].join('\n');
    assert.deepEqual(parseNameStatus(out), {
      'added.txt': 'added',
      'gone.txt': 'deleted',
      'changed.txt': 'modified',
      'typechange.txt': 'modified',
    });
  });

  test('a rename or copy reports the new path', () => {
    assert.deepEqual(parseNameStatus('R100\told.txt\tnew.txt'), { 'new.txt': 'modified' });
    assert.deepEqual(parseNameStatus('C75\tsrc.txt\tcopy.txt'), { 'copy.txt': 'modified' });
  });

  test('empty output is no statuses', () => {
    assert.deepEqual(parseNameStatus(''), {});
  });
});

test('parsePathList drops the empty trailing entry', () => {
  assert.deepEqual(parsePathList('a.txt\nb/c.txt\n'), ['a.txt', 'b/c.txt']);
  assert.deepEqual(parsePathList(''), []);
});

test('baseRev is HEAD until a base is chosen', () => {
  assert.equal(baseRev(NO_BASE), 'HEAD');
  assert.equal(baseRev({ rev: 'main', commit: 'abc123' }), 'abc123');
});

describe('over a real repository', () => {
  let dir: string;
  /**
   * Runs git in the test repository.
   *
   * @param args The arguments of git.
   * @returns The standard output.
   */
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });

  beforeEach(() => {
    setGitRunnerForTests(localGit);
    dir = mkdtempSync(join(tmpdir(), 'boxes-status-'));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    writeFileSync(join(dir, 'tracked.txt'), 'x\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    setGitRunnerForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a changed tracked file is modified', async () => {
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n');
    const statuses = await fileStatuses(at(dir), NO_BASE);
    assert.equal(statuses?.['tracked.txt'], 'modified');
  });

  test('untracked files in a new directory are listed individually', async () => {
    // The file tree lists them individually too, so a collapsed directory
    // entry would match none of them.
    mkdirSync(join(dir, 'newdir', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'newdir', 'a.go'), 'x\n');
    writeFileSync(join(dir, 'newdir', 'sub', 'b.go'), 'x\n');

    const statuses = await fileStatuses(at(dir), NO_BASE);
    assert.equal(statuses?.['newdir/a.go'], 'untracked');
    assert.equal(statuses?.['newdir/sub/b.go'], 'untracked');
  });

  test('a rename is reported as a deletion and an addition', async () => {
    // The tree can show a removed file only when something reports it gone.
    run('mv', 'tracked.txt', 'moved.txt');

    const statuses = await fileStatuses(at(dir), NO_BASE);
    assert.equal(statuses?.['tracked.txt'], 'deleted');
    assert.equal(statuses?.['moved.txt'], 'added');
  });

  test('a directory that is no repository has no statuses at all', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'boxes-nogit-'));
    try {
      // Null, because an empty result means a repository without changes.
      assert.equal(await fileStatuses(at(bare), NO_BASE), null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('a base resolves through the merge base, so the branch owns its changes', async () => {
    run('checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'feature.txt'), 'mine\n');
    run('add', '.');
    run('commit', '-q', '-m', 'feature work');

    // A commit on main after the branch point must not show as a change of this branch.
    run('checkout', '-q', 'main');
    writeFileSync(join(dir, 'theirs.txt'), 'not mine\n');
    run('add', '.');
    run('commit', '-q', '-m', 'main moves on');
    const mainTip = run('rev-parse', 'HEAD').trim();
    run('checkout', '-q', 'feature');

    const resolved = await resolveBase(at(dir), 'main');
    assert.ok('base' in resolved);
    assert.equal(resolved.base.rev, 'main');
    assert.notEqual(resolved.base.commit, mainTip);
    assert.equal(resolved.base.commit, run('merge-base', 'main', 'HEAD').trim());

    const statuses = await fileStatuses(at(dir), resolved.base);
    assert.equal(statuses?.['feature.txt'], 'added');
    assert.equal(statuses?.['theirs.txt'], undefined);
  });

  test('a base also covers uncommitted work and untracked files', async () => {
    const first = run('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'tracked.txt'), 'edited\n');
    writeFileSync(join(dir, 'brand-new.txt'), 'new\n');

    const statuses = await fileStatuses(at(dir), { rev: first, commit: first });
    assert.equal(statuses?.['tracked.txt'], 'modified');
    assert.equal(statuses?.['brand-new.txt'], 'untracked');
  });

  test('an unknown revision is refused by name', async () => {
    const resolved = await resolveBase(at(dir), 'no-such-branch');
    assert.ok('error' in resolved);
    assert.match(resolved.error, /unknown revision/);
  });

  test('outside a repository there is no base to resolve', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'boxes-nogit-'));
    try {
      const resolved = await resolveBase(at(bare), 'HEAD');
      assert.ok('error' in resolved);
      assert.match(resolved.error, /not a git repository/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  /** A time before every file of the test repository. */
  const PAST = new Date(2000, 0, 1);

  /**
   * Gives the index a time before its files. Git then reads the content of every
   * file on each status, until it saves the index again.
   */
  function makeIndexRacy(): void {
    utimesSync(join(dir, '.git', 'index'), PAST, PAST);
  }

  /**
   * Checks if git saved the index after {@link makeIndexRacy}.
   *
   * @returns True when the index is newer than the time that {@link makeIndexRacy} gave it.
   */
  function indexSaved(): boolean {
    return statSync(join(dir, '.git', 'index')).mtimeMs > PAST.getTime();
  }

  test('a status saves the refreshed index', async () => {
    makeIndexRacy();
    assert.deepEqual(await fileStatuses(at(dir), NO_BASE), {});
    assert.ok(indexSaved());
  });

  test('a status against a base saves the refreshed index', async () => {
    makeIndexRacy();
    const head = run('rev-parse', 'HEAD').trim();
    assert.deepEqual(await fileStatuses(at(dir), { rev: head, commit: head }), {});
    assert.ok(indexSaved());
  });
});

describe('over a workspace of several repositories', () => {
  let dir: string;

  beforeEach(() => {
    setGitRunnerForTests(localGit);
    setFileServiceSpawnerForTests(
      inProcessFileService((root) => ({ workspace: root, home: root, nix: root })),
    );
    dir = mkdtempSync(join(tmpdir(), 'boxes-wsstatus-'));
  });

  afterEach(() => {
    setGitRunnerForTests(null);
    setFileServiceSpawnerForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Makes the git box for the test workspace.
   *
   * @returns The box id and the workspace directory.
   */
  function box(): { boxId: string; workspaceDir: string } {
    return { boxId: 'box-1', workspaceDir: dir };
  }

  /**
   * Runs git in a workspace-relative directory.
   *
   * @param rel The workspace-relative directory, or '' for the workspace.
   * @param args The arguments of git.
   * @returns The standard output.
   */
  const git = (rel: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd: rel === '' ? dir : join(dir, rel),
      stdio: 'pipe',
      encoding: 'utf8',
    });

  /**
   * Creates a repository with one committed file in it.
   *
   * @param rel The workspace-relative directory of the repository, or '' for the workspace.
   */
  function repo(rel: string): void {
    mkdirSync(rel === '' ? dir : join(dir, rel), { recursive: true });
    git(rel, 'init', '-q', '-b', 'main');
    git(rel, 'config', 'user.email', 'test@example.com');
    git(rel, 'config', 'user.name', 'test');
    // Repository-specific content, so two repositories built the same way in
    // the same second do not end up with the same commit id.
    file(rel === '' ? 'tracked.txt' : `${rel}/tracked.txt`, `${rel}\n`);
    git(rel, 'add', '.');
    git(rel, 'commit', '-q', '-m', 'init');
  }

  /**
   * Writes a workspace-relative file, creating the directories above it.
   *
   * @param rel The workspace-relative path of the file.
   * @param content The content of the file.
   */
  function file(rel: string, content = 'x\n'): void {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content);
  }

  /**
   * Reads the merged statuses of the workspace.
   *
   * @param rev The revision to compare against in each repository, or '' to compare against HEAD.
   * @returns The statuses by workspace-relative path.
   */
  async function statuses(rev = ''): Promise<Record<string, string>> {
    const map = await discoverRepos(fileService(dir), box());
    return workspaceStatuses(box(), map, await resolveBases(box(), map, rev));
  }

  test('every repository contributes, under its own prefix', async () => {
    repo('repo-a');
    repo('repo-b');
    file('repo-a/tracked.txt', 'changed\n');
    file('repo-b/new.txt');

    assert.deepEqual(await statuses(), {
      'repo-a/tracked.txt': 'modified',
      'repo-b/new.txt': 'untracked',
    });
  });

  test('a nested repository owns its own files, and the outer one does not claim it', async () => {
    repo('outer');
    repo('outer/inner');
    file('outer/inner/new.txt');

    const merged = await statuses();
    // The outer repository reports the inner work tree as `inner/`, and the merge drops it.
    assert.equal(merged['outer/inner/new.txt'], 'untracked');
    assert.equal(merged['outer/inner'], undefined);
    assert.equal(merged['outer/inner/tracked.txt'], undefined);
  });

  test('a workspace with no repository has no statuses', async () => {
    file('notes/todo.md');
    assert.deepEqual(await statuses(), {});
  });

  test('one revision resolves separately in each repository', async () => {
    repo('repo-a');
    repo('repo-b');
    for (const name of ['repo-a', 'repo-b']) {
      git(name, 'checkout', '-q', '-b', 'feature');
      file(`${name}/feature.txt`);
      git(name, 'add', '.');
      git(name, 'commit', '-q', '-m', 'feature work');
    }

    const map = await discoverRepos(fileService(dir), box());
    const bases = await resolveBases(box(), map, 'main');
    assert.equal(bases.size, 2);
    // Each repository has its own merge base with `main`.
    assert.notEqual(bases.get('repo-a')!.commit, bases.get('repo-b')!.commit);

    const merged = await workspaceStatuses(box(), map, bases);
    assert.equal(merged['repo-a/feature.txt'], 'added');
    assert.equal(merged['repo-b/feature.txt'], 'added');
  });

  test('a repository the revision names nothing in falls back to its HEAD', async () => {
    repo('repo-a');
    repo('repo-b');
    git('repo-a', 'branch', 'release');
    file('repo-b/tracked.txt', 'changed\n');

    const map = await discoverRepos(fileService(dir), box());
    const bases = await resolveBases(box(), map, 'release');
    assert.deepEqual([...bases.keys()], ['repo-a']);

    const merged = await workspaceStatuses(box(), map, bases);
    assert.equal(merged['repo-b/tracked.txt'], 'modified');
  });

  test('no revision resolves nothing anywhere', async () => {
    repo('repo-a');
    const map = await discoverRepos(fileService(dir), box());
    assert.equal((await resolveBases(box(), map, '')).size, 0);
    assert.equal((await resolveBases(box(), map, 'no-such-branch')).size, 0);
  });
});
