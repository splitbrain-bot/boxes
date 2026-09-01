import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { EgressManager } from './egress.ts';
import {
  createContainer,
  sessionEnv,
  setDockerForTests,
  type CreateContainerSpec,
} from './docker.ts';

/**
 * The environment of a session container, which is the only place a session's
 * credentials ever come from — and, with translation on, the place a real one
 * must never appear.
 */

const CLAUDE_TOKEN = 'sk-ant-oat01-the-real-claude-token';
const GH_TOKEN = 'ghp_therealgithubtoken';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-docker-'));
  dirs.push(dir);
  return dir;
}

/** The env of one session, as a map, for a given deployment environment. */
async function envFor(over: Record<string, string>): Promise<Record<string, string>> {
  const cfg = loadConfig({ DATA_DIR: dataDir(), ...over });
  const egress = new EgressManager(cfg);
  await egress.prepare();

  const profile = cfg.profiles['DEFAULT']!;
  const spec: CreateContainerSpec = {
    sessionId: 'abcd1234',
    image: cfg.SESSION_IMAGE,
    networkName: 'sn-abcd1234',
    subnet: '10.200.0.0/29',
    workspaceSource: '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234',
    homeVolume: 'home-abcd1234',
    profile,
    egress: {
      claudeOauthToken: egress.sessionValue('claude', profile.claudeOauthToken),
      ghToken: egress.sessionValue('github', profile.ghToken),
      caCertificate: egress.caCertificate(),
    },
  };

  return Object.fromEntries(
    sessionEnv(spec, cfg).map((entry) => {
      const eq = entry.indexOf('=');
      return [entry.slice(0, eq), entry.slice(eq + 1)];
    }),
  );
}

describe('sessionEnv', () => {
  it('carries placeholders, and no real credential anywhere in it', async () => {
    const env = await envFor({
      PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      PROFILE_DEFAULT_GH_TOKEN: GH_TOKEN,
    });

    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toMatch(/^sk-ant-oat01-/);
    expect(env['GH_TOKEN']).toMatch(/^ghp_/);

    const everything = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    expect(everything).not.toContain(CLAUDE_TOKEN);
    expect(everything).not.toContain(GH_TOKEN);
  }, 30_000);

  it('points every client at the CA the proxy intercepts with', async () => {
    const env = await envFor({ PROFILE_DEFAULT_GH_TOKEN: GH_TOKEN });
    const path = '/home/agent/.boxes/proxy-ca.crt';

    expect(env['BOXES_PROXY_CA']).toContain('BEGIN CERTIFICATE');
    expect(env['NODE_EXTRA_CA_CERTS']).toBe(path);
    expect(env['SSL_CERT_FILE']).toBe(path);
    expect(env['GIT_SSL_CAINFO']).toBe(path);
    expect(env['CURL_CA_BUNDLE']).toBe(path);
  }, 30_000);

  it('adds no CA trust when the deployment intercepts nothing', async () => {
    const env = await envFor({});

    expect(env['BOXES_PROXY_CA']).toBeUndefined();
    expect(env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    // Egress itself is unchanged: the proxy is still the only way out.
    expect(env['HTTPS_PROXY']).toBe('http://proxy:3128');
  }, 30_000);

  it('still carries the git identity, which is not a credential', async () => {
    const env = await envFor({ PROFILE_DEFAULT_GIT_NAME: 'boxes-bot' });
    expect(env['GIT_NAME']).toBe('boxes-bot');
  }, 30_000);
});

describe('the container template', () => {
  /** Captures what createContainer would ask the daemon for. */
  async function capture(): Promise<Record<string, unknown>> {
    const cfg = loadConfig({ DATA_DIR: dataDir() });
    const egress = new EgressManager(cfg);
    await egress.prepare();
    const profile = cfg.profiles['DEFAULT']!;

    let opts: Record<string, unknown> = {};
    setDockerForTests({
      createContainer: async (o: Record<string, unknown>) => {
        opts = o;
        return { id: 'deadbeef' };
      },
    } as unknown as Docker);
    try {
      await createContainer(
        {
          sessionId: 'abcd1234',
          image: cfg.SESSION_IMAGE,
          networkName: 'sn-abcd1234',
          subnet: '10.200.0.0/29',
          workspaceSource: '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234',
          homeVolume: 'home-abcd1234',
          profile,
          egress: {
            claudeOauthToken: '',
            ghToken: '',
            caCertificate: '',
          },
        },
        cfg,
      );
    } finally {
      setDockerForTests(null);
    }
    return opts;
  }

  it('binds the workspace from a host path and the home from a volume', async () => {
    const opts = await capture();
    const host = opts['HostConfig'] as { Binds: string[] };
    // A path, not a volume name: the orchestrator has to read these files
    // itself, which is what the whole review surface rests on.
    assert.deepEqual(host.Binds, [
      '/var/lib/docker/volumes/boxes-data/_data/workspaces/abcd1234:/workspace',
      'home-abcd1234:/home/agent',
    ]);
  }, 30_000);

  it('runs as the configured uid and gid, not the image\'s user name', async () => {
    const opts = await capture();
    // Numbers, so SESSION_UID alone decides who a session is. The default
    // is off 1000 deliberately: on a real host that is usually a person.
    assert.equal(opts['User'], '1020:1020');
  }, 30_000);

  it('tells an outside updater to leave session containers alone', async () => {
    const opts = await capture();
    const labels = opts['Labels'] as Record<string, string>;
    // The session id is how Boxes finds its own containers again.
    assert.equal(labels['boxes.session'], 'abcd1234');
    // And this is how something else is told not to. A container recreated
    // from under the orchestrator loses the id in the database and the
    // runtime proxy attachment that is the session's only way out; the
    // orchestrator rolls sessions onto a new image itself, at start.
    assert.equal(labels['com.centurylinklabs.watchtower.enable'], 'false');
  }, 30_000);

  it('keeps the isolation the workspace change does not touch', async () => {
    const opts = await capture();
    const host = opts['HostConfig'] as Record<string, unknown>;
    assert.equal(opts['User'], '1020:1020');
    assert.equal(host['ReadonlyRootfs'], true);
    assert.deepEqual(host['CapDrop'], ['ALL']);
    assert.equal(host['Privileged'], false);
    assert.deepEqual(host['SecurityOpt'], ['no-new-privileges:true']);
  }, 30_000);
});
