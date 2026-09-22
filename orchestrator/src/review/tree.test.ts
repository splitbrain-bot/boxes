import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import type { ReviewDirEntry, ReviewFileStatus } from '../../../shared/types.ts';
import { setGitRunnerForTests, type GitBox, type GitRunner } from './git.ts';
import { discoverRepos, RepoMap } from './repos.ts';
import {
  dirEntries,
  holdsDeleted,
  listedDir,
  listedFile,
  MAX_DIR_ENTRIES,
  readDir,
} from './tree.ts';

/**
 * The directory listing a review browses.
 *
 * One directory at a time: `readDir` is the one function here that touches the
 * filesystem, and `dirEntries` is pure and merges what it found with the two
 * maps a review holds. What git there is here is repository discovery, driven
 * through a runner that starts git on this machine over the test's own
 * repositories rather than in a box container.
 */

/** A runner that starts git here, in the directory the target names. */
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

/** A map with no repository in it, for the merges that are not about git. */
function noRepos(): RepoMap {
  return new RepoMap('/workspace', []);
}

/** The merged entries of one directory, named as `d:name` or `f:name`. */
function named(entries: ReviewDirEntry[]): string[] {
  return entries.map((entry) => `${entry.isDir ? 'd' : 'f'}:${entry.name}`);
}

describe('listedFile', () => {
  test('an ordinary file of any project is listed', () => {
    for (const path of ['a.txt', 'src/main.ts', 'node_modules/pkg/index.js', 'dist/out.js']) {
      assert.equal(listedFile(path), true, path);
    }
  });

  test('metadata, the review file and binaries are not', () => {
    // The same rule the listing applies, asked of one path — which is what the
    // file endpoint serves by, so it offers exactly what a directory offered.
    for (const path of ['.git/config', 'repo/.git/HEAD', '.boxes/attached.txt']) {
      assert.equal(listedFile(path), false, path);
    }
    assert.equal(listedFile('REVIEW.md'), false);
    assert.equal(listedFile('logo.PNG'), false);
    assert.equal(listedFile('tool.exe'), false);
  });

  test("a REVIEW.md deeper in the tree is a file of the project", () => {
    assert.equal(listedFile('docs/REVIEW.md'), true);
  });

  test('a directory is judged on its segments alone', () => {
    // `assets.zip` is a fine name for a folder, and a folder is never the
    // review's own file.
    assert.equal(listedDir('assets.zip'), true);
    assert.equal(listedDir('src/util'), true);
    assert.equal(listedDir('.git'), false);
    assert.equal(listedDir('repo/.git/objects'), false);
  });
});

describe('readDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-dir-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Creates a file, and the directories above it. */
  function file(rel: string, content = 'x\n'): void {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content);
  }

  test('one directory comes back, and nothing below it', () => {
    file('a.txt');
    file('src/main.ts');
    file('src/util/helpers.ts');
    assert.deepEqual(readDir(dir, '').toSorted((a, b) => (a.name < b.name ? -1 : 1)), [
      { name: 'a.txt', isDir: false },
      { name: 'src', isDir: true },
    ]);
    // Opening a folder is what reads it, so a dependency tree beside the code
    // costs nothing until somebody opens it.
    assert.deepEqual(readDir(dir, 'src').toSorted((a, b) => (a.name < b.name ? -1 : 1)), [
      { name: 'main.ts', isDir: false },
      { name: 'util', isDir: true },
    ]);
  });

  test('git metadata and binaries stay out, and nothing else does', () => {
    file('keep.ts');
    file('node_modules/pkg/index.js');
    file('dist/bundle.js');
    file('.git/config');
    file('.boxes/attached.txt');
    file('logo.png');
    file('tool.exe');
    // Out here no ignore file says what is noise, so every file a person can
    // read shows.
    assert.deepEqual(named(readDir(dir, '').map(asEntry)).toSorted(), [
      'd:dist',
      'd:node_modules',
      'f:keep.ts',
    ]);
  });

  test("the review's own file is left out, but only at the root", () => {
    file('REVIEW.md');
    file('docs/REVIEW.md');
    assert.deepEqual(named(readDir(dir, '').map(asEntry)).toSorted(), ['d:docs']);
    assert.deepEqual(named(readDir(dir, 'docs').map(asEntry)), ['f:REVIEW.md']);
  });

  test('a symlink is neither listed nor followed', () => {
    const outside = mkdtempSync(join(tmpdir(), 'boxes-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'not the agent business');
      file('real.txt');
      symlinkSync(outside, join(dir, 'escape'));
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));

      assert.deepEqual(named(readDir(dir, '').map(asEntry)), ['f:real.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a directory that is not there lists nothing rather than failing', () => {
    assert.deepEqual(readDir(dir, 'nosuch'), []);
  });

  test('the cap is a real number, not a placeholder', () => {
    assert.equal(MAX_DIR_ENTRIES, 2000);
  });

  /** A child as an entry, for the naming helper. */
  function asEntry(child: { name: string; isDir: boolean }): ReviewDirEntry {
    return { name: child.name, path: child.name, isDir: child.isDir };
  }
});

describe('dirEntries', () => {
  const children = [
    { name: 'src', isDir: true },
    { name: 'README.md', isDir: false },
    { name: 'app.ts', isDir: false },
  ];

  test('folders come first, then files, each in name order', () => {
    const entries = dirEntries('', children, {}, new Map(), noRepos());
    assert.deepEqual(named(entries), ['d:src', 'f:README.md', 'f:app.ts']);
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ['src', 'README.md', 'app.ts'],
    );
  });

  test('paths are the workspace’s, whatever directory is listed', () => {
    const entries = dirEntries('project/src', children, {}, new Map(), noRepos());
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ['project/src/src', 'project/src/README.md', 'project/src/app.ts'],
    );
  });

  test('a file carries its own status and its own comment count', () => {
    const entries = dirEntries(
      '',
      children,
      { 'app.ts': 'modified' },
      new Map([['app.ts', 3]]),
      noRepos(),
    );
    const app = entries.find((entry) => entry.name === 'app.ts')!;
    assert.equal(app.status, 'modified');
    assert.equal(app.comments, 3);
    // Absent rather than empty: a directory of a thousand files goes to a phone.
    const readme = entries.find((entry) => entry.name === 'README.md')!;
    assert.equal('status' in readme, false);
    assert.equal('comments' in readme, false);
  });

  test('a folder says what its whole subtree holds', () => {
    const entries = dirEntries(
      '',
      children,
      { 'src/deep/down/x.ts': 'modified' },
      new Map([['src/deep/other.ts', 1]]),
      noRepos(),
    );
    const src = entries.find((entry) => entry.name === 'src')!;
    // The badge a closed folder shows, from a prefix scan rather than a walk.
    assert.equal(src.changed, true);
    assert.equal(src.commented, true);
  });

  test('a file of another directory touches this one not at all', () => {
    const entries = dirEntries(
      'src',
      [{ name: 'a.ts', isDir: false }],
      { 'other/a.ts': 'modified', 'srcish/a.ts': 'modified' },
      new Map([['other/a.ts', 2]]),
      noRepos(),
    );
    assert.equal(entries[0]!.status, undefined);
    assert.equal(entries.length, 1);
  });

  test('a file the change deleted is listed, since nothing else can name it', () => {
    const entries = dirEntries(
      'src',
      [{ name: 'keep.ts', isDir: false }],
      { 'src/gone.ts': 'deleted', 'src/keep.ts': 'modified' },
      new Map(),
      noRepos(),
    );
    assert.deepEqual(named(entries), ['f:gone.ts', 'f:keep.ts']);
    assert.equal(entries[0]!.status, 'deleted');
    assert.equal(entries[0]!.path, 'src/gone.ts');
  });

  test('a deleted review file or binary stays out all the same', () => {
    const statuses: Record<string, ReviewFileStatus> = {
      'REVIEW.md': 'deleted',
      'logo.png': 'deleted',
      'a.ts': 'deleted',
    };
    assert.deepEqual(named(dirEntries('', [], statuses, new Map(), noRepos())), ['f:a.ts']);
  });

  test('a folder the change emptied is listed, so its files can be reached', () => {
    const entries = dirEntries('', [], { 'src/gone.ts': 'deleted' }, new Map(), noRepos());
    assert.deepEqual(named(entries), ['d:src']);
    assert.equal(entries[0]!.changed, true);
  });

  test('a file with a status but no entry is not invented', () => {
    // A binary one, say: it has a status and the listing leaves it out, and
    // only a deletion is worth putting back.
    assert.deepEqual(dirEntries('', [], { 'logo.png': 'modified' }, new Map(), noRepos()), []);
  });
});

describe('dirEntries over real repositories', () => {
  let dir: string;

  beforeEach(() => {
    setGitRunnerForTests(localGit);
    dir = mkdtempSync(join(tmpdir(), 'boxes-rdir-'));
  });

  afterEach(() => {
    setGitRunnerForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  /** The box this workspace would be reviewed in. */
  function box(): GitBox {
    return { containerId: 'box-1', workspaceDir: dir };
  }

  /** Initialises a repository at a workspace-relative path. */
  function repo(rel: string): void {
    const root = rel === '' ? dir : join(dir, rel);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  }

  /** Writes a file, creating the directories above it. */
  function file(rel: string, content = 'x\n'): void {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content);
  }

  test('the folder a repository is rooted at is marked, and no other', async () => {
    repo('repo-a');
    file('repo-a/src/x.ts');
    file('notes/todo.md');

    const map = await discoverRepos(dir, box());
    const root = dirEntries('', readDir(dir, ''), {}, new Map(), map);
    const byName = new Map(root.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('repo-a')?.repo, true);
    assert.equal(byName.get('notes')?.repo, undefined);

    // And not on a directory inside one, only on its root.
    const inside = dirEntries('repo-a', readDir(dir, 'repo-a'), {}, new Map(), map);
    assert.equal(inside.find((entry) => entry.name === 'src')?.repo, undefined);
  });

  test('a repository inside a repository is marked where it sits', async () => {
    repo('outer');
    file('outer/a.ts');
    repo('outer/inner');
    file('outer/inner/b.txt');

    const map = await discoverRepos(dir, box());
    const outer = dirEntries('outer', readDir(dir, 'outer'), {}, new Map(), map);
    assert.deepEqual(named(outer), ['d:inner', 'f:a.ts']);
    assert.equal(outer[0]!.repo, true);
  });
});

test('holdsDeleted finds a deletion anywhere under a directory', () => {
  const statuses: Record<string, ReviewFileStatus> = {
    'src/deep/gone.ts': 'deleted',
    'other/x.ts': 'modified',
  };
  assert.equal(holdsDeleted(statuses, 'src'), true);
  assert.equal(holdsDeleted(statuses, 'src/deep'), true);
  assert.equal(holdsDeleted(statuses, 'other'), false);
  assert.equal(holdsDeleted(statuses, 'nosuch'), false);
});
