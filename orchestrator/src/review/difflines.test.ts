import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { allLinesAdded, fileDiff, parseDiff, type LineChange } from './difflines.ts';
import { NO_BASE } from './gitstatus.ts';

/**
 * Unified diff to gutter markers. The tables are ports of the Go
 * implementation's, which is what says these markers are the right ones.
 */

describe('parseDiff line markers', () => {
  const cases: Array<{ name: string; diff: string; want: Record<number, LineChange> }> = [
    {
      name: 'pure addition',
      diff: `diff --git a/foo.go b/foo.go
index abc..def 100644
--- a/foo.go
+++ b/foo.go
@@ -10,3 +10,6 @@ func existing()
 keep1
 keep2
 keep3
+line1
+line2
+line3
`,
      want: { 13: 'added', 14: 'added', 15: 'added' },
    },
    {
      name: 'modification replaces lines',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -5,2 +5,2 @@ package main
-oldA
-oldB
+newA
+newB
`,
      want: { 5: 'modified', 6: 'modified' },
    },
    {
      name: 'pure deletion marks no line',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -5,4 +5,1 @@ package main
 keep
-old1
-old2
-old3
`,
      want: {},
    },
    {
      name: 'addition and modification in one hunk',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -1,4 +1,5 @@
 keep1
-old
+new
 keep2
+appended
`,
      want: { 2: 'modified', 4: 'added' },
    },
    {
      name: 'single line, no count in the header',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -1 +1 @@
-old
+new
`,
      want: { 1: 'modified' },
    },
    {
      name: 'an unchanged empty line keeps the numbering',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -1,3 +1,4 @@
 keep

+added
 tail
`,
      want: { 3: 'added' },
    },
    {
      name: 'no newline at end of file',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`,
      want: { 1: 'modified' },
    },
  ];

  for (const { name, diff, want } of cases) {
    test(name, () => {
      assert.deepEqual(parseDiff(diff).lines, want);
    });
  }
});

describe('parseDiff deletion markers', () => {
  const cases = [
    {
      name: 'deletion between kept lines',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -1,6 +1,3 @@
 keep1
 keep2
-old1
-old2
-old3
 keep3
`,
      want: [{ afterLine: 2, hunkIndex: 0 }],
    },
    {
      name: 'no deletion when lines are replaced',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -5,2 +5,2 @@ package main
-old
+new
`,
      want: [],
    },
    {
      name: 'deletion at the top of the file',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -1,4 +1,2 @@
-line1
-line2
 keep1
 keep2
`,
      want: [{ afterLine: 0, hunkIndex: 0 }],
    },
    { name: 'empty diff', diff: '', want: [] },
    {
      name: 'deletions in separate hunks point at their own hunk',
      diff: `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -3,2 +3,1 @@
 keep
-removed1
@@ -10,3 +9,1 @@
 keep
-removed2
-removed3
`,
      want: [
        { afterLine: 3, hunkIndex: 0 },
        { afterLine: 9, hunkIndex: 1 },
      ],
    },
  ];

  for (const { name, diff, want } of cases) {
    test(name, () => {
      assert.deepEqual(parseDiff(diff).deletions, want);
    });
  }
});

test('parseDiff records each hunk range and its raw text', () => {
  const diff = `diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -1,3 +1,4 @@
 keep
-old
+new
+extra
@@ -20,2 +21,2 @@
 tail
-gone
+here
`;
  const { hunks } = parseDiff(diff);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]!.startLine, 1);
  assert.equal(hunks[0]!.endLine, 4);
  // The raw text is what the hunk sheet shows, so it is kept verbatim.
  assert.equal(hunks[0]!.diff, ' keep\n-old\n+new\n+extra\n');
  assert.equal(hunks[1]!.startLine, 21);
  assert.equal(hunks[1]!.endLine, 22);
});

test('an untracked file is entirely added', () => {
  assert.deepEqual(allLinesAdded('a\nb\nc\n'), { 1: 'added', 2: 'added', 3: 'added' });
  // A file with no trailing newline still has its last line counted.
  assert.deepEqual(allLinesAdded('a\nb'), { 1: 'added', 2: 'added' });
  assert.deepEqual(allLinesAdded(''), {});
});

// --- against git's own output ------------------------------------------------

describe('over output git actually produces', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-diff-'));
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    };
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    writeFileSync(join(dir, 'tracked.txt'), 'x\n');
    writeFileSync(join(dir, 'code.go'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a modification, a deletion and an append are all marked', async () => {
    // two -> TWO, four and five removed, seven appended.
    writeFileSync(join(dir, 'code.go'), 'one\nTWO\nthree\nsix\nseven\n');
    const info = await fileDiff(dir, NO_BASE, 'code.go', '');

    assert.equal(info.lines[2], 'modified');
    assert.equal(info.lines[5], 'added');
    assert.equal(info.deletions.length, 1);
    assert.equal(info.deletions[0]!.afterLine, 3);
    // The marker has to point at a hunk that exists, since tapping it shows it.
    const index = info.deletions[0]!.hunkIndex;
    assert.ok(index >= 0 && index < info.hunks.length);
  });

  test('an untracked file counts as entirely new', async () => {
    writeFileSync(join(dir, 'fresh.go'), 'a\nb\nc\n');
    const info = await fileDiff(dir, NO_BASE, 'fresh.go', 'a\nb\nc\n');
    assert.deepEqual(info.lines, { 1: 'added', 2: 'added', 3: 'added' });
  });

  test('an unchanged file has nothing to report', async () => {
    const info = await fileDiff(dir, NO_BASE, 'tracked.txt', 'x\n');
    assert.deepEqual(info, { lines: {}, hunks: [], deletions: [] });
  });

  test('a file outside any repository has nothing to report', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'boxes-nogit-'));
    try {
      writeFileSync(join(bare, 'a.txt'), 'a\n');
      // Degrading rather than failing is the point: a workspace need not be a
      // repository at all.
      assert.deepEqual(await fileDiff(bare, NO_BASE, 'a.txt', 'a\n'), {
        lines: {},
        hunks: [],
        deletions: [],
      });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
