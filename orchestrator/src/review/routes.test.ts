import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import type {
  ReviewAnnotationsResponse,
  ReviewBaseResponse,
  ReviewDirEntry,
  ReviewDirResponse,
  ReviewFileResponse,
} from '../../../shared/types.ts';
import { buildApp, type Orchestrator } from '../app.ts';
import { loadConfig, setConfigForTests } from '../config.ts';
import { openDb, type Db } from '../db.ts';
import { SessionManager } from '../sessions.ts';
import { setGitRunnerForTests, type GitRunner, type GitTarget } from './git.ts';

/**
 * The review routes over their real handlers, a real database and a real git
 * repository in a temp directory — no Docker anywhere.
 *
 * Files are read off the workspace directory, which is why the API can be
 * driven end to end in a unit test at all. Git is the other half: the routes
 * ask the session for a running container and address every invocation at a
 * path inside it, so both of those are stubbed here — the box by a manager
 * that hands out the session id, and git by a runner that starts it on this
 * machine over the workspace the box would have held.
 *
 * The review is over the *workspace*, so most of what is worth pinning down
 * here is a workspace shape: two clones side by side, a clone beside a stray
 * directory, a repository inside a repository. Each of those turns the whole
 * review into a plain file browser with no git in it when it goes wrong.
 */

/** Invocations addressed at anything but a session's own workspace. */
let misaddressed: GitTarget[] = [];

/** How many times git has been run, for the paths that must not run it. */
let invocations = 0;

/**
 * A runner that starts git here, in the host directory that the container
 * path names.
 *
 * The workspace is at `/workspace` inside a box, and the stubbed container id
 * is the session's own, so the two together say which directory on this
 * machine an invocation means. One addressed anywhere else is recorded and
 * refused rather than run.
 */
const localGit: GitRunner = async (target, argv, env) => {
  invocations++;
  const inside = target.dir === '/workspace' || target.dir.startsWith('/workspace/');
  if (!inside || !existsSync(workspace(target.containerId))) {
    misaddressed.push(target);
    return { ok: false, stdout: '', stderr: 'misaddressed', code: null };
  }
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), {
      cwd: join(workspace(target.containerId), target.dir.slice('/workspace'.length)),
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
       network_name, subnet, ws_volume, home_volume, workspace_dir,
       review_base_rev, status, current_thread_id, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       ?, '10.200.0.0/24', '', ?, ?, NULL, 'running', NULL, ?, ?)`,
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
       network_name, subnet, ws_volume, home_volume, workspace_dir,
       review_base_rev, status, current_thread_id, created_at, last_active_at)
     VALUES (?, 'legacy', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       ?, '10.200.0.0/24', ?, ?, NULL, NULL, 'stopped', NULL, ?, ?)`,
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
  misaddressed = [];
  invocations = 0;
  // The box a review runs git in: no container is started here, so the
  // session id stands in for one and the workspace is where it always is.
  // Asking for the box marks the session active, as the real one does, because
  // that is the half of it these tests are about.
  vi.spyOn(SessionManager.prototype, 'execTarget').mockImplementation(async function (
    this: SessionManager,
    id: string,
  ) {
    this.touch(id);
    return { containerId: id, workingDir: '/workspace' };
  });
  setGitRunnerForTests(localGit);
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  setGitRunnerForTests(null);
  vi.restoreAllMocks();
  setConfigForTests(null as never);
  rmSync(dir, { recursive: true, force: true });
  // Every invocation the requests above made was addressed to the session's
  // own container and to a path inside its workspace.
  assert.deepEqual(misaddressed, []);
});

/** GET, parsed. */
async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await orchestrator.app.inject({ url });
  return { status: res.statusCode, body: res.json() as T };
}

// --- the directory listing --------------------------------------------------

/**
 * One directory of a review, at the workspace root unless a path is given.
 *
 * `fresh` is what the browser sends on arrival: it takes git's answer for the
 * workspace again. The tests that watch something change over two requests
 * need it, which is exactly the shape the browser has.
 */
async function openDir(
  id: string,
  path = '',
  fresh = true,
): Promise<{ status: number; body: ReviewDirResponse }> {
  const query = `path=${encodeURIComponent(path)}${fresh ? '&fresh=1' : ''}`;
  return get<ReviewDirResponse>(`/api/sessions/${id}/review/dir?${query}`);
}

/** The entries of a directory, as `d:name` or `f:name`, in the order they came. */
function named(body: ReviewDirResponse): string[] {
  return body.entries.map((entry) => `${entry.isDir ? 'd' : 'f'}:${entry.name}`);
}

/** One entry of a directory, by name. */
function entry(body: ReviewDirResponse, name: string): ReviewDirEntry | undefined {
  return body.entries.find((e) => e.name === name);
}

describe('the directory endpoint', () => {
  test('a cloned project is browsable under its own prefix, with git on', async () => {
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

    const root = await openDir('aaa');
    assert.equal(root.status, 200);
    assert.equal(root.body.hasGit, true);
    assert.deepEqual(
      root.body.repos.map((r) => ({ path: r.path, name: r.name })),
      [{ path: 'project', name: 'project' }],
    );
    assert.deepEqual(named(root.body), ['d:project']);
    assert.equal(root.body.hasReview, false);
    assert.deepEqual(root.body.base, { rev: '' });

    // Paths are the workspace's, so the repository's own prefix is in them.
    const inside = await openDir('aaa', 'project');
    assert.deepEqual(named(inside.body), ['d:src', 'f:README.md']);
    assert.deepEqual(named((await openDir('aaa', 'project/src')).body), ['f:app.ts']);
    assert.equal(entry(inside.body, 'src')!.path, 'project/src');
  });

  test('a workspace that is itself a repository claims every path in it', async () => {
    const ws = insertSession('bbb');
    initRepo(ws);
    write(ws, 'a.txt', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');

    const { body } = await openDir('bbb');
    assert.equal(body.hasGit, true);
    assert.deepEqual(body.repos.map((r) => r.path), ['']);
    assert.deepEqual(named(body), ['f:a.txt']);
  });

  test('a workspace with no repository browses without the git features', async () => {
    const ws = insertSession('ccc');
    write(ws, 'notes/todo.txt', 'x\n');

    const { body } = await openDir('ccc');
    assert.equal(body.hasGit, false);
    assert.deepEqual(body.repos, []);
    // Everything still works but the git features, the way the desktop tool
    // degrades outside a repository.
    assert.deepEqual(named(body), ['d:notes']);
    assert.equal(entry(body, 'notes')!.changed, undefined);
    assert.deepEqual(named((await openDir('ccc', 'notes')).body), ['f:todo.txt']);
  });

  test('two clones side by side both keep their git', async () => {
    const ws = insertSession('ddd');
    for (const name of ['one', 'two']) {
      const repo = join(ws, name);
      mkdirSync(repo);
      initRepo(repo);
      write(repo, 'a.txt', `${name}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'init');
      write(repo, 'a.txt', 'changed\n');
    }
    // The most common multi-repository shape, and the one that used to get
    // the worst mode: a filesystem walk with no statuses and no diffs.
    const { body } = await openDir('ddd');
    assert.equal(body.hasGit, true);
    assert.deepEqual(body.repos.map((r) => r.path), ['one', 'two']);
    // The folders say their subtrees hold a change, without either being read.
    assert.equal(entry(body, 'one')!.changed, true);
    assert.equal(entry(body, 'two')!.changed, true);
    assert.equal(entry((await openDir('ddd', 'one')).body, 'a.txt')!.status, 'modified');
    assert.equal(entry((await openDir('ddd', 'two')).body, 'a.txt')!.status, 'modified');
  });

  test('a clone beside a stray directory keeps its git, and the stray shows too', async () => {
    const ws = insertSession('str');
    const repo = join(ws, 'project');
    mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'x\n');
    write(ws, 'notes/todo.md', 'x\n');

    const { body } = await openDir('str');
    assert.equal(body.hasGit, true);
    assert.deepEqual(named(body), ['d:notes', 'd:project']);
    assert.equal(entry(body, 'project')!.changed, true);
    // Loose files outside every repository show like any other, and they
    // have no status at all.
    assert.equal(entry(body, 'notes')!.changed, undefined);
    assert.equal(entry((await openDir('str', 'project')).body, 'a.txt')!.status, 'untracked');
    assert.equal(entry((await openDir('str', 'notes')).body, 'todo.md')!.status, undefined);
  });

  test('a clone one level deeper is found', async () => {
    const ws = insertSession('dpt');
    const repo = join(ws, 'projects', 'foo');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    write(repo, 'a.txt', 'x\n');

    const { body } = await openDir('dpt');
    assert.deepEqual(body.repos.map((r) => r.path), ['projects/foo']);
    const deep = await openDir('dpt', 'projects/foo');
    assert.equal(entry(deep.body, 'a.txt')!.status, 'untracked');
  });

  test('a repository inside a repository is listed, with no ghost row', async () => {
    const ws = insertSession('nst');
    initRepo(ws);
    write(ws, 'a.txt', 'x\n');
    const inner = join(ws, 'inner');
    mkdirSync(inner);
    initRepo(inner);
    write(inner, 'b.txt', 'y\n');

    const { body } = await openDir('nst');
    assert.deepEqual(body.repos.map((r) => r.path), ['', 'inner']);
    // The inner repository is a folder with its own root mark, and the outer
    // one reports nothing for it as a file.
    assert.deepEqual(named(body), ['d:inner', 'f:a.txt']);
    assert.equal(entry(body, 'inner')!.repo, true);
    assert.equal(entry(body, 'inner')!.status, undefined);
    assert.equal(entry((await openDir('nst', 'inner')).body, 'b.txt')!.status, 'untracked');
  });

  test('the repository roots are marked in the listing', async () => {
    const ws = insertSession('mrk');
    const repo = join(ws, 'project');
    mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'x\n');
    write(ws, 'notes/todo.md', 'x\n');

    const { body } = await openDir('mrk');
    assert.equal(entry(body, 'project')!.repo, true);
    assert.equal(entry(body, 'notes')!.repo, undefined);
  });

  test('nothing about a root is stored on the session row', async () => {
    const ws = insertSession('eee');
    const repo = join(ws, 'project');
    mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'x\n');

    await openDir('eee');
    // There is no root to remember: /workspace is the root, and which
    // repository a path belongs to is derived from the path.
    const columns = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    assert.ok(!columns.includes('review_root'));
    assert.ok(!columns.includes('review_base_commit'));
  });

  test('a repository that appears later is picked up by the next arrival', async () => {
    const ws = insertSession('ggg');
    // What a curious user does: open the review on a fresh box, before the
    // agent has fetched anything.
    const empty = await openDir('ggg');
    assert.equal(empty.body.hasGit, false);
    assert.deepEqual(empty.body.entries, []);

    const repo = join(ws, 'project');
    mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');

    // Opening a folder answers from the git the review already has, and an
    // arrival takes it again — so there is no root decided before the
    // repository existed.
    assert.equal((await openDir('ggg', '', false)).body.hasGit, false);
    const { body } = await openDir('ggg');
    assert.equal(body.hasGit, true);
    assert.deepEqual(body.repos.map((r) => r.path), ['project']);
  });

  test('opening a folder runs no git at all', async () => {
    const ws = insertSession('cch');
    initRepo(ws);
    write(ws, 'src/a.txt', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    await openDir('cch');

    // Git is a `docker exec` into the session container, so a status per
    // folder tap would be an exec per tap. The whole workspace is asked once
    // and a folder is a slice of the answer.
    const before = invocations;
    const { body } = await openDir('cch', 'src', false);
    assert.deepEqual(named(body), ['f:a.txt']);
    assert.equal(invocations, before);
  });

  test('a review written before a clone stays the workspace review', async () => {
    const ws = insertSession('hhh');
    write(ws, 'notes.txt', 'x\n');
    await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/hhh/review/annotations',
      payload: { path: 'notes.txt', line: 1, comment: 'before the clone' },
    });

    const repo = join(ws, 'project');
    mkdirSync(repo);
    initRepo(repo);
    write(repo, 'a.txt', 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');

    // REVIEW.md is at /workspace and stays there whatever the agent clones,
    // so a comment written before the clone is still in the review after it.
    const { body } = await openDir('hhh');
    assert.equal(body.hasGit, true);
    assert.equal(body.commentCount, 1);
    assert.equal(entry(body, 'notes.txt')!.comments, 1);
    assert.equal(existsSync(join(ws, 'REVIEW.md')), true);
    assert.equal(existsSync(join(repo, 'REVIEW.md')), false);
  });

  test('the workspace REVIEW.md is neither listed nor given a status', async () => {
    const ws = insertSession('out');
    initRepo(ws);
    write(ws, 'code.ts', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/out/review/annotations',
      payload: { path: 'code.ts', line: 1, comment: 'x' },
    });

    const { body } = await openDir('out');
    // It is a real untracked file of this repository, since the workspace is
    // one — but the listing leaves it out, because it is the review rather
    // than a file of it.
    assert.equal(body.hasReview, true);
    assert.deepEqual(named(body), ['f:code.ts']);
  });

  test('a file the change deleted is still listed, in its own directory', async () => {
    const ws = insertSession('iii');
    initRepo(ws);
    write(ws, 'src/keep.txt', 'x\n');
    write(ws, 'src/gone.txt', 'y\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    git(ws, 'rm', '-q', 'src/gone.txt');
    git(ws, 'commit', '-q', '-m', 'drop it');
    await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/iii/review/base',
      payload: { rev: 'HEAD~1' },
    });

    // Committed and removed, so nowhere a directory read can find it. Only the
    // status map knows the path, which is why listing and status are one
    // answer. A review that cannot show a deletion is missing one of the three
    // things a change can do.
    const { body } = await openDir('iii', 'src');
    assert.deepEqual(named(body), ['f:gone.txt', 'f:keep.txt']);
    assert.equal(entry(body, 'gone.txt')!.status, 'deleted');
  });

  test('a directory the change emptied is listed, and can be opened', async () => {
    const ws = insertSession('emp');
    initRepo(ws);
    write(ws, 'doomed/a.txt', 'x\n');
    write(ws, 'keep.txt', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    git(ws, 'rm', '-q', '-r', 'doomed');
    git(ws, 'commit', '-q', '-m', 'drop it');
    await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/emp/review/base',
      payload: { rev: 'HEAD~1' },
    });

    const { body } = await openDir('emp');
    assert.equal(entry(body, 'doomed')!.isDir, true);
    assert.equal(entry(body, 'doomed')!.changed, true);
    const inside = await openDir('emp', 'doomed');
    assert.deepEqual(named(inside.body), ['f:a.txt']);
    assert.equal(entry(inside.body, 'a.txt')!.status, 'deleted');
  });

  test('statuses come back on the files they belong to', async () => {
    const ws = insertSession('fff');
    initRepo(ws);
    write(ws, 'tracked.txt', 'x\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    write(ws, 'tracked.txt', 'changed\n');
    write(ws, 'fresh.txt', 'new\n');

    const { body } = await openDir('fff');
    assert.equal(entry(body, 'tracked.txt')!.status, 'modified');
    assert.equal(entry(body, 'fresh.txt')!.status, 'untracked');
  });

  test('a directory the review does not offer is a 404', async () => {
    const ws = insertSession('bad');
    write(ws, 'src/a.txt', 'x\n');
    for (const path of ['nosuch', '../..', 'src/a.txt', '.git']) {
      const res = await orchestrator.app.inject({
        url: `/api/sessions/bad/review/dir?path=${encodeURIComponent(path)}`,
      });
      assert.equal(res.statusCode, 404, path);
    }
  });

  test('an unknown session is a 404, a deleted one too', async () => {
    insertSession('ggg');
    db.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('ggg');
    assert.equal((await orchestrator.app.inject({ url: '/api/sessions/ggg/review/dir' })).statusCode, 404);
    assert.equal((await orchestrator.app.inject({ url: '/api/sessions/nope/review/dir' })).statusCode, 404);
  });

  test('a volume-backed session says what to do about it', async () => {
    insertVolumeSession('hhh');
    const res = await orchestrator.app.inject({ url: '/api/sessions/hhh/review/dir' });
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
    write(ws, 'logo.png', 'x\n');
    write(ws, 'REVIEW.md', '# Code Review\n');
    // The API serves what the browser was offered and nothing more.
    for (const path of ['logo.png', 'REVIEW.md']) {
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

  test('a file the change deleted answers as deleted, not as missing', async () => {
    const ws = insertSession('del');
    initRepo(ws);
    write(ws, 'gone.txt', 'y\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    rmSync(join(ws, 'gone.txt'));

    const { status, body } = await get<ReviewFileResponse>(
      '/api/sessions/del/review/file?path=gone.txt',
    );
    assert.equal(status, 200);
    assert.equal(body.deleted, true);
    assert.equal(body.status, 'deleted');
    assert.equal(body.content, '');
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

// --- saving an edited file --------------------------------------------------

describe('saving a file', () => {
  /** A session with a repository, one committed file and one binary. */
  function editable(id: string): string {
    const ws = insertSession(id);
    initRepo(ws);
    write(ws, 'code.ts', 'one\ntwo\nthree\n');
    writeFileSync(join(ws, 'binary.dat'), Buffer.from([0x41, 0x00, 0x42]));
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    return ws;
  }

  /** PUT a file's new content. */
  async function save(
    id: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: ReviewFileResponse }> {
    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/review/file`,
      payload,
    });
    return { status: res.statusCode, body: res.json() as ReviewFileResponse };
  }

  /** The hash the browser would be holding, from the file endpoint itself. */
  async function hashOf(id: string, path: string): Promise<string> {
    const { body } = await get<ReviewFileResponse>(
      `/api/sessions/${id}/review/file?path=${encodeURIComponent(path)}`,
    );
    return body.hash;
  }

  test('an edit reaches the file, and the whole file view comes back', async () => {
    const ws = editable('aaa');
    const hash = await hashOf('aaa', 'code.ts');

    const { status, body } = await save('aaa', {
      path: 'code.ts',
      content: 'one\nTWO\nthree\n',
      hash,
    });
    assert.equal(status, 200);
    assert.equal(readFileSync(join(ws, 'code.ts'), 'utf8'), 'one\nTWO\nthree\n');
    // One round trip repaints the pane: the content, and the diff the edit
    // just created.
    assert.equal(body.content, 'one\nTWO\nthree\n');
    assert.equal(body.status, 'modified');
    assert.equal(body.diff.lines['2'], 'modified');
    // And the hash to save against next time, which the edit moved.
    assert.notEqual(body.hash, hash);
    assert.equal(body.hash.length, 32);
  });

  test('a hash the file has moved past is refused, and nothing is written', async () => {
    const ws = editable('bbb');
    const hash = await hashOf('bbb', 'code.ts');
    // The agent, working in the box while the reviewer types.
    write(ws, 'code.ts', 'one\ntwo\nthree\nfour\n');

    const { status } = await save('bbb', { path: 'code.ts', content: 'mine\n', hash });
    assert.equal(status, 412);
    assert.equal(readFileSync(join(ws, 'code.ts'), 'utf8'), 'one\ntwo\nthree\nfour\n');
  });

  test('saving again against what is now there goes through', async () => {
    const ws = editable('ccc');
    const stale = await hashOf('ccc', 'code.ts');
    write(ws, 'code.ts', 'agent\n');
    const refused = await save('ccc', { path: 'code.ts', content: 'mine\n', hash: stale });
    assert.equal(refused.status, 412);

    // Which is the reviewer overruling the refusal: they still hold their
    // version, and the view offers to save it anyway.
    const fresh = await hashOf('ccc', 'code.ts');
    const { status } = await save('ccc', { path: 'code.ts', content: 'mine\n', hash: fresh });
    assert.equal(status, 200);
    assert.equal(readFileSync(join(ws, 'code.ts'), 'utf8'), 'mine\n');
  });

  test('a comment on the edited file follows the code it was written against', async () => {
    editable('ddd');
    await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/ddd/review/annotations',
      payload: { path: 'code.ts', line: 3, comment: 'this one' },
    });

    const hash = await hashOf('ddd', 'code.ts');
    const { body } = await save('ddd', {
      path: 'code.ts',
      content: 'zero\none\ntwo\nthree\n',
      hash,
    });
    // Drift is what makes editing safe to do under the comments: the comment
    // moved with its line rather than being left pointing at the wrong one.
    assert.deepEqual(body.annotations, [{ line: 4, comment: 'this one', outdated: false }]);
  });

  test('a file the review cannot show cannot be saved either', async () => {
    const ws = editable('eee');
    rmSync(join(ws, 'code.ts'));
    write(ws, 'REVIEW.md', '# Code Review\n');

    // Binary, deleted, and never offered in the first place.
    assert.equal((await save('eee', { path: 'binary.dat', content: 'x', hash: '' })).status, 409);
    assert.equal((await save('eee', { path: 'code.ts', content: 'x', hash: '' })).status, 409);
    assert.equal((await save('eee', { path: 'REVIEW.md', content: 'x', hash: '' })).status, 404);
  });

  test('a path outside the root is a 404, as it is for reading', async () => {
    const ws = editable('fff');
    writeFileSync(join(dir, 'boxes.db.copy'), 'the deployment token');
    symlinkSync(join(dir, 'boxes.db.copy'), join(ws, 'stolen.txt'));

    for (const path of ['../boxes.db', 'stolen.txt', '/etc/passwd', 'nosuch.txt']) {
      const { status } = await save('fff', { path, content: 'owned\n', hash: '' });
      assert.equal(status, 404, path);
    }
    assert.equal(readFileSync(join(dir, 'boxes.db.copy'), 'utf8'), 'the deployment token');
  });

  test('an executable file is still executable after a save', async () => {
    const ws = editable('ggg');
    write(ws, 'run.sh', '#!/bin/sh\necho one\n');
    chmodSync(join(ws, 'run.sh'), 0o755);

    const hash = await hashOf('ggg', 'run.sh');
    const { status } = await save('ggg', {
      path: 'run.sh',
      content: '#!/bin/sh\necho two\n',
      hash,
    });
    assert.equal(status, 200);
    assert.equal(statSync(join(ws, 'run.sh')).mode & 0o777, 0o755);
  });

  test('a request with nothing to save is a 400', async () => {
    editable('hhh');
    assert.equal((await save('hhh', { content: 'x', hash: '' })).status, 400);
    assert.equal((await save('hhh', { path: 'code.ts', hash: '' })).status, 400);
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

    const listing = await openDir('bbb');
    assert.equal(entry(listing.body, 'code.ts')!.comments, 2);
    assert.equal(listing.body.commentCount, 2);
    assert.equal(listing.body.hasReview, true);
    assert.match(listing.body.started, /^\d{4}-\d{2}-\d{2}$/);
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
    const listing = await openDir('ddd');
    assert.equal(listing.body.commentCount, 0);
    assert.equal(entry(listing.body, 'code.ts')!.comments, undefined);
  });

  test('deleting a comment that is not there leaves no review behind', async () => {
    const ws = commentable('lll');
    const res = await orchestrator.app.inject({
      method: 'DELETE',
      url: '/api/sessions/lll/review/annotations?path=nosuch.txt&line=1',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as ReviewAnnotationsResponse).annotations, []);
    // Nothing was changed, so nothing is written: a review the reviewer never
    // started must not appear because of a delete that applied to nothing.
    assert.equal(existsSync(join(ws, 'REVIEW.md')), false);
    assert.equal((await openDir('lll')).body.hasReview, false);
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

  test('a comment on a deleted file is marked outdated when the review is arrived at', async () => {
    const ws = commentable('hhh');
    await put('hhh', { path: 'code.ts', line: 3, comment: 'about three' });
    rmSync(join(ws, 'code.ts'));

    // Opening a folder does not run drift — it never touches a file it is not
    // listing — so an arrival is what checks every annotated file.
    await openDir('hhh', '', false);
    assert.ok(!readFileSync(join(ws, 'REVIEW.md'), 'utf8').includes('(outdated)'));

    await openDir('hhh');
    assert.match(readFileSync(join(ws, 'REVIEW.md'), 'utf8'), /#### Line 3 \(outdated\)/);
  });

  test('a comment write runs drift over the whole review', async () => {
    const ws = commentable('drf');
    await put('drf', { path: 'code.ts', line: 3, comment: 'about three' });
    write(ws, 'other.ts', 'a\nb\n');
    await put('drf', { path: 'other.ts', line: 1, comment: 'about a' });
    write(ws, 'code.ts', 'completely\ndifferent\ncontent\n');

    // The second file is the one being written; the first is the one that
    // moved under it, and nothing else looks at it any more.
    const { body } = await put('drf', { path: 'other.ts', line: 2, comment: 'about b' });
    assert.deepEqual(
      body.annotations.map((a) => a.outdated),
      [false, false],
    );
    assert.match(readFileSync(join(ws, 'REVIEW.md'), 'utf8'), /#### Line 3 \(outdated\)/);
  });

  test('a comment on a file that became binary is kept as it stands', async () => {
    const ws = commentable('mmm');
    await put('mmm', { path: 'code.ts', line: 3, comment: 'about three' });
    // There is nothing readable to compare the comment against, which is not
    // the same as the code it was about being gone.
    writeFileSync(join(ws, 'code.ts'), Buffer.from([0x41, 0x00, 0x42]));

    await openDir('mmm');
    assert.ok(!readFileSync(join(ws, 'REVIEW.md'), 'utf8').includes('(outdated)'));

    const { body } = await get<ReviewFileResponse>('/api/sessions/mmm/review/file?path=code.ts');
    assert.equal(body.binary, true);
    // The listing counts the comment, so the file view shows it: it is where
    // the reviewer reads and deletes it.
    assert.deepEqual(body.annotations, [{ line: 3, comment: 'about three', outdated: false }]);
  });

  test('a comment on a file the change deleted comes back with it', async () => {
    const ws = commentable('nnn');
    await put('nnn', { path: 'code.ts', line: 3, comment: 'about three' });
    rmSync(join(ws, 'code.ts'));

    const listing = await openDir('nnn');
    assert.equal(entry(listing.body, 'code.ts')!.comments, 1);

    const { body } = await get<ReviewFileResponse>('/api/sessions/nnn/review/file?path=code.ts');
    assert.equal(body.deleted, true);
    assert.deepEqual(body.annotations, [{ line: 3, comment: 'about three', outdated: true }]);
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

  test('a comment on a file the change deleted is refused', async () => {
    const ws = insertSession('rip');
    initRepo(ws);
    write(ws, 'gone.txt', 'y\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    rmSync(join(ws, 'gone.txt'));

    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/rip/review/annotations',
      payload: { path: 'gone.txt', line: 1, comment: 'x' },
    });
    // The file is in the tree, so this is not a 404 — there is simply no line
    // to attach a comment to.
    assert.equal(res.statusCode, 409);
  });

  test('a comment on a path outside the root is a 404', async () => {
    const ws = commentable('jjj');
    write(ws, 'logo.png', 'x\n');
    for (const path of ['../escape.txt', 'nosuch.ts', 'logo.png']) {
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

    const listing = await openDir('aaa');
    assert.equal(listing.body.commentCount, 0);
    assert.equal(listing.body.hasReview, false);
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
  /** A repository with a main commit and a feature branch on top of it. */
  function branchRepo(ws: string, at = ''): string {
    const repo = at === '' ? ws : join(ws, at);
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    // Repository-specific content, so two built the same way in the same
    // second do not end up with the same commit ids.
    write(repo, 'base.txt', `${at}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'mine.txt', 'mine\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feature work');
    return repo;
  }

  /** A session whose workspace is itself such a repository. */
  function branched(id: string): string {
    return branchRepo(insertSession(id));
  }

  /** PUT the base. */
  async function setBase(
    id: string,
    rev: string | null,
  ): Promise<{ status: number; body: ReviewBaseResponse }> {
    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/review/base`,
      payload: { rev },
    });
    return { status: res.statusCode, body: res.json() as ReviewBaseResponse };
  }

  test('a branch resolves through the merge base and is remembered as an expression', async () => {
    const ws = branched('aaa');
    const { status, body } = await setBase('aaa', 'main');
    assert.equal(status, 200);
    assert.equal(body.rev, 'main');
    assert.equal(body.repos[0]!.baseCommit, git(ws, 'merge-base', 'main', 'HEAD').trim());

    // Only the expression is stored: what it resolves to is a different commit
    // in every repository, so it is derived rather than kept.
    const row = db
      .prepare('SELECT review_base_rev FROM sessions WHERE id = ?')
      .get('aaa') as { review_base_rev: string };
    assert.equal(row.review_base_rev, 'main');
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
    const { body } = await openDir('bbb');
    assert.equal(body.base.rev, 'main');
    assert.equal(entry(body, 'mine.txt')!.status, 'added');
    // A file that only exists on the base branch is on no disk here and git
    // reports nothing about it, so the listing does not offer it.
    assert.equal(entry(body, 'theirs.txt'), undefined);
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

  test('null clears the base back to the working tree', async () => {
    branched('ddd');
    await setBase('ddd', 'main');
    const { body } = await setBase('ddd', null);
    assert.equal(body.rev, '');
    assert.deepEqual(body.repos.map((r) => r.baseCommit), ['']);
    assert.deepEqual((await openDir('ddd')).body.base, { rev: '' });
  });

  test('a revision that resolves nowhere is refused by name', async () => {
    branched('eee');
    const res = await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/sessions/eee/review/base',
      payload: { rev: 'no-such-branch' },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /unknown revision/);
  });

  test('one expression means the same branch in each repository', async () => {
    const ws = insertSession('two');
    branchRepo(ws, 'repo-a');
    branchRepo(ws, 'repo-b');

    const { body } = await setBase('two', 'main');
    assert.equal(body.repos.length, 2);
    assert.ok(body.repos.every((r) => r.baseCommit !== ''));
    // Resolved separately, so they are different commits.
    assert.notEqual(body.repos[0]!.baseCommit, body.repos[1]!.baseCommit);

    assert.equal(entry((await openDir('two', 'repo-a')).body, 'mine.txt')!.status, 'added');
    assert.equal(entry((await openDir('two', 'repo-b')).body, 'mine.txt')!.status, 'added');
  });

  test('a repository the revision names nothing in falls back to its working tree', async () => {
    const ws = insertSession('mix');
    git(branchRepo(ws, 'repo-a'), 'branch', 'release');
    const other = join(ws, 'repo-b');
    mkdirSync(other, { recursive: true });
    initRepo(other);
    write(other, 'b.txt', 'x\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'init');
    write(other, 'b.txt', 'changed\n');

    // Resolved in one, unknown in the other. A 400 would refuse an ordinary
    // shape, so the one it does not name is compared against its own tree.
    const { status, body } = await setBase('mix', 'release');
    assert.equal(status, 200);
    assert.deepEqual(
      body.repos.map((r) => [r.path, r.baseCommit !== '']),
      [
        ['repo-a', true],
        ['repo-b', false],
      ],
    );

    const listing = await openDir('mix', 'repo-b');
    assert.equal(entry(listing.body, 'b.txt')!.status, 'modified');
    // And every directory reports the same resolution, so the header can say
    // where the revision landed.
    assert.deepEqual(listing.body.repos.map((r) => r.baseCommit !== ''), [true, false]);
  });

  test('a workspace with no repository cannot have a base', async () => {
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

// --- freshness --------------------------------------------------------------

describe('freshness is the fetch', () => {
  test('there is no fingerprint endpoint to poll', async () => {
    const ws = insertSession('aaa');
    write(ws, 'a.txt', 'x\n');
    // The poll is gone, and with it the idle cost of an open review. Every
    // fetch below reads the filesystem on the spot, which is what makes
    // freshness-on-arrival enough.
    const res = await orchestrator.app.inject({ url: '/api/sessions/aaa/review/status' });
    assert.equal(res.statusCode, 404);
  });

  test('an arrival sees what changed since the last one', async () => {
    const ws = insertSession('ccc');
    initRepo(ws);
    write(ws, 'code.ts', 'one\ntwo\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');

    const before = await openDir('ccc');
    assert.equal(entry(before.body, 'code.ts')!.status, undefined);

    write(ws, 'code.ts', 'one\nTWO\n');
    const after = await openDir('ccc');
    assert.equal(entry(after.body, 'code.ts')!.status, 'modified');
  });

  test('a file fetch sees an edit the agent made to it', async () => {
    const ws = insertSession('ddd');
    initRepo(ws);
    write(ws, 'code.ts', 'one\ntwo\n');
    git(ws, 'add', '.');
    git(ws, 'commit', '-q', '-m', 'init');
    await openDir('ddd');

    write(ws, 'code.ts', 'one\nTWO\n');
    const { body } = await get<ReviewFileResponse>('/api/sessions/ddd/review/file?path=code.ts');
    assert.equal(body.content, 'one\nTWO\n');
  });

  test('reading a review keeps the box it is read from alive', async () => {
    const ws = insertSession('bbb');
    write(ws, 'a.txt', 'x\n');
    db.prepare('UPDATE sessions SET last_active_at = 0 WHERE id = ?').run('bbb');

    await openDir('bbb');
    await get<ReviewFileResponse>('/api/sessions/bbb/review/file?path=a.txt');

    // A review asks git about the workspace, and git runs in the session's own
    // container, so reading one is use of the box. The reaper stopping it under
    // the reader would take the next request's answer with it.
    const row = db.prepare('SELECT last_active_at FROM sessions WHERE id = ?').get('bbb') as {
      last_active_at: number;
    };
    assert.ok(row.last_active_at > 0, 'reading a review should mark the session active');
  });
});
