import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from './config.ts';
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
    assert.equal(cfg.PERMISSION_FALLBACK, 'hold');
    assert.equal(cfg.PERMISSION_HOLD_MINUTES, 120);
    assert.equal(cfg.EGRESS_PROXY_CONTAINER, 'boxes-egress-proxy');
    assert.equal(cfg.EGRESS_PROXY_ALIAS, 'proxy');
    assert.equal(cfg.EGRESS_PROXY_PORT, 3128);
    assert.equal(cfg.profiles['DEFAULT']?.gitName, 'boxes-bot');
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
      PERMISSION_FALLBACK: '',
      PERMISSION_HOLD_MINUTES: '',
      NTFY_URL: '',
      PROFILE_DEFAULT_GIT_NAME: '',
    });
    assert.equal(cfg.SESSION_MEM_LIMIT, '4g');
    assert.equal(cfg.SESSION_CPUS, 2);
    assert.equal(cfg.PERMISSION_FALLBACK, 'hold');
    assert.equal(cfg.IDLE_STOP_MINUTES, 30);
    assert.equal(cfg.NTFY_URL, '');
    assert.equal(cfg.profiles['DEFAULT']?.gitName, 'boxes-bot');
  });
});

test('a provided value wins over the default', () => {
  withDataDir((dir) => {
    const cfg = loadConfig({
      DATA_DIR: dir,
      SESSION_MEM_LIMIT: '8g',
      SESSION_CPUS: '4',
      PERMISSION_FALLBACK: 'deny',
      NTFY_URL: 'https://ntfy.sh/boxes',
    });
    assert.equal(cfg.SESSION_MEM_LIMIT, '8g');
    assert.equal(cfg.SESSION_CPUS, 4);
    assert.equal(cfg.PERMISSION_FALLBACK, 'deny');
    assert.equal(cfg.NTFY_URL, 'https://ntfy.sh/boxes');
  });
});

test('a genuinely invalid value still fails the boot', () => {
  withDataDir((dir) => {
    assert.throws(() => loadConfig({ DATA_DIR: dir, SESSION_MEM_LIMIT: 'lots' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, PERMISSION_FALLBACK: 'maybe' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, SESSION_CPUS: '-1' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, NTFY_URL: 'not-a-url' }), /Invalid configuration/);
  });
});
