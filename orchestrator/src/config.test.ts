import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CREDENTIAL_SET, loadConfig } from './config.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Configuration parsing. Every setting has a working default, which is what
 * lets the stack run with no .env at all — and what keeps compose.yaml from
 * having to restate any of them.
 */

/** Runs a case against a throwaway data dir, since a token is written there. */
function withDataDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-config-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an empty environment yields the documented defaults', () => {
  withDataDir((dir) => {
    const cfg = loadConfig({ DATA_DIR: dir });
    assert.equal(cfg.PORT, 3000);
    assert.equal(cfg.SESSION_IMAGE, 'boxes-session:latest');
    assert.equal(cfg.SESSION_SUBNET_POOL, '10.200.0.0/16');
    assert.equal(cfg.SESSION_MEM_LIMIT, '4g');
    assert.equal(cfg.SESSION_CPUS, 2);
    assert.equal(cfg.SESSION_PIDS_LIMIT, 512);
    assert.equal(cfg.IDLE_STOP_MINUTES, 30);
    assert.equal(cfg.SESSION_IMAGE_PRUNE, true);
    assert.equal(cfg.BACKGROUND_POLL_SECONDS, 20);
    assert.equal(cfg.PERMISSION_FALLBACK, 'hold');
    assert.equal(cfg.PERMISSION_HOLD_MINUTES, 120);
    assert.equal(cfg.EGRESS_PROXY_CONTAINER, 'boxes-egress-proxy');
    assert.equal(cfg.EGRESS_PROXY_ALIAS, 'proxy');
    assert.equal(cfg.EGRESS_PROXY_PORT, 3128);
  });
});

test('an empty value means unset, not an invalid value', () => {
  withDataDir((dir) => {
    // What `FOO=` in an .env file, or a compose pass-through for a variable
    // the host does not set, actually delivers. None of these may fail the
    // boot for a setting nobody set.
    const cfg = loadConfig({
      DATA_DIR: dir,
      SESSION_IMAGE: '',
      SESSION_SUBNET_POOL: '',
      SESSION_MEM_LIMIT: '',
      SESSION_CPUS: '',
      SESSION_PIDS_LIMIT: '',
      IDLE_STOP_MINUTES: '',
      SESSION_IMAGE_PRUNE: '',
      PERMISSION_FALLBACK: '',
      PERMISSION_HOLD_MINUTES: '',
    });
    assert.equal(cfg.SESSION_MEM_LIMIT, '4g');
    assert.equal(cfg.SESSION_CPUS, 2);
    assert.equal(cfg.PERMISSION_FALLBACK, 'hold');
    assert.equal(cfg.IDLE_STOP_MINUTES, 30);
    assert.equal(cfg.SESSION_IMAGE_PRUNE, true);
  });
});

test('an off switch is off however it is spelled, and never on by accident', () => {
  withDataDir((dir) => {
    // The mistake a boolean environment variable exists to make: a coercion
    // that reads any non-empty string as true turns this into on.
    for (const off of ['false', '0', 'no', 'off']) {
      assert.equal(loadConfig({ DATA_DIR: dir, SESSION_IMAGE_PRUNE: off }).SESSION_IMAGE_PRUNE, false);
    }
    for (const on of ['true', '1', 'yes', 'on']) {
      assert.equal(loadConfig({ DATA_DIR: dir, SESSION_IMAGE_PRUNE: on }).SESSION_IMAGE_PRUNE, true);
    }
    // And a typo is a failed boot rather than whichever of the two is worse.
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, SESSION_IMAGE_PRUNE: 'nope' }),
      /Invalid configuration/,
    );
  });
});

test('a provided value wins over the default', () => {
  withDataDir((dir) => {
    const cfg = loadConfig({
      DATA_DIR: dir,
      SESSION_MEM_LIMIT: '8g',
      SESSION_CPUS: '4',
      PERMISSION_FALLBACK: 'deny',
      PUSH_SUBJECT: 'mailto:ops@example.com',
    });
    assert.equal(cfg.SESSION_MEM_LIMIT, '8g');
    assert.equal(cfg.SESSION_CPUS, 4);
    assert.equal(cfg.PERMISSION_FALLBACK, 'deny');
    assert.equal(cfg.PUSH_SUBJECT, 'mailto:ops@example.com');
  });
});

test('a genuinely invalid value still fails the boot', () => {
  withDataDir((dir) => {
    assert.throws(() => loadConfig({ DATA_DIR: dir, SESSION_MEM_LIMIT: 'lots' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, PERMISSION_FALLBACK: 'maybe' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, SESSION_CPUS: '-1' }), /Invalid configuration/);
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, PUSH_SUBJECT: 'ops@example.com' }),
      /Invalid configuration/,
    );
  });
});

test('the allowlist is off by default and parses either separator', () => {
  withDataDir((dir) => {
    assert.deepEqual(loadConfig({ DATA_DIR: dir }).egressAllowedHosts, []);
    assert.deepEqual(
      loadConfig({
        DATA_DIR: dir,
        EGRESS_ALLOWED_HOSTS: 'GitHub.com, *.githubusercontent.com  registry.npmjs.org,',
      }).egressAllowedHosts,
      ['github.com', '*.githubusercontent.com', 'registry.npmjs.org'],
    );
  });
});

test('an allowlist entry that would allow everything is refused at boot', () => {
  withDataDir((dir) => {
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, EGRESS_ALLOWED_HOSTS: 'github.com,*' }),
      /bare \*/,
    );
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, EGRESS_ALLOWED_HOSTS: 'api.*.com' }),
      /leading \*\./,
    );
  });
});

test('no secret comes from the environment any more', () => {
  withDataDir((dir) => {
    // Credentials live in the database and are managed from the settings
    // page. Anything named PROFILE_DEFAULT_* is a setting from a release
    // before that, and it must not come back to life by being parsed.
    const cfg = loadConfig({
      DATA_DIR: dir,
      PROFILE_DEFAULT_GH_TOKEN: 'ghp_x',
      PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
      PROFILE_DEFAULT_GIT_NAME: 'somebody',
    });
    assert.ok(!JSON.stringify(cfg).includes('ghp_x'));
    assert.ok(!JSON.stringify(cfg).includes('sk-ant-oat01-x'));
    assert.ok(!JSON.stringify(cfg).includes('somebody'));
  });
});

test('the credential set describes where each credential travels', () => {
  // Which hosts a credential is sent to and which header it arrives in are
  // facts about the services, so they are here rather than configurable. The
  // secrets that go with them come from the store.
  assert.deepEqual(
    CREDENTIAL_SET.map((c) => c.id),
    ['claude', 'github'],
  );
  const github = CREDENTIAL_SET.find((c) => c.id === 'github');
  assert.ok(github?.hosts.includes('api.github.com'));
  assert.deepEqual(github?.headers, ['authorization']);
  assert.ok(CREDENTIAL_SET.every((c) => c.placeholderPrefix !== ''));
});

test('the session uid defaults off 1000 and is settable', () => {
  withDataDir((dir) => {
    // 1000 is the base image's own uid and, on a real host, usually a person's.
    // The default moves off it so a deployment can give the agent a uid of its
    // own the way it would any other service.
    const base = loadConfig({ DATA_DIR: dir });
    assert.equal(base.SESSION_UID, 1020);
    assert.equal(base.SESSION_GID, 1020);

    const set = loadConfig({ DATA_DIR: dir, SESSION_UID: '1000', SESSION_GID: '1000' });
    assert.equal(set.SESSION_UID, 1000);
    assert.equal(set.SESSION_GID, 1000);

    // Root would put a session's every process back at uid 0, which the whole
    // container template exists to avoid, so it is not a value to accept.
    assert.throws(() => loadConfig({ DATA_DIR: dir, SESSION_UID: '0' }));
    assert.throws(() => loadConfig({ DATA_DIR: dir, SESSION_UID: 'agent' }));
  });
});
