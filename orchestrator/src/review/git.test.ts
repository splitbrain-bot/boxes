import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { DIFF_SAFETY_FLAGS, git, hardenedEnv, hardeningFlags, headCommit, topLevel } from './git.ts';

/**
 * The hardened git invocation.
 *
 * The flag set is asserted rather than described, because review runs git over
 * a tree the agent controls and repo-local config can execute commands on
 * exactly the operations it runs. Removing one of these has to fail a test.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-git-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A repository with one commit, built with the ambient git. */
function repo(): string {
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'tracked.txt'), 'x\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
  return dir;
}

describe('the hardening flag set', () => {
  const flags = hardeningFlags('/data/workspaces/abc/repo');

  /** Whether `-c name=value` is in the prefix, whatever the value. */
  function sets(name: string): string | undefined {
    for (let i = 0; i < flags.length - 1; i++) {
      if (flags[i] === '-c' && flags[i + 1]!.startsWith(`${name}=`)) {
        return flags[i + 1]!.slice(name.length + 1);
      }
    }
    return undefined;
  }

  test('turns off the config value that makes status run a command', () => {
    // core.fsmonitor is a hook path git runs on every status. Overridden here
    // rather than trusted to be absent from an agent-written .git/config.
    assert.equal(sets('core.fsmonitor'), 'false');
  });

  test('points hooksPath away from the repository', () => {
    const hooks = sets('core.hooksPath');
    assert.ok(hooks);
    assert.ok(!hooks.includes('/data/workspaces/abc'));
  });

  test('marks the root safe, and only the root', () => {
    // Without this git refuses a repository owned by uid 1000. Scoped to the
    // one directory rather than '*'.
    assert.equal(sets('safe.directory'), '/data/workspaces/abc/repo');
  });

  test('refuses the protocols that would run a program to fetch', () => {
    assert.equal(sets('protocol.ext.allow'), 'never');
    assert.equal(sets('protocol.file.allow'), 'never');
  });

  test('keeps non-ASCII paths unquoted, so they match the tree', () => {
    assert.equal(sets('core.quotepath'), 'false');
  });

  test('every entry is a -c pair, so nothing can smuggle a subcommand', () => {
    assert.equal(flags.length % 2, 0);
    for (let i = 0; i < flags.length; i += 2) assert.equal(flags[i], '-c');
  });
});

describe('the hardened environment', () => {
  const env = hardenedEnv();

  test('reads no system and no user configuration', () => {
    assert.equal(env['GIT_CONFIG_NOSYSTEM'], '1');
    // HOME is an empty directory this process made, so ~/.gitconfig does not
    // exist to be read.
    assert.ok(env['HOME']);
    assert.notEqual(env['HOME'], process.env['HOME']);
    assert.equal(env['XDG_CONFIG_HOME'], env['HOME']);
  });

  test('never prompts and never takes an optional lock', () => {
    assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(env['GIT_OPTIONAL_LOCKS'], '0');
  });

  test('drops every variable that would point git at a program', () => {
    for (const name of [
      'GIT_EXTERNAL_DIFF',
      'GIT_SSH',
      'GIT_SSH_COMMAND',
      'GIT_ASKPASS',
      'GIT_CONFIG',
      'GIT_CONFIG_GLOBAL',
      'GIT_DIR',
      'GIT_WORK_TREE',
    ]) {
      assert.equal(env[name], undefined, name);
    }
  });

  test('drops the proxy variables, since nothing here is remote', () => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      assert.equal(env[name], undefined, name);
    }
  });
});

test('diff runs with the flags that stop a repository running a program', () => {
  // textconv and external diff drivers are configured per repository and run
  // on diff. Both are refused, and colour would only corrupt the parse.
  assert.deepEqual([...DIFF_SAFETY_FLAGS], ['--no-ext-diff', '--no-textconv', '--no-color']);
});

describe('running git', () => {
  test('a subcommand runs in the root and reports its output', async () => {
    repo();
    const result = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.equal(result.ok, true);
    assert.ok(result.stdout.trim().length > 0);
  });

  test('a non-zero exit is a result, not a throw', async () => {
    repo();
    const result = await git(dir, ['rev-parse', '--verify', '--quiet', 'nosuchrev^{commit}']);
    assert.equal(result.ok, false);
    assert.equal(typeof result.code, 'number');
  });

  test('outside a repository there is no top level and no HEAD', async () => {
    assert.equal(await topLevel(dir), null);
    assert.equal(await headCommit(dir), '');
  });

  test('inside a repository both are reported', async () => {
    repo();
    const top = await topLevel(dir);
    assert.ok(top);
    // macOS puts temp directories behind /private, so compare the real paths.
    assert.equal(top, execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim());
    assert.match(await headCommit(dir), /^[0-9a-f]{40}$/);
  });

  test('a repository-local fsmonitor hook is not run', async () => {
    repo();
    // The shape of the attack: a config value in a tree the agent wrote, on an
    // operation review runs. The hook writes a file if it is ever executed.
    const marker = join(dir, 'fsmonitor-ran');
    const hook = join(dir, 'evil.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: dir, stdio: 'pipe' });

    const result = await git(dir, ['status', '--porcelain', '-uall']);
    assert.equal(result.ok, true);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(marker), false, 'core.fsmonitor was executed');
  });

  test('a repository-local textconv is not run on diff', async () => {
    repo();
    const marker = join(dir, 'textconv-ran');
    const filter = join(dir, 'conv.sh');
    writeFileSync(filter, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat "$1"\n`, {
      mode: 0o755,
    });
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.txt diff=conv\n');
    execFileSync('git', ['config', 'diff.conv.textconv', filter], { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n');

    await git(dir, ['diff', 'HEAD', ...DIFF_SAFETY_FLAGS, '--', 'tracked.txt']);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(marker), false, 'textconv was executed');
  });
});
