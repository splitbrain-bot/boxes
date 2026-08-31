import assert from 'node:assert/strict';
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
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import type {
  ReviewAnnotationsResponse,
  ReviewBase,
  ReviewFileResponse,
  ReviewStatusResponse,
  ReviewTreeResponse,
} from '../../../shared/types.ts';
import { buildApp, type Orchestrator } from '../app.ts';
import { loadConfig, setConfigForTests } from '../config.ts';
import { openDb, type Db } from '../db.ts';
import { treePaths } from './tree.ts';

/**
 * The review routes over their real handlers, a real database and a real git
 * repository in a temp directory — no Docker anywhere.
 *
 * That is the payoff of workspaces being directories: what used to need a
 * container to read a file now needs a directory, so the API can be driven
 * end to end in a unit test.
 */

let dir: string;
let db: Db;
let orchestrator: Orchestrator;

/** The workspace directory the routes will read, for session `id`. */
function workspace(id: string): string {
  return join(dir, 'workspaces', id);
}

/** A directory-backed session row, which is all the review routes need. */
function insertSession(id: string): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, review_root,
       review_base_rev, review_base_commit, status, current_thread_id,
       created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       ?, '10.200.0.0/24', '', ?, ?, NULL, NULL, NULL, 'running', NULL, ?, ?)`,
  ).run(id, `sn-${id}`, `home-${id}`, workspace(id), now, now);
  const path = workspace(id);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A session whose workspace is still a named volume, as a legacy row is. */
function insertVolumeSession(id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, review_root,
       review_base_rev, review_base_commit, status, current_thread_id,
       created_at, last_active_at)
     VALUES (?, 'legacy', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       ?, '10.200.0.0/24', ?, ?, NULL, NULL, NULL, NULL, 'stopped', NULL, ?, ?)`,
  ).run(id, `sn-${id}`, `ws-${id}`, `home-${id}`, now, now);
}

/** Runs git in a directory with the ambient binary. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

/** Initialises a repository with a first commit. */
function initRepo(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
}

/** Writes a file, creating the directories above it. */
function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-review-'));
  // A fresh config per test rather than the process-wide one: every test gets
  // its own DATA_DIR, and the cached config would keep the first test's.
  const cfg = loadConfig({ ...process.env, DATA_DIR: dir });
  setConfigForTests(cfg);
  db = openDb(dir);
  orchestrator = buildApp(cfg, db);
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  setConfigForTests(null as never);
  rmSync(dir, { recursive: true, force: true });
});

/** GET, parsed. */
async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await orchestrator.app.inject({ url });
  return { status: res.statusCode, body: res.json() as T };
}

// --- the tree ---------------------------------------------------------------

describe('the tree endpoint', () => {
  test('a cloned project roots at its subdirectory, with git on', async () => {
    const ws = insertSession('aaa');
    // The shape a clone actually leaves: /workspace holds one directory and
    // that is the repository.
    const repo = join(ws, 'project');
    mkdirSync(repo);
    initRepo(repo);
    write(repo, 'src/app.ts', 'one\ntwo\n');
    write(repo, 'README.md', '# hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');

    const { status, body } = await get<ReviewTreeResponse>('/api/sessions/aaa/review/tree');
    assert.equal(status, 200);
    assert.equal(body.root, 'project');
    assert.equal(body.hasGit, true);
    assert.deepEqual([...treePaths(body.entries)].toSorted(), ['README.md', 'src/app.ts']);
    assert.equal(body.hasReview, false);
    assert.deepEqual(body.base, { rev: '', commit: '' });
  });

  test('a workspace that is itself a repository roots at the workspace', async () => {
    const ws = insertSession('bbb');
    initRepo(ws);
    write(ws, 'a.txt', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');

    const { body } = await get<ReviewTreeResponse>('/api/sessions/bbb/review/tree');
    assert.equal(body.root, '');
    assert.equal(body.hasGit, true);
  });

  test('a workspace with no git degrades to a plain tree', async () => {
    const ws = insertSession('ccc');
    write(ws, 'notes/todo.txt', 'x\n');

    const { body } = await get<ReviewTreeResponse>('/api/sessions/ccc/review/tree');
    assert.equal(body.hasGit, false);
    // Everything still works but the git features, the way the desktop tool
    // degrades outside a repository.
    assert.deepEqual([...treePaths(body.entries)], ['notes/todo.txt']);
    assert.deepEqual(body.statuses, {});
  });

  test('two subdirectories are ambiguous, so the workspace is the root', async () => {
    const ws = insertSession('ddd');
    for (const name of ['one', 'two']) {
      mkdirSync(join(ws, name));
      initRepo(join(ws, name));
      write(ws, `${name}/a.txt`, 'x\n');
    }
    const { body } = await get<ReviewTreeResponse>('/api/sessions/ddd/review/tree');
    assert.equal(body.root, '');
    assert.equal(body.hasGit, false);
  });

  test('the resolved root is remembered on the session row', async () => {
    const ws = insertSession('eee');
    const repo = join(ws, 'project');
    mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'x\n');

    await get<ReviewTreeResponse>('/api/sessions/eee/review/tree');
    const row = db.prepare('SELECT review_root FROM sessions WHERE id = ?').get('eee') as {
      review_root: string;
    };
    assert.equal(row.review_root, 'project');
  });

  test('statuses come back per path', async () => {
    const ws = insertSession('fff');
    initRepo(ws);
    write(ws, 'tracked.txt', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    write(ws, 'tracked.txt', 'changed\n');
    write(ws, 'fresh.txt', 'new\n');

    const { body } = await get<ReviewTreeResponse>('/api/sessions/fff/review/tree');
    assert.equal(body.statuses['tracked.txt'], 'modified');
    assert.equal(body.statuses['fresh.txt'], 'untracked');
  });

  test('an unknown session is a 404, a deleted one too', async () => {
    insertSession('ggg');
    db.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('ggg');
    assert.equal((await orchestrator.app.inject({ url: '/api/sessions/ggg/review/tree' })).statusCode, 404);
    assert.equal((await orchestrator.app.inject({ url: '/api/sessions/nope/review/tree' })).statusCode, 404);
  });

  test('a volume-backed session says what to do about it', async () => {
    insertVolumeSession('hhh');
    const res = await orchestrator.app.inject({ url: '/api/sessions/hhh/review/tree' });
    // 409, not 404: the session is real and the fix is one start.
    assert.equal(res.statusCode, 409);
    assert.match((res.json() as { error: string }).error, /Start the session once/);
  });
});

// --- the file ---------------------------------------------------------------

describe('the file endpoint', () => {
  /** A session with a repository at the workspace root and one commit. */
  function repoSession(id: string): string {
    const ws = insertSession(id);
    initRepo(ws);
    write(ws, 'code.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    write(ws, 'binary.dat', 'x');
    writeFileSync(join(ws, 'binary.dat'), Buffer.from([0x41, 0x00, 0x42]));
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    return ws;
  }

  test('a file arrives as plain text with its line count and language', async () => {
    repoSession('aaa');
    const { status, body } = await get<ReviewFileResponse>(
      '/api/sessions/aaa/review/file?path=code.ts',
    );
    assert.equal(status, 200);
    // Plain text, never render markup: the browser tokenizes, which is what
    // keeps the orchestrator out of presentation and every line addressable.
    assert.equal(body.content, 'one\ntwo\nthree\nfour\nfive\nsix\n');
    assert.equal(body.lines, 6);
    assert.equal(body.language, 'typescript');
    assert.equal(body.binary, false);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.annotations, []);
  });

  test('diff markers come with the file, in one response', async () => {
    const ws = repoSession('bbb');
    // two -> TWO, four and five removed, seven appended.
    write(ws, 'code.ts', 'one\nTWO\nthree\nsix\nseven\n');

    const { body } = await get<ReviewFileResponse>('/api/sessions/bbb/review/file?path=code.ts');
    assert.equal(body.status, 'modified');
    assert.equal(body.diff.lines['2'], 'modified');
    assert.equal(body.diff.lines['5'], 'added');
    assert.equal(body.diff.deletions.length, 1);
    assert.equal(body.diff.deletions[0]!.afterLine, 3);
    assert.ok(body.diff.hunks.length > 0);
  });

  test('a binary file is reported as one rather than refused', async () => {
    repoSession('ccc');
    const { status, body } = await get<ReviewFileResponse>(
      '/api/sessions/ccc/review/file?path=binary.dat',
    );
    // The tree legitimately lists files the viewer cannot show.
    assert.equal(status, 200);
    assert.equal(body.binary, true);
    assert.equal(body.content, '');
  });

  test('a path outside the root is a 404, however it is spelled', async () => {
    const ws = repoSession('ddd');
    writeFileSync(join(dir, 'boxes.db.copy'), 'the deployment token');
    // A traversal, a link out, and a link through a directory all look like an
    // unknown file, so an attempt learns nothing.
    symlinkSync(join(dir, 'boxes.db.copy'), join(ws, 'stolen.txt'));
    mkdirSync(join(ws, 'sub'));
    symlinkSync(dir, join(ws, 'sub', 'escape'));

    for (const path of [
      '../boxes.db',
      '../../etc/passwd',
      'stolen.txt',
      'sub/escape/boxes.db.copy',
      '/etc/passwd',
      'nosuch.txt',
    ]) {
      const res = await orchestrator.app.inject({
        url: `/api/sessions/ddd/review/file?path=${encodeURIComponent(path)}`,
      });
      assert.equal(res.statusCode, 404, path);
    }
  });

  test('a file the tree leaves out is not served either', async () => {
    const ws = repoSession('eee');
    write(ws, 'node_modules/pkg/index.js', 'x\n');
    write(ws, 'REVIEW.md', '# Code Review\n');
    // The API serves what the browser was offered and nothing more.
    for (const path of ['node_modules/pkg/index.js', 'REVIEW.md']) {
      const res = await orchestrator.app.inject({
        url: `/api/sessions/eee/review/file?path=${encodeURIComponent(path)}`,
      });
      assert.equal(res.statusCode, 404, path);
    }
  });

  test('a directory is not a file', async () => {
    repoSession('fff');
    const res = await orchestrator.app.inject({ url: '/api/sessions/fff/review/file?path=.' });
    assert.equal(res.statusCode, 404);
  });

  test('a missing path parameter is a 400', async () => {
    repoSession('ggg');
    const res = await orchestrator.app.inject({ url: '/api/sessions/ggg/review/file' });
    assert.equal(res.statusCode, 400);
  });

  test('an untracked file is entirely new', async () => {
    const ws = repoSession('hhh');
    write(ws, 'fresh.ts', 'a\nb\n');
    const { body } = await get<ReviewFileResponse>('/api/sessions/hhh/review/file?path=fresh.ts');
    assert.equal(body.status, 'untracked');
    assert.deepEqual(body.diff.lines, { 1: 'added', 2: 'added' });
  });
});

// --- annotations ------------------------------------------------------------

describe('annotations', () => {
  /** A session with a repository and one file to comment on. */
  function commentable(id: string): string {
    const ws = insertSession(id);
    initRepo(ws);
    write(ws, 'code.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    return ws;
  }

  /** PUT one annotation. */
  async function put(
    id: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: ReviewAnnotationsResponse }> {
    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/review/annotations`,
      payload,
    });
    return { status: res.statusCode, body: res.json() as ReviewAnnotationsResponse };
  }

  test('a comment is written into REVIEW.md in the workspace', async () => {
    const ws = commentable('aaa');
    const { status, body } = await put('aaa', {
      path: 'code.ts',
      line: 3,
      comment: 'this needs a name',
    });
    assert.equal(status, 200);
    assert.deepEqual(body.annotations, [
      { line: 3, comment: 'this needs a name', outdated: false },
    ]);

    // The file is the review, and it is where the agent works — which is what
    // makes "address the comments in REVIEW.md" a one-line prompt.
    const written = readFileSync(join(ws, 'REVIEW.md'), 'utf8');
    assert.match(written, /^# Code Review\n/);
    assert.match(written, /## `code\.ts`/);
    assert.match(written, /#### Line 3/);
    assert.match(written, /this needs a name/);
    // With the context that lets the comment be followed when the code moves.
    assert.match(written, /```typescript context\n/);
  });

  test('the review is readable back through the API', async () => {
    commentable('bbb');
    await put('bbb', { path: 'code.ts', line: 2, comment: 'second' });
    await put('bbb', { path: 'code.ts', line: 5, comment: 'fifth' });

    const { body } = await get<ReviewFileResponse>('/api/sessions/bbb/review/file?path=code.ts');
    assert.deepEqual(body.annotations, [
      { line: 2, comment: 'second', outdated: false },
      { line: 5, comment: 'fifth', outdated: false },
    ]);

    const tree = await get<ReviewTreeResponse>('/api/sessions/bbb/review/tree');
    assert.deepEqual(tree.body.counts, { 'code.ts': 2 });
    assert.equal(tree.body.hasReview, true);
    assert.match(tree.body.started, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('setting the same line twice replaces the comment', async () => {
    commentable('ccc');
    await put('ccc', { path: 'code.ts', line: 3, comment: 'first' });
    const { body } = await put('ccc', { path: 'code.ts', line: 3, comment: 'second' });
    assert.deepEqual(body.annotations, [{ line: 3, comment: 'second', outdated: false }]);
  });

  test('a comment is deleted, and the last one takes the file with it', async () => {
    const ws = commentable('ddd');
    await put('ddd', { path: 'code.ts', line: 3, comment: 'x' });
    await put('ddd', { path: 'code.ts', line: 4, comment: 'y' });

    const first = await orchestrator.app.inject({
      method: 'DELETE',
      url: '/api/sessions/ddd/review/annotations?path=code.ts&line=3',
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual((first.json() as ReviewAnnotationsResponse).annotations, [
      { line: 4, comment: 'y', outdated: false },
    ]);

    await orchestrator.app.inject({
      method: 'DELETE',
      url: '/api/sessions/ddd/review/annotations?path=code.ts&line=4',
    });
    const written = readFileSync(join(ws, 'REVIEW.md'), 'utf8');
    // The document stays valid with nothing in it.
    assert.ok(!written.includes('code.ts'));
    const tree = await get<ReviewTreeResponse>('/api/sessions/ddd/review/tree');
    assert.deepEqual(tree.body.counts, {});
  });

  test('a comment the agent wrote by hand is read, not overwritten', async () => {
    const ws = commentable('eee');
    // REVIEW.md is shared: the agent can edit it, and the next mutation has to
    // build on what it wrote rather than on a stale parse.
    writeFileSync(
      join(ws, 'REVIEW.md'),
      '# Code Review\n\n_Started: 2020-01-01_\n\n---\n\n## `code.ts`\n\n' +
        '#### Line 1\n\nwritten by the agent\n',
    );
    const { body } = await put('eee', { path: 'code.ts', line: 6, comment: 'written by the API' });
    assert.deepEqual(body.annotations, [
      { line: 1, comment: 'written by the agent', outdated: false },
      { line: 6, comment: 'written by the API', outdated: false },
    ]);
    // And the review's own start date is kept, not reset to today.
    assert.match(readFileSync(join(ws, 'REVIEW.md'), 'utf8'), /_Started: 2020-01-01_/);
  });

  test('a comment survives its code moving', async () => {
    const ws = commentable('fff');
    await put('fff', { path: 'code.ts', line: 3, comment: 'about three' });
    // Two lines inserted above it.
    write(ws, 'code.ts', 'new\nnew\none\ntwo\nthree\nfour\nfive\nsix\n');

    const { body } = await get<ReviewFileResponse>('/api/sessions/fff/review/file?path=code.ts');
    assert.deepEqual(body.annotations, [{ line: 5, comment: 'about three', outdated: false }]);
    // Relocation is persisted, so the agent reads the right line too.
    assert.match(readFileSync(join(ws, 'REVIEW.md'), 'utf8'), /#### Line 5/);
  });

  test('a comment whose code is gone is marked outdated, not dropped', async () => {
    const ws = commentable('ggg');
    await put('ggg', { path: 'code.ts', line: 3, comment: 'about three' });
    write(ws, 'code.ts', 'completely\ndifferent\ncontent\n');

    const { body } = await get<ReviewFileResponse>('/api/sessions/ggg/review/file?path=code.ts');
    assert.deepEqual(body.annotations, [{ line: 3, comment: 'about three', outdated: true }]);
    assert.match(readFileSync(join(ws, 'REVIEW.md'), 'utf8'), /#### Line 3 \(outdated\)/);
  });

  test('a comment on a deleted file is marked outdated by the tree fetch', async () => {
    const ws = commentable('hhh');
    await put('hhh', { path: 'code.ts', line: 3, comment: 'about three' });
    rmSync(join(ws, 'code.ts'));

    await get<ReviewTreeResponse>('/api/sessions/hhh/review/tree');
    assert.match(readFileSync(join(ws, 'REVIEW.md'), 'utf8'), /#### Line 3 \(outdated\)/);
  });

  test('bad input is refused before REVIEW.md is touched', async () => {
    const ws = commentable('iii');
    for (const payload of [
      { path: 'code.ts', line: 0, comment: 'x' },
      { path: 'code.ts', line: -1, comment: 'x' },
      { path: 'code.ts', line: 1.5, comment: 'x' },
      { path: 'code.ts', line: 1, comment: '   ' },
      { path: 'code.ts', line: 1, comment: 'x'.repeat(20_001) },
      { line: 1, comment: 'x' },
    ]) {
      const res = await orchestrator.app.inject({
        method: 'PUT',
        url: '/api/sessions/iii/review/annotations',
        payload,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(existsSync(join(ws, 'REVIEW.md')), false);
  });

  test('a comment on a path outside the root is a 404', async () => {
    const ws = commentable('jjj');
    for (const path of ['../escape.txt', 'nosuch.ts', 'node_modules/x.js']) {
      const res = await orchestrator.app.inject({
        method: 'PUT',
        url: '/api/sessions/jjj/review/annotations',
        payload: { path, line: 1, comment: 'x' },
      });
      assert.equal(res.statusCode, 404, path);
    }
    assert.equal(existsSync(join(ws, 'REVIEW.md')), false);
  });

  test('concurrent comments all survive', async () => {
    commentable('kkk');
    // Every write re-serializes the whole parsed file under the session's
    // lock, so a burst cannot lose one.
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((line) => put('kkk', { path: 'code.ts', line, comment: `c${line}` })),
    );
    const { body } = await get<ReviewFileResponse>('/api/sessions/kkk/review/file?path=code.ts');
    assert.deepEqual(
      body.annotations.map((a) => a.line),
      [1, 2, 3, 4, 5, 6],
    );
  });
});

// --- new review -------------------------------------------------------------

describe('deleting the review', () => {
  test('REVIEW.md is removed, and the counts go with it', async () => {
    const ws = insertSession('aaa');
    initRepo(ws);
    write(ws, 'a.ts', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/aaa/review/annotations',
      payload: { path: 'a.ts', line: 1, comment: 'x' },
    });

    const res = await orchestrator.app.inject({
      method: 'DELETE',
      url: '/api/sessions/aaa/review',
    });
    assert.equal(res.statusCode, 204);
    assert.equal(existsSync(join(ws, 'REVIEW.md')), false);

    const tree = await get<ReviewTreeResponse>('/api/sessions/aaa/review/tree');
    assert.deepEqual(tree.body.counts, {});
    assert.equal(tree.body.hasReview, false);
  });

  test('deleting a review that is not there is not an error', async () => {
    insertSession('bbb');
    const res = await orchestrator.app.inject({
      method: 'DELETE',
      url: '/api/sessions/bbb/review',
    });
    assert.equal(res.statusCode, 204);
  });
});

// --- the base revision ------------------------------------------------------

describe('the base revision', () => {
  /** A repository with a main commit and a feature branch on top. */
  function branched(id: string): string {
    const ws = insertSession(id);
    initRepo(ws);
    write(ws, 'base.txt', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    git(ws, 'checkout', '-q', '-b', 'feature');
    write(ws, 'mine.txt', 'mine\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'feature work');
    return ws;
  }

  /** PUT the base. */
  async function setBase(id: string, rev: string | null): Promise<{ status: number; body: ReviewBase }> {
    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/review/base`,
      payload: { rev },
    });
    return { status: res.statusCode, body: res.json() as ReviewBase };
  }

  test('a branch resolves through the merge base and is remembered', async () => {
    const ws = branched('aaa');
    const { status, body } = await setBase('aaa', 'main');
    assert.equal(status, 200);
    assert.equal(body.rev, 'main');
    assert.equal(body.commit, git(ws, 'merge-base', 'main', 'HEAD').trim());

    const row = db
      .prepare('SELECT review_base_rev, review_base_commit FROM sessions WHERE id = ?')
      .get('aaa') as { review_base_rev: string; review_base_commit: string };
    assert.equal(row.review_base_rev, 'main');
    assert.equal(row.review_base_commit, body.commit);
  });

  test('with a base set, the branch own changes are what is reported', async () => {
    const ws = branched('bbb');
    // A commit on main after branching off must not become this branch's.
    git(ws, 'checkout', '-q', 'main');
    write(ws, 'theirs.txt', 'not mine\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'main moves on');
    git(ws, 'checkout', '-q', 'feature');

    await setBase('bbb', 'main');
    const { body } = await get<ReviewTreeResponse>('/api/sessions/bbb/review/tree');
    assert.equal(body.base.rev, 'main');
    assert.equal(body.statuses['mine.txt'], 'added');
    assert.equal(body.statuses['theirs.txt'], undefined);
  });

  test('a base changes what a file diff is against', async () => {
    branched('ccc');
    // Without a base, a committed file is not a change.
    const before = await get<ReviewFileResponse>('/api/sessions/ccc/review/file?path=mine.txt');
    assert.deepEqual(before.body.diff.lines, {});

    await setBase('ccc', 'main');
    const after = await get<ReviewFileResponse>('/api/sessions/ccc/review/file?path=mine.txt');
    assert.deepEqual(after.body.diff.lines, { 1: 'added' });
  });

  test('null clears the base back to HEAD', async () => {
    branched('ddd');
    await setBase('ddd', 'main');
    const { body } = await setBase('ddd', null);
    assert.deepEqual(body, { rev: '', commit: '' });
    const tree = await get<ReviewTreeResponse>('/api/sessions/ddd/review/tree');
    assert.deepEqual(tree.body.base, { rev: '', commit: '' });
  });

  test('an unknown revision is refused by name', async () => {
    branched('eee');
    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/eee/review/base',
      payload: { rev: 'no-such-branch' },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /unknown revision/);
  });

  test('a workspace with no git cannot have a base', async () => {
    const ws = insertSession('fff');
    write(ws, 'a.txt', 'x\n');
    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/fff/review/base',
      payload: { rev: 'main' },
    });
    assert.equal(res.statusCode, 409);
  });
});

// --- the poll ---------------------------------------------------------------

describe('the status fingerprint', () => {
  test('it moves when the review, the working tree or HEAD moves', async () => {
    const ws = insertSession('aaa');
    initRepo(ws);
    write(ws, 'code.ts', 'one\ntwo\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');

    const first = (await get<ReviewStatusResponse>('/api/sessions/aaa/review/status')).body;
    assert.equal(first.reviewHash, '');
    assert.match(first.headCommit, /^[0-9a-f]{40}$/);

    // Asking again with nothing changed must answer the same, or the poll
    // would refetch everything every few seconds.
    assert.deepEqual((await get<ReviewStatusResponse>('/api/sessions/aaa/review/status')).body, first);

    await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/aaa/review/annotations',
      payload: { path: 'code.ts', line: 1, comment: 'x' },
    });
    const afterComment = (await get<ReviewStatusResponse>('/api/sessions/aaa/review/status')).body;
    assert.notEqual(afterComment.reviewHash, '');

    write(ws, 'code.ts', 'one\nTWO\n');
    const afterEdit = (await get<ReviewStatusResponse>('/api/sessions/aaa/review/status')).body;
    assert.notEqual(afterEdit.statusHash, afterComment.statusHash);

    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'second');
    const afterCommit = (await get<ReviewStatusResponse>('/api/sessions/aaa/review/status')).body;
    assert.notEqual(afterCommit.headCommit, afterEdit.headCommit);
  });

  test('polling a review does not hold off the reaper', async () => {
    const ws = insertSession('bbb');
    write(ws, 'a.txt', 'x\n');
    db.prepare('UPDATE sessions SET last_active_at = 0 WHERE id = ?').run('bbb');

    await get<ReviewStatusResponse>('/api/sessions/bbb/review/status');
    await get<ReviewTreeResponse>('/api/sessions/bbb/review/tree');
    await get<ReviewFileResponse>('/api/sessions/bbb/review/file?path=a.txt');

    // Reviewing is not the agent working, so it must not keep a box alive.
    const row = db.prepare('SELECT last_active_at FROM sessions WHERE id = ?').get('bbb') as {
      last_active_at: number;
    };
    assert.equal(row.last_active_at, 0);
  });

  test('a workspace with no git still has a fingerprint', async () => {
    const ws = insertSession('ccc');
    write(ws, 'a.txt', 'x\n');
    const { body } = await get<ReviewStatusResponse>('/api/sessions/ccc/review/status');
    assert.deepEqual(body, { reviewHash: '', headCommit: '', statusHash: '' });
  });
});
