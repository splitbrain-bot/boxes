import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'vitest';
import {
  DIFF_PARSE_FLAGS,
  git,
  gitArgv,
  gitEnv,
  gitOut,
  headCommit,
  isTopLevel,
  setGitRunnerForTests,
  type GitResult,
  type GitRunner,
  type GitTarget,
} from './git.ts';

/**
 * How review invokes git.
 *
 * Git runs in the session's container, so what is pinned down here is the
 * command line and the environment the builders produce, that every
 * invocation is addressed to a container and a directory inside it, and that
 * no file of the orchestrator can start a process at all.
 */

/** A target naming a container and a path inside it, as the service builds one. */
const target: GitTarget = { containerId: 'box-1', dir: '/workspace/project' };

/** A runner that answers nothing and records how it was called. */
function recorder(result: Partial<GitResult> = {}): {
  calls: Array<{ target: GitTarget; argv: string[]; env: Record<string, string> }>;
} {
  const calls: Array<{ target: GitTarget; argv: string[]; env: Record<string, string> }> = [];
  setGitRunnerForTests(async (called, argv, env) => {
    calls.push({ target: called, argv, env });
    return { ok: true, stdout: '', stderr: '', code: 0, ...result };
  });
  return { calls };
}

/**
 * A runner that starts git on this machine, in the directory the target names.
 *
 * The repositories these tests build are their own, so running their git here
 * is what keeps the builders honest about real git. Nothing in the
 * orchestrator does this: the runner it ships with execs in a container.
 */
const localGit: GitRunner = async (called, argv, env) => {
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), {
      cwd: called.dir,
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

afterEach(() => setGitRunnerForTests(null));

describe('the command line', () => {
  test('every invocation is git, with its flags as -c pairs', () => {
    const argv = gitArgv(['status', '--porcelain']);
    assert.equal(argv[0], 'git');
    const flags = argv.slice(1, argv.indexOf('status'));
    assert.equal(flags.length % 2, 0);
    for (let i = 0; i < flags.length; i += 2) assert.equal(flags[i], '-c');
  });

  test('non-ASCII paths stay unquoted, so they match the tree', () => {
    assert.ok(gitArgv(['status']).includes('core.quotepath=false'));
  });

  test('the subcommand and its arguments are passed through as they were given', () => {
    const argv = gitArgv(['rev-parse', '--verify', '--quiet', 'main^{commit}']);
    assert.deepEqual(argv.slice(argv.indexOf('rev-parse')), [
      'rev-parse',
      '--verify',
      '--quiet',
      'main^{commit}',
    ]);
  });

  test('a diff carries the flags the parser needs, ahead of what was asked for', () => {
    // An external driver or a textconv filter would produce something the
    // hunk parser cannot read, and colour would corrupt it.
    assert.deepEqual([...DIFF_PARSE_FLAGS], ['--no-ext-diff', '--no-textconv', '--no-color']);
    const argv = gitArgv(['diff', 'HEAD', '--', 'a.txt']);
    assert.deepEqual(argv.slice(argv.indexOf('diff')), [
      'diff',
      ...DIFF_PARSE_FLAGS,
      'HEAD',
      '--',
      'a.txt',
    ]);
  });

  test('a subcommand that is not a diff gets none of them', () => {
    assert.ok(!gitArgv(['status', '--porcelain']).includes('--no-textconv'));
  });
});

describe('the environment', () => {
  const env = gitEnv();

  test('reads, never writes, and never waits for a lock or a prompt', () => {
    assert.equal(env['GIT_OPTIONAL_LOCKS'], '0');
    assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
  });

  test('a pathspec is a path, not a glob', () => {
    // A filename holding `*`, `?` or `[` would otherwise make `-- path` match
    // files nobody asked about.
    assert.equal(env['GIT_LITERAL_PATHSPECS'], '1');
  });

  test('git writes one language, whatever the box is set to', () => {
    assert.equal(env['LC_ALL'], 'C');
  });

  test('nothing of this process travels into the box', () => {
    // The container has an environment of its own, and this is added to it.
    assert.deepEqual(Object.keys(env).sort(), [
      'GIT_LITERAL_PATHSPECS',
      'GIT_OPTIONAL_LOCKS',
      'GIT_TERMINAL_PROMPT',
      'LC_ALL',
    ]);
  });
});

describe('where an invocation is addressed', () => {
  test('the container and the directory it was given, and the built argv', async () => {
    const { calls } = recorder();
    await git(target, ['status', '--porcelain']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.target, target);
    assert.equal(calls[0]!.argv[0], 'git');
    assert.deepEqual(calls[0]!.env, gitEnv());
  });

  test('every helper goes through the same runner, with the same target', async () => {
    const { calls } = recorder({ stdout: 'abc\n' });
    await gitOut(target, ['ls-files']);
    await isTopLevel(target);
    await headCommit(target);
    assert.deepEqual(
      calls.map((call) => call.target),
      [target, target, target],
    );
    assert.deepEqual(
      calls.map((call) => call.argv.slice(call.argv.indexOf('-c') + 2)),
      [['ls-files'], ['rev-parse', '--show-prefix'], ['rev-parse', 'HEAD']],
    );
  });

  test('a runner that cannot reach the box answers like a git that failed', async () => {
    setGitRunnerForTests(async () => {
      throw new Error('no such container');
    });
    const result = await git(target, ['status']);
    assert.deepEqual(result, { ok: false, stdout: '', stderr: '', code: null });
  });
});

test('no file of the orchestrator can start a process of its own', () => {
  // The whole of the protection: a repository's own configuration runs
  // commands on `status` and on `diff`, and this process holds the Docker
  // socket. Git runs in the box instead, so nothing here spawns anything.
  const src = fileURLToPath(new URL('..', import.meta.url));
  const offenders = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => readFileSync(join(src, file), 'utf8').includes('child_process'));
  assert.deepEqual(offenders, []);
});

describe('over a repository git really answers about', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-git-'));
    setGitRunnerForTests(localGit);
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    };
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    writeFileSync(join(dir, 'tracked.txt'), 'x\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The repository this test built, addressed the way the service addresses one. */
  function here(sub = ''): GitTarget {
    return { containerId: 'box-1', dir: sub === '' ? dir : join(dir, sub) };
  }

  test('a subcommand runs in the directory and reports its output', async () => {
    const result = await git(here(), ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.trim().length > 0);
  });

  test('a non-zero exit is a result, not a throw', async () => {
    const result = await git(here(), ['rev-parse', '--verify', '--quiet', 'nosuchrev^{commit}']);
    assert.equal(result.ok, false);
    assert.equal(typeof result.code, 'number');
  });

  test('the top of a work tree is the top, and a directory inside it is not', async () => {
    mkdirSync(join(dir, 'sub'));
    assert.equal(await isTopLevel(here()), true);
    assert.equal(await isTopLevel(here('sub')), false);
    assert.match(await headCommit(here()), /^[0-9a-f]{40}$/);
  });

  test('outside a repository there is no top level and no HEAD', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'boxes-nogit-'));
    try {
      assert.equal(await isTopLevel({ containerId: 'box-1', dir: bare }), false);
      assert.equal(await headCommit({ containerId: 'box-1', dir: bare }), '');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
