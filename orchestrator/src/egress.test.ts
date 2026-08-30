import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from './config.ts';
import { loadConfig } from './config.ts';
import {
  EgressManager,
  composePolicy,
  pushPolicy,
  readStatus,
  resolveEgressMaterial,
  type EgressMaterial,
} from './egress.ts';

/**
 * What the orchestrator composes, what it stores, and what it puts on the
 * control channel.
 */

const CLAUDE_TOKEN = 'sk-ant-oat01-the-real-claude-token';
const GH_TOKEN = 'ghp_therealgithubtoken';

let dirs: string[] = [];
let servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-egress-'));
  dirs.push(dir);
  return dir;
}

/** A config from an environment, with everything else defaulted. */
function configFrom(env: Record<string, string>): Config {
  return loadConfig({ DATA_DIR: dataDir(), ...env });
}

const bothCredentials = {
  PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
  PROFILE_DEFAULT_GH_TOKEN: GH_TOKEN,
};

describe('resolveEgressMaterial', () => {
  const specs = [
    { id: 'claude', placeholderPrefix: 'sk-ant-oat01-' },
    { id: 'github', placeholderPrefix: 'ghp_' },
  ];

  it('generates a CA, placeholders and a control token, and stores them 0600', async () => {
    const dir = dataDir();
    const material = await resolveEgressMaterial(dir, specs);

    expect(material.ca.cert).toContain('BEGIN CERTIFICATE');
    expect(material.ca.key).toContain('PRIVATE KEY');
    expect(material.placeholders['claude']).toMatch(/^sk-ant-oat01-.{20,}$/);
    expect(material.placeholders['github']).toMatch(/^ghp_.{20,}$/);
    expect(material.controlToken).toMatch(/^[0-9a-f]{64}$/);

    const path = join(dir, 'egress-secrets.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }, 30_000);

  it('reuses what it stored, because running sessions hold the old CA', async () => {
    const dir = dataDir();
    const first = await resolveEgressMaterial(dir, specs);
    const second = await resolveEgressMaterial(dir, specs);

    expect(second.ca.cert).toBe(first.ca.cert);
    expect(second.placeholders).toEqual(first.placeholders);
    expect(second.controlToken).toBe(first.controlToken);
  }, 30_000);

  it('adds a placeholder for a credential configured later, keeping the rest', async () => {
    const dir = dataDir();
    const first = await resolveEgressMaterial(dir, [specs[0]!]);
    expect(first.placeholders['github']).toBeUndefined();

    const second = await resolveEgressMaterial(dir, specs);
    expect(second.placeholders['claude']).toBe(first.placeholders['claude']);
    expect(second.placeholders['github']).toMatch(/^ghp_/);
  }, 30_000);

  it('regenerates rather than crashing on an unreadable store', async () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'egress-secrets.json'), 'not json at all');
    const material = await resolveEgressMaterial(dir, specs);
    expect(material.ca.cert).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('never writes a real credential to the store', async () => {
    const dir = dataDir();
    await resolveEgressMaterial(dir, specs);
    const stored = readFileSync(join(dir, 'egress-secrets.json'), 'utf8');
    expect(stored).not.toContain(CLAUDE_TOKEN);
    expect(stored).not.toContain(GH_TOKEN);
  }, 30_000);
});

describe('composePolicy', () => {
  it('translates only the credentials the deployment configured', async () => {
    const cfg = configFrom({ PROFILE_DEFAULT_GH_TOKEN: GH_TOKEN });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, cfg.egressCredentials);
    const policy = composePolicy(cfg, material);

    expect(policy.credentials.map((c) => c.id)).toEqual(['github']);
    expect(policy.credentials[0]?.secret).toBe(GH_TOKEN);
    expect(policy.credentials[0]?.placeholder).toBe(material.placeholders['github']);
    expect(policy.ca).not.toBeNull();
  }, 30_000);

  it('intercepts nothing when no credential is configured', async () => {
    const cfg = configFrom({});
    const material = await resolveEgressMaterial(cfg.DATA_DIR, cfg.egressCredentials);
    const policy = composePolicy(cfg, material);

    expect(policy.credentials).toEqual([]);
    expect(policy.ca).toBeNull();
  }, 30_000);

  it('leaves the allowlist off when none is configured', async () => {
    const cfg = configFrom(bothCredentials);
    const material = await resolveEgressMaterial(cfg.DATA_DIR, cfg.egressCredentials);
    expect(composePolicy(cfg, material).allowedHosts).toEqual([]);
  }, 30_000);

  it('adds the hosts a configured credential needs but never travels to', async () => {
    const cfg = configFrom({ ...bothCredentials, EGRESS_ALLOWED_HOSTS: 'registry.npmjs.org' });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, cfg.egressCredentials);
    const { allowedHosts } = composePolicy(cfg, material);

    expect(allowedHosts).toContain('registry.npmjs.org');
    expect(allowedHosts).toContain('platform.claude.com');
    expect(allowedHosts).toContain('codeload.github.com');
    // The credential's own hosts are implied by the proxy, not listed here.
    expect(allowedHosts).not.toContain('evil.com');
  }, 30_000);
});

describe('the control channel, from the orchestrator side', () => {
  /** A stand-in proxy that records what it was pushed. */
  async function fakeProxy(answer: { status: number; body: unknown }): Promise<{
    cfg: Config;
    material: EgressMaterial;
    seen: Array<{ method: string; url: string; auth: string; body: string }>;
  }> {
    const seen: Array<{ method: string; url: string; auth: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          auth: String(req.headers['authorization'] ?? ''),
          body,
        });
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    const cfg = configFrom({
      ...bothCredentials,
      EGRESS_PROXY_CONTAINER: '127.0.0.1',
      EGRESS_CONTROL_PORT: String(port),
    });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, cfg.egressCredentials);
    return { cfg, material, seen };
  }

  const okStatus = {
    applied: true,
    policyHash: 'abc',
    allowedHostCount: 0,
    credentialIds: ['claude', 'github'],
    denials: {},
    uptimeSeconds: 1,
  };

  it('pushes the policy with its bearer and reads the status back', async () => {
    const { cfg, material, seen } = await fakeProxy({ status: 200, body: okStatus });
    const policy = composePolicy(cfg, material);

    await expect(pushPolicy(cfg, material, policy)).resolves.toEqual(okStatus);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/policy');
    expect(seen[0]?.auth).toBe(`Bearer ${material.controlToken}`);
    expect(JSON.parse(seen[0]!.body).credentials[0].secret).toBe(CLAUDE_TOKEN);

    await expect(readStatus(cfg, material)).resolves.toEqual(okStatus);
    expect(seen[1]?.method).toBe('GET');
  }, 30_000);

  it('reports the proxy s own reason when it refuses a push', async () => {
    const { cfg, material } = await fakeProxy({
      status: 400,
      body: { error: 'invalid policy: a bare * ...' },
    });
    await expect(pushPolicy(cfg, material, composePolicy(cfg, material))).rejects.toThrow(
      /proxy answered 400: invalid policy/,
    );
  }, 30_000);
});

describe('EgressManager', () => {
  it('hands a session the placeholder and the CA, never the real credential', async () => {
    const cfg = configFrom(bothCredentials);
    const manager = new EgressManager(cfg);
    await manager.prepare();

    const claude = manager.sessionValue('claude', CLAUDE_TOKEN);
    const github = manager.sessionValue('github', GH_TOKEN);

    expect(claude).not.toBe(CLAUDE_TOKEN);
    expect(claude.startsWith('sk-ant-oat01-')).toBe(true);
    expect(github).not.toBe(GH_TOKEN);
    expect(github.startsWith('ghp_')).toBe(true);
    expect(manager.caCertificate()).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('passes a credential through untouched when the deployment translates none', async () => {
    const cfg = configFrom({});
    const manager = new EgressManager(cfg);
    await manager.prepare();

    // Nothing is intercepted, so nothing needs to trust the CA either.
    expect(manager.sessionValue('claude', '')).toBe('');
    expect(manager.caCertificate()).toBe('');
  }, 30_000);

  it('leaves a value it does not translate alone', async () => {
    const cfg = configFrom({ PROFILE_DEFAULT_GH_TOKEN: GH_TOKEN });
    const manager = new EgressManager(cfg);
    await manager.prepare();

    // A profile carrying some other token gets its own value: a placeholder
    // the proxy would refuse to translate is worse than no translation.
    expect(manager.sessionValue('github', 'ghp_someOtherProfilesToken')).toBe(
      'ghp_someOtherProfilesToken',
    );
    expect(manager.sessionValue('claude', CLAUDE_TOKEN)).toBe(CLAUDE_TOKEN);
  }, 30_000);

  it('records why a push failed, for the health probe', async () => {
    const cfg = configFrom({ ...bothCredentials, EGRESS_CONTROL_PORT: '1' });
    const manager = new EgressManager(cfg);
    await manager.prepare();

    expect(manager.status()).toBeNull();
    await expect(manager.sync()).rejects.toThrow();
    expect(manager.status()).toMatchObject({ inSync: false });
    expect(manager.status()?.error).toBeTruthy();
  }, 30_000);
});
