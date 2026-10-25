import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { loadConfig } from './config.ts';

/**
 * Runs a case with a temporary data directory, so no case uses a real one.
 *
 * @param fn The case, which gets the path of the directory.
 * @returns The result of the case.
 */
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
    assert.equal(cfg.BOX_IMAGE, 'ghcr.io/splitbrain/boxes/box:latest');
    assert.equal(cfg.BOX_SUBNET_POOL, '10.200.0.0/16');
    assert.equal(cfg.BOX_MEM_LIMIT, '4g');
    assert.equal(cfg.BOX_CPUS, 2);
    assert.equal(cfg.BOX_PIDS_LIMIT, 512);
    assert.equal(cfg.IDLE_STOP_MINUTES, 30);
    assert.equal(cfg.BOX_IMAGE_PRUNE, true);
    assert.equal(cfg.BACKGROUND_POLL_SECONDS, 20);
    assert.equal(cfg.PERMISSION_FALLBACK, 'hold');
    assert.equal(cfg.PERMISSION_HOLD_MINUTES, 120);
    assert.equal(cfg.EGRESS_PROXY_CONTAINER, 'boxes-egress-proxy');
    assert.equal(cfg.EGRESS_PROXY_ALIAS, 'proxy');
    assert.equal(cfg.EGRESS_PROXY_PORT, 3128);
    assert.equal(cfg.EGRESS_CONTROL_URL, 'http://boxes-egress-proxy:3129');
    assert.equal(cfg.GITLAB_HOST, 'gitlab.com');
    assert.equal(cfg.LOG_LEVEL, 'info');
  });
});

test('an empty value means unset, not an invalid value', () => {
  withDataDir((dir) => {
    // An .env line like `FOO=` and a compose pass-through of an unset host
    // variable both deliver an empty string.
    const cfg = loadConfig({
      DATA_DIR: dir,
      BOX_IMAGE: '',
      BOX_SUBNET_POOL: '',
      BOX_MEM_LIMIT: '',
      BOX_CPUS: '',
      BOX_PIDS_LIMIT: '',
      IDLE_STOP_MINUTES: '',
      BOX_IMAGE_PRUNE: '',
      PERMISSION_FALLBACK: '',
      PERMISSION_HOLD_MINUTES: '',
    });
    assert.equal(cfg.BOX_MEM_LIMIT, '4g');
    assert.equal(cfg.BOX_CPUS, 2);
    assert.equal(cfg.PERMISSION_FALLBACK, 'hold');
    assert.equal(cfg.IDLE_STOP_MINUTES, 30);
    assert.equal(cfg.BOX_IMAGE_PRUNE, true);
  });
});

test('an off switch is off however it is spelled, and never on by accident', () => {
  withDataDir((dir) => {
    // A coercion that reads any non-empty string as true would turn "false" on.
    for (const off of ['false', '0', 'no', 'off']) {
      assert.equal(loadConfig({ DATA_DIR: dir, BOX_IMAGE_PRUNE: off }).BOX_IMAGE_PRUNE, false);
    }
    for (const on of ['true', '1', 'yes', 'on']) {
      assert.equal(loadConfig({ DATA_DIR: dir, BOX_IMAGE_PRUNE: on }).BOX_IMAGE_PRUNE, true);
    }
    // A typo fails the boot.
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, BOX_IMAGE_PRUNE: 'nope' }),
      /Invalid configuration/,
    );
  });
});

test('a provided value wins over the default', () => {
  withDataDir((dir) => {
    const cfg = loadConfig({
      DATA_DIR: dir,
      BOX_MEM_LIMIT: '8g',
      BOX_CPUS: '4',
      PERMISSION_FALLBACK: 'deny',
      PUSH_SUBJECT: 'mailto:ops@example.com',
    });
    assert.equal(cfg.BOX_MEM_LIMIT, '8g');
    assert.equal(cfg.BOX_CPUS, 4);
    assert.equal(cfg.PERMISSION_FALLBACK, 'deny');
    assert.equal(cfg.PUSH_SUBJECT, 'mailto:ops@example.com');
  });
});

test('a genuinely invalid value still fails the boot', () => {
  withDataDir((dir) => {
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, BOX_MEM_LIMIT: 'lots' }),
      /Invalid configuration/,
    );
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, PERMISSION_FALLBACK: 'maybe' }),
      /Invalid configuration/,
    );
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, LOG_LEVEL: 'verbose' }),
      /Invalid configuration/,
    );
    assert.throws(() => loadConfig({ DATA_DIR: dir, BOX_CPUS: '-1' }), /Invalid configuration/);
    assert.throws(
      () => loadConfig({ DATA_DIR: dir, PUSH_SUBJECT: 'ops@example.com' }),
      /Invalid configuration/,
    );
  });
});

test('no secret comes from the environment any more', () => {
  withDataDir((dir) => {
    // Credentials are in the database. The config ignores each PROFILE_DEFAULT_* variable.
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
  // Hosts and headers are fixed per service. The secrets come from the store.
  withDataDir((dir) => {
    const { credentialSet } = loadConfig({ DATA_DIR: dir });
    assert.deepEqual(
      credentialSet.map((c) => c.id),
      ['claude', 'openai', 'github', 'gitlab', 'devtunnels'],
    );
    const github = credentialSet.find((c) => c.id === 'github');
    assert.ok(github?.hosts.includes('api.github.com'));
    assert.deepEqual(github?.headers, ['authorization']);
    assert.ok(credentialSet.every((c) => c.placeholderPrefix !== ''));

    const gitlab = credentialSet.find((c) => c.id === 'gitlab');
    // By default, only gitlab.com is intercepted.
    assert.deepEqual(gitlab?.hosts, ['gitlab.com']);
    // git sends Basic or bearer auth in authorization. glab sends its personal
    // access token in private-token.
    assert.deepEqual(gitlab?.headers, ['authorization', 'private-token']);
    assert.equal(gitlab?.placeholderPrefix, 'glpat-');

    const devtunnels = credentialSet.find((c) => c.id === 'devtunnels');
    // The control planes and the relays.
    assert.deepEqual(devtunnels?.hosts, ['*.rel.tunnels.api.visualstudio.com']);
    assert.equal(devtunnels?.placeholderPrefix, 'ghu_');
  });
});

test('a self-managed GitLab replaces the host the credential travels to', () => {
  withDataDir((dir) => {
    const { credentialSet } = loadConfig({ DATA_DIR: dir, GITLAB_HOST: 'gitlab.example.com' });
    const gitlab = credentialSet.find((c) => c.id === 'gitlab');
    assert.deepEqual(gitlab?.hosts, ['gitlab.example.com']);
    // No credential is intercepted at gitlab.com.
    assert.ok(!credentialSet.some((c) => c.hosts.includes('gitlab.com')));
  });
});

test('a GitLab host is a bare hostname, or the boot fails', () => {
  withDataDir((dir) => {
    for (const bad of [
      'https://gitlab.example.com',
      'gitlab.example.com/group',
      'gitlab',
      '*.example.com',
    ]) {
      assert.throws(() => loadConfig({ DATA_DIR: dir, GITLAB_HOST: bad }), /GITLAB_HOST/);
    }
  });
});

test('the OpenAI credential travels to the API-key endpoint alone', () => {
  const openai = withDataDir((dir) => loadConfig({ DATA_DIR: dir })).credentialSet.find(
    (c) => c.id === 'openai',
  );
  // One intercepted host, because only `api.openai.com` takes an API key.
  assert.deepEqual(openai?.hosts, ['api.openai.com']);
  // Codex sends it as a bearer token.
  assert.deepEqual(openai?.headers, ['authorization']);
  // `chatgpt.com` is the subscription endpoint and rejects an API key. Codex
  // logs in and refreshes at `auth.openai.com`. Both stay reachable in a
  // closed profile, and neither is intercepted.
  assert.deepEqual(openai?.alsoAllow, ['auth.openai.com', 'chatgpt.com']);
  assert.ok(!openai?.hosts.includes('chatgpt.com'));
  // The placeholder starts like an OpenAI key, so a client that checks the format
  // of the key accepts it.
  assert.equal(openai?.placeholderPrefix, 'sk-');
});

test('the box uid defaults off 1000 and is settable', () => {
  withDataDir((dir) => {
    // 1000 is the uid of the base image, and on a host it is usually the uid of a
    // person. The default gives the agent its own uid, like each other service.
    const base = loadConfig({ DATA_DIR: dir });
    assert.equal(base.BOX_UID, 1020);
    assert.equal(base.BOX_GID, 1020);

    const set = loadConfig({ DATA_DIR: dir, BOX_UID: '1000', BOX_GID: '1000' });
    assert.equal(set.BOX_UID, 1000);
    assert.equal(set.BOX_GID, 1000);

    // Root would run every process of the box as uid 0.
    assert.throws(() => loadConfig({ DATA_DIR: dir, BOX_UID: '0' }));
    assert.throws(() => loadConfig({ DATA_DIR: dir, BOX_UID: 'agent' }));
  });
});
