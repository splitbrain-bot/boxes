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

/** Runs a case against a throwaway data dir, so no case names a real one. */
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
    assert.equal(cfg.GITLAB_HOST, 'gitlab.com');
    assert.equal(cfg.LOG_LEVEL, 'info');
  });
});

test('an empty value means unset, not an invalid value', () => {
  withDataDir((dir) => {
    // What `FOO=` in an .env file, or a compose pass-through for a variable
    // the host does not set, actually delivers. None of these may fail the
    // boot for a setting nobody set.
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
    // The mistake a boolean environment variable exists to make: a coercion
    // that reads any non-empty string as true turns this into on.
    for (const off of ['false', '0', 'no', 'off']) {
      assert.equal(loadConfig({ DATA_DIR: dir, BOX_IMAGE_PRUNE: off }).BOX_IMAGE_PRUNE, false);
    }
    for (const on of ['true', '1', 'yes', 'on']) {
      assert.equal(loadConfig({ DATA_DIR: dir, BOX_IMAGE_PRUNE: on }).BOX_IMAGE_PRUNE, true);
    }
    // And a typo is a failed boot rather than whichever of the two is worse.
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
    assert.throws(() => loadConfig({ DATA_DIR: dir, BOX_MEM_LIMIT: 'lots' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, PERMISSION_FALLBACK: 'maybe' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, LOG_LEVEL: 'verbose' }), /Invalid configuration/);
    assert.throws(() => loadConfig({ DATA_DIR: dir, BOX_CPUS: '-1' }), /Invalid configuration/);
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
  withDataDir((dir) => {
    const { credentialSet } = loadConfig({ DATA_DIR: dir });
    assert.deepEqual(
      credentialSet.map((c) => c.id),
      ['claude', 'openai', 'github', 'gitlab'],
    );
    const github = credentialSet.find((c) => c.id === 'github');
    assert.ok(github?.hosts.includes('api.github.com'));
    assert.deepEqual(github?.headers, ['authorization']);
    assert.ok(credentialSet.every((c) => c.placeholderPrefix !== ''));

    const gitlab = credentialSet.find((c) => c.id === 'gitlab');
    // gitlab.com until a deployment names its own instance, and that host
    // alone is intercepted for the credential.
    assert.deepEqual(gitlab?.hosts, ['gitlab.com']);
    // git's Basic pair and a bearer in the one header, glab's personal access
    // token in the other.
    assert.deepEqual(gitlab?.headers, ['authorization', 'private-token']);
    assert.equal(gitlab?.placeholderPrefix, 'glpat-');
  });
});

test('a self-managed GitLab replaces the host the credential travels to', () => {
  withDataDir((dir) => {
    const { credentialSet } = loadConfig({ DATA_DIR: dir, GITLAB_HOST: 'gitlab.example.com' });
    const gitlab = credentialSet.find((c) => c.id === 'gitlab');
    assert.deepEqual(gitlab?.hosts, ['gitlab.example.com']);
    // gitlab.com is then nobody's host, so nothing is intercepted there.
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
  // Codex sends it as a bearer and nothing else.
  assert.deepEqual(openai?.headers, ['authorization']);
  // `chatgpt.com` is the subscription endpoint, which rejects an API key and
  // whose credential Boxes does not hold yet; `auth.openai.com` is where Codex
  // logs in and refreshes. Both have to stay reachable under a narrow
  // allowlist, and neither may be intercepted.
  assert.deepEqual(openai?.alsoAllow, ['auth.openai.com', 'chatgpt.com']);
  assert.ok(!openai?.hosts.includes('chatgpt.com'));
  // Codex checks the shape of the key before it sends it anywhere, so the
  // placeholder has to look like one.
  assert.equal(openai?.placeholderPrefix, 'sk-');
});

test('the box uid defaults off 1000 and is settable', () => {
  withDataDir((dir) => {
    // 1000 is the base image's own uid and, on a real host, usually a person's.
    // The default moves off it so a deployment can give the agent a uid of its
    // own the way it would any other service.
    const base = loadConfig({ DATA_DIR: dir });
    assert.equal(base.BOX_UID, 1020);
    assert.equal(base.BOX_GID, 1020);

    const set = loadConfig({ DATA_DIR: dir, BOX_UID: '1000', BOX_GID: '1000' });
    assert.equal(set.BOX_UID, 1000);
    assert.equal(set.BOX_GID, 1000);

    // Root would put a box's every process back at uid 0, which the whole
    // container template exists to avoid, so it is not a value to accept.
    assert.throws(() => loadConfig({ DATA_DIR: dir, BOX_UID: '0' }));
    assert.throws(() => loadConfig({ DATA_DIR: dir, BOX_UID: 'agent' }));
  });
});
