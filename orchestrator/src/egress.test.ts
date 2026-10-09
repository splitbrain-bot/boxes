import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from './config.ts';
import { loadConfig } from './config.ts';
import { CredentialStore, type CredentialId, type CredentialRow } from './credentials.ts';
import { openDb, type Db } from './db.ts';
import {
  EgressManager,
  composePolicy,
  pushPolicy,
  resolveEgressMaterial,
  type EgressMaterial,
} from './egress.ts';

/** A real Claude token as the store holds it. */
const CLAUDE_TOKEN = 'sk-ant-oat01-the-real-claude-token';

/** A real OpenAI API key as the store holds it. */
const OPENAI_KEY = 'sk-therealopenaiapikey';

/** A real GitHub token as the store holds it. */
const GH_TOKEN = 'ghp_therealgithubtoken';

/** A real GitLab token as the store holds it. */
const GITLAB_TOKEN = 'glpat-therealgitlabtoken';

let dirs: string[] = [];
let servers: http.Server[] = [];
let dbs: Db[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const d of dbs) d.close();
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Creates a temporary data directory that afterEach removes. */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-egress-'));
  dirs.push(dir);
  return dir;
}

/** A config from an environment, with everything else defaulted. */
function configFrom(env: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: dataDir(), ...env });
}

/** A credential store over a database of its own, holding what was passed. */
function storeWith(
  cfg: Config,
  secrets: Partial<Record<CredentialId, string>> = {},
  onChange: () => void = () => {},
): { store: CredentialStore; db: Db } {
  const db = openDb(cfg.DATA_DIR);
  dbs.push(db);
  const store = new CredentialStore(db, onChange, cfg.credentialSet);
  for (const [id, secret] of Object.entries(secrets)) {
    store.put(id as CredentialId, 'token', secret);
  }
  return { store, db };
}

/** The rows a store holds, which is what composePolicy is given. */
function rows(store: CredentialStore): CredentialRow[] {
  return store.list();
}

describe('resolveEgressMaterial', () => {
  it('generates a CA and a control token, and stores them in the database', async () => {
    const { db } = storeWith(configFrom());
    const material = await resolveEgressMaterial(db);

    expect(material.ca.cert).toContain('BEGIN CERTIFICATE');
    expect(material.ca.key).toContain('PRIVATE KEY');
    expect(material.controlToken).toMatch(/^[0-9a-f]{64}$/);

    const stored = db.prepare("SELECT value FROM app_keys WHERE key = 'egress'").get() as {
      value: string;
    };
    expect(JSON.parse(stored.value)).toEqual(material);
  }, 30_000);

  it('reuses what it stored, because running boxes hold the old CA', async () => {
    const { db } = storeWith(configFrom());
    const first = await resolveEgressMaterial(db);
    const second = await resolveEgressMaterial(db);

    expect(second.ca.cert).toBe(first.ca.cert);
    expect(second.controlToken).toBe(first.controlToken);
  }, 30_000);

  it('never writes a real credential to the material', async () => {
    const { db } = storeWith(configFrom(), { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    await resolveEgressMaterial(db);
    const stored = db.prepare("SELECT value FROM app_keys WHERE key = 'egress'").get() as {
      value: string;
    };
    expect(stored.value).not.toContain(CLAUDE_TOKEN);
    expect(stored.value).not.toContain(GH_TOKEN);
  }, 30_000);
});

describe('composePolicy', () => {
  it('translates only the credentials the store holds a secret for', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, { github: GH_TOKEN });
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store));

    expect(policy.credentials.map((c) => c.id)).toEqual(['github']);
    expect(policy.credentials[0]?.secret).toBe(GH_TOKEN);
    expect(policy.credentials[0]?.placeholder).toBe(store.get('github')?.placeholder);
  }, 30_000);

  it('carries a Dev Tunnels login as its access token, with the tunnel scheme passed', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    store.put(
      'devtunnels',
      'oauth',
      JSON.stringify({ access_token: 'ghu_theaccesstoken', refresh_token: 'ghr_refresh' }),
    );
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store));

    expect(policy.credentials).toHaveLength(1);
    expect(policy.credentials[0]?.secret).toBe('ghu_theaccesstoken');
    expect(policy.credentials[0]?.passthroughSchemes).toEqual(['tunnel']);
  }, 30_000);

  it('intercepts nothing when the store is empty, and still carries the CA', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store));

    expect(policy.credentials).toEqual([]);
    // A box keeps the CA it was created with for its whole life, and a
    // credential may be added later.
    expect(policy.ca).not.toBeNull();
    expect(policy.ca?.cert).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('leaves the allowlist off when none is configured', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(db);
    expect(composePolicy(cfg, material, rows(store)).allowedHosts).toEqual([]);
  }, 30_000);

  it('adds the hosts a configured credential needs but never travels to', async () => {
    const cfg = configFrom({ EGRESS_ALLOWED_HOSTS: 'registry.npmjs.org' });
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(db);
    const { allowedHosts } = composePolicy(cfg, material, rows(store));

    expect(allowedHosts).toContain('registry.npmjs.org');
    expect(allowedHosts).toContain('platform.claude.com');
    expect(allowedHosts).toContain('codeload.github.com');
    // The credential's own hosts are implied by the proxy, not listed here.
    expect(allowedHosts).not.toContain('api.github.com');
  }, 30_000);

  it('intercepts the GitLab the deployment names, and only that one', async () => {
    const cfg = configFrom({ GITLAB_HOST: 'gitlab.example.com' });
    const { store, db } = storeWith(cfg, { gitlab: GITLAB_TOKEN });
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store));

    const gitlab = policy.credentials.find((c) => c.id === 'gitlab');
    expect(gitlab?.hosts).toEqual(['gitlab.example.com']);
    expect(gitlab?.headers).toEqual(['authorization', 'private-token']);
    expect(gitlab?.secret).toBe(GITLAB_TOKEN);
    expect(gitlab?.placeholder).toMatch(/^glpat-/);
  }, 30_000);

  it('has nothing to swap for a subscription obtained by logging in', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    // `codex login --device-auth` leaves a document, not a header value. It
    // authenticates traffic to chatgpt.com, which the proxy does not intercept.
    store.put('openai', 'oauth', '{"tokens":{"access_token":"a.b.c"}}');
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store));

    expect(policy.credentials.find((c) => c.id === 'openai')).toBeUndefined();
    // The row still has a placeholder, as a box holds one for every stored
    // credential, deliverable or not.
    expect(store.get('openai')?.placeholder).toMatch(/^sk-/);
  }, 30_000);

  it('intercepts the OpenAI key host, and only that one', async () => {
    const cfg = configFrom({ EGRESS_ALLOWED_HOSTS: 'registry.npmjs.org' });
    const { store, db } = storeWith(cfg, { openai: OPENAI_KEY });
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store));

    const openai = policy.credentials.find((c) => c.id === 'openai');
    expect(openai?.hosts).toEqual(['api.openai.com']);
    expect(openai?.headers).toEqual(['authorization']);
    expect(openai?.secret).toBe(OPENAI_KEY);
    expect(openai?.placeholder).toBe(store.get('openai')?.placeholder);

    // Codex logs in and refreshes at auth.openai.com and may talk to
    // chatgpt.com. Both stay reachable under a narrow allowlist, and the key
    // is sent to neither.
    expect(policy.allowedHosts).toContain('auth.openai.com');
    expect(policy.allowedHosts).toContain('chatgpt.com');
    expect(openai?.hosts).not.toContain('chatgpt.com');
    // The deployment allows these itself. The credential does not imply them.
    expect(policy.allowedHosts).not.toContain('files.openai.com');
    expect(policy.allowedHosts).not.toContain('ab.chatgpt.com');
  }, 30_000);
});

describe('the control channel, from the orchestrator side', () => {
  /** A stand-in proxy that records what it was pushed. */
  async function fakeProxy(answer: { status: number; body: unknown }): Promise<{
    cfg: Config;
    material: EgressMaterial;
    store: CredentialStore;
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
      EGRESS_PROXY_CONTAINER: '127.0.0.1',
      EGRESS_CONTROL_PORT: String(port),
    });
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(db);
    return { cfg, material, store, seen };
  }

  const okStatus = {
    applied: true,
    policyHash: 'abc',
    allowedHostCount: 0,
    credentialIds: ['claude', 'github'],
    denials: {},
    uptimeSeconds: 1,
  };

  it('pushes the policy with its bearer', async () => {
    const { cfg, material, store, seen } = await fakeProxy({ status: 200, body: okStatus });
    const policy = composePolicy(cfg, material, rows(store));

    await expect(pushPolicy(cfg, material, policy)).resolves.toEqual(okStatus);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/policy');
    expect(seen[0]?.auth).toBe(`Bearer ${material.controlToken}`);
    expect(JSON.parse(seen[0]!.body).credentials[0].secret).toBe(CLAUDE_TOKEN);
  }, 30_000);

  it('reports the proxy s own reason when it refuses a push', async () => {
    const { cfg, material, store } = await fakeProxy({
      status: 400,
      body: { error: 'invalid policy: a bare * ...' },
    });
    await expect(
      pushPolicy(cfg, material, composePolicy(cfg, material, rows(store))),
    ).rejects.toThrow(/proxy answered 400: invalid policy/);
  }, 30_000);
});

describe('EgressManager', () => {
  it('hands a box a placeholder for every stored credential, and the CA', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, {
      claude: CLAUDE_TOKEN,
      openai: OPENAI_KEY,
      github: GH_TOKEN,
    });
    const manager = new EgressManager(cfg, store, db);
    await manager.prepare();

    const claude = manager.placeholderFor('claude');
    const github = manager.placeholderFor('github');
    const openai = manager.placeholderFor('openai');

    expect(claude).not.toBe(CLAUDE_TOKEN);
    expect(claude.startsWith('sk-ant-oat01-')).toBe(true);
    expect(github).not.toBe(GH_TOKEN);
    expect(github.startsWith('ghp_')).toBe(true);
    expect(openai).not.toBe(OPENAI_KEY);
    // Codex checks the shape of its key, so the placeholder carries the prefix
    // a real one has.
    expect(openai.startsWith('sk-')).toBe(true);
    expect(manager.caCertificate()).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('has the CA before any credential exists, and no placeholder', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const manager = new EgressManager(cfg, store, db);
    await manager.prepare();

    // A box keeps the CA it was created with for its whole life. boxEnv drops
    // a variable with an empty value, so the box gets no credential variable.
    expect(manager.caCertificate()).toContain('BEGIN CERTIFICATE');
    expect(manager.placeholderFor('claude')).toBe('');
    expect(manager.placeholderFor('github')).toBe('');
    expect(manager.placeholderFor('openai')).toBe('');
  }, 30_000);

  it('has nothing for a credential this deployment cannot translate', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const manager = new EgressManager(cfg, store, db);
    await manager.prepare();

    expect(manager.placeholderFor('gemini')).toBe('');
  }, 30_000);

  it('recomposes from the store on every sync, so a pasted token is live', async () => {
    const seen: string[][] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(
          (JSON.parse(body) as { credentials: Array<{ id: string }> }).credentials.map(
            (c) => c.id,
          ),
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            applied: true,
            policyHash: 'x',
            allowedHostCount: 0,
            credentialIds: [],
            denials: {},
            uptimeSeconds: 1,
          }),
        );
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    const cfg = configFrom({
      EGRESS_PROXY_CONTAINER: '127.0.0.1',
      EGRESS_CONTROL_PORT: String(port),
    });
    // The wiring the app builds: a write to the store pushes the policy.
    let manager: EgressManager | undefined;
    const { store, db } = storeWith(cfg, {}, () => void manager?.sync());
    manager = new EgressManager(cfg, store, db);
    await manager.prepare();

    await manager.sync();
    expect(seen.at(-1)).toEqual([]);

    store.put('github', 'token', GH_TOKEN);
    await expect.poll(() => seen.at(-1)).toEqual(['github']);

    store.remove('github');
    await expect.poll(() => seen.at(-1)).toEqual([]);
  }, 30_000);

  it('records why a push failed, for the health probe', async () => {
    const cfg = configFrom({ EGRESS_CONTROL_PORT: '1' });
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN });
    const manager = new EgressManager(cfg, store, db);
    await manager.prepare();

    expect(manager.status()).toBeNull();
    await expect(manager.sync()).rejects.toThrow();
    expect(manager.status()).toMatchObject({ inSync: false });
    expect(manager.status()?.error).toBeTruthy();
  }, 30_000);
});
