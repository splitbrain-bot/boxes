import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import {
  buildTree,
  MAX_ENTRIES,
  reviewTree,
  treePaths,
  walkPaths,
  withDeleted,
  type TreeEntry,
} from './tree.ts';

/** The file tree, ported from the Go implementation's tests. */

describe('buildTree', () => {
  test('flat files come back in order', () => {
    const tree = buildTree(['c.txt', 'a.go', 'b.go']);
    assert.deepEqual(
      tree.map((e) => e.name),
      ['a.go', 'b.go', 'c.txt'],
    );
    assert.ok(tree.every((e) => !e.isDir));
  });

  test('directories come before files, each in order', () => {
    const tree = buildTree(['zebra.txt', 'alpha/file.go', 'beta.txt']);
    assert.deepEqual(
      tree.map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`),
      ['d:alpha', 'f:beta.txt', 'f:zebra.txt'],
    );
  });

  test('nesting is reproduced, with paths relative to the root', () => {
    const tree = buildTree(['src/main.go', 'src/util/helpers.go', 'README.md']);
    assert.equal(tree.length, 2);
    assert.equal(tree[0]!.name, 'src');
    assert.equal(tree[0]!.isDir, true);
    assert.equal(tree[1]!.name, 'README.md');

    const src = tree[0]!.children!;
    assert.equal(src[0]!.name, 'util');
    assert.equal(src[0]!.isDir, true);
    assert.equal(src[1]!.name, 'main.go');
    assert.equal(src[1]!.path, 'src/main.go');
  });

  test('deep nesting keeps every level', () => {
    const tree = buildTree(['a/b/c/d.txt']);
    const d = tree[0]!.children![0]!.children![0]!.children![0]!;
    assert.equal(d.name, 'd.txt');
    assert.equal(d.path, 'a/b/c/d.txt');
    assert.equal(d.isDir, false);
    // A file carries no children key at all, since files are the bulk of a
    // tree and the response goes to a phone.
    assert.equal('children' in d, false);
  });

  test('several files in one directory all arrive', () => {
    const tree = buildTree(['pkg/a.go', 'pkg/b.go', 'pkg/c.go']);
    assert.equal(tree[0]!.children!.length, 3);
  });

  test('no paths is an empty tree', () => {
    assert.deepEqual(buildTree([]), []);
  });
});

test('treePaths lists every file, and no directory', () => {
  const tree = buildTree(['src/main.go', 'src/util/helpers.go', 'README.md']);
  assert.deepEqual([...treePaths(tree)].toSorted(), [
    'README.md',
    'src/main.go',
    'src/util/helpers.go',
  ]);
});

describe('walkPaths', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-tree-'));
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

  test('walks a plain directory into relative paths', () => {
    file('a.txt');
    file('src/main.ts');
    const { paths, truncated } = walkPaths(dir);
    assert.deepEqual(paths.toSorted(), ['a.txt', 'src/main.ts']);
    assert.equal(truncated, false);
  });

  test('leaves out the noise directories and the binary extensions', () => {
    file('keep.ts');
    file('node_modules/pkg/index.js');
    file('dist/bundle.js');
    file('.git/config');
    file('vendor/lib.go');
    file('logo.png');
    file('tool.exe');
    assert.deepEqual(walkPaths(dir).paths, ['keep.ts']);
  });

  test("leaves out the review's own file, but only at the root", () => {
    file('REVIEW.md');
    file('docs/REVIEW.md');
    // A REVIEW.md deeper in the tree is a file of the project like any other.
    assert.deepEqual(walkPaths(dir).paths, ['docs/REVIEW.md']);
  });

  test('a symlink is neither listed nor followed', () => {
    const outside = mkdtempSync(join(tmpdir(), 'boxes-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'not the agent business');
      file('real.txt');
      symlinkSync(outside, join(dir, 'escape'));
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));

      const { paths } = walkPaths(dir);
      assert.deepEqual(paths, ['real.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the entry cap cuts a huge tree short and says so', () => {
    for (let i = 0; i < 12; i++) file(`f${i}.txt`);
    const { paths, truncated } = walkPaths(dir, 5);
    assert.equal(paths.length, 5);
    assert.equal(truncated, true);
  });

  test('the cap is a real number, not a placeholder', () => {
    assert.equal(MAX_ENTRIES, 20_000);
  });
});

describe('reviewTree', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-rtree-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a repository is listed by git, ignored files included in the ignoring', async () => {
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    };
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(dir, 'tracked.ts'), 'x\n');
    writeFileSync(join(dir, 'untracked.ts'), 'x\n');
    writeFileSync(join(dir, 'ignored.txt'), 'x\n');
    writeFileSync(join(dir, 'REVIEW.md'), '# Code Review\n');
    run('add', 'tracked.ts', '.gitignore');
    run('commit', '-q', '-m', 'init');

    const { entries, truncated } = await reviewTree(dir, true);
    const names = [...treePaths(entries)].toSorted();
    // Tracked and untracked, but not gitignored, and never REVIEW.md.
    assert.deepEqual(names, ['.gitignore', 'tracked.ts', 'untracked.ts']);
    assert.equal(truncated, false);
  });

  test('a plain directory falls back to a walk', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const { entries } = await reviewTree(dir, false);
    assert.deepEqual([...treePaths(entries)], ['a.txt']);
  });

  test('an empty repository still answers, with an empty tree', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
    // ls-files reports nothing, which is indistinguishable from "no
    // repository" — and both lead to the same walk, which finds nothing.
    const { entries } = await reviewTree(dir, true);
    assert.deepEqual(entries as TreeEntry[], []);
  });
});

describe('withDeleted', () => {
  test('a file the change removed is put back into the tree', () => {
    const entries = withDeleted(buildTree(['src/keep.ts']), ['src/gone.ts']);
    assert.deepEqual([...treePaths(entries)].toSorted(), ['src/gone.ts', 'src/keep.ts']);
  });

  test('a deletion of a file that is still there changes nothing', () => {
    const before = buildTree(['a.ts']);
    // Same array back, not a rebuilt copy: the common case is no deletions at
    // all, and every tree response goes through here.
    assert.equal(withDeleted(before, ['a.ts']), before);
  });

  test('the review file and ignored paths stay out', () => {
    const entries = withDeleted(buildTree(['a.ts']), ['REVIEW.md', 'logo.png', 'b.ts']);
    assert.deepEqual([...treePaths(entries)].toSorted(), ['a.ts', 'b.ts']);
  });
});
