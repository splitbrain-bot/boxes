import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from './config.ts';
import { CREDENTIAL_SET, loadConfig } from './config.ts';
import { CredentialStore, type CredentialId, type CredentialRow } from './credentials.ts';
import { openDb, type Db } from './db.ts';
import {
  EgressManager,
  composePolicy,
  pushPolicy,
  resolveEgressMaterial,
  type EgressMaterial,
} from './egress.ts';

/**
 * What the orchestrator composes, what it stores, and what it puts on the
 * control channel.
 */

const CLAUDE_TOKEN = 'sk-ant-oat01-the-real-claude-token';
const OPENAI_KEY = 'sk-therealopenaiapikey';
const GH_TOKEN = 'ghp_therealgithubtoken';

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

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-egress-'));
  dirs.push(dir);
  return dir;
}

/** A config from an environment, with everything else defaulted. */
function configFrom(env: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: dataDir(), ...env });
}

/**
 * A credential store over a database of its own, holding what was passed.
 *
 * The secrets come from here now rather than from the environment, so every
 * case below says what the deployment holds by writing it.
 */
function storeWith(
  cfg: Config,
  secrets: Partial<Record<CredentialId, string>> = {},
  onChange: () => void = () => {},
): CredentialStore {
  const db = openDb(cfg.DATA_DIR);
  dbs.push(db);
  const store = new CredentialStore(db, onChange);
  for (const [id, secret] of Object.entries(secrets)) {
    store.put(id as CredentialId, 'token', secret);
  }
  return store;
}

/** The rows a store holds, which is what composePolicy is given. */
function rows(store: CredentialStore): CredentialRow[] {
  return store.list();
}

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
  it('translates only the credentials the store holds a secret for', async () => {
    const cfg = configFrom();
    const store = storeWith(cfg, { github: GH_TOKEN });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
    const policy = composePolicy(cfg, material, rows(store));

    expect(policy.credentials.map((c) => c.id)).toEqual(['github']);
    expect(policy.credentials[0]?.secret).toBe(GH_TOKEN);
    expect(policy.credentials[0]?.placeholder).toBe(material.placeholders['github']);
  }, 30_000);

  it('intercepts nothing when the store is empty, and still carries the CA', async () => {
    const cfg = configFrom();
    const store = storeWith(cfg);
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
    const policy = composePolicy(cfg, material, rows(store));

    expect(policy.credentials).toEqual([]);
    // The CA is unconditional: a box created now holds it for as long as it
    // lives, and the credential that makes a host intercepted may arrive
    // tomorrow. Withholding it here is what used to leave such a box unable
    // to trust anything afterwards.
    expect(policy.ca).not.toBeNull();
    expect(policy.ca?.cert).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('holds a placeholder for every credential, configured or not', async () => {
    const cfg = configFrom();
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
    for (const spec of CREDENTIAL_SET) {
      expect(material.placeholders[spec.id]).toMatch(
        new RegExp(`^${spec.placeholderPrefix.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')}`),
      );
    }
  }, 30_000);

  it('leaves the allowlist off when none is configured', async () => {
    const cfg = configFrom();
    const store = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
    expect(composePolicy(cfg, material, rows(store)).allowedHosts).toEqual([]);
  }, 30_000);

  it('adds the hosts a configured credential needs but never travels to', async () => {
    const cfg = configFrom({ EGRESS_ALLOWED_HOSTS: 'registry.npmjs.org' });
    const store = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
    const { allowedHosts } = composePolicy(cfg, material, rows(store));

    expect(allowedHosts).toContain('registry.npmjs.org');
    expect(allowedHosts).toContain('platform.claude.com');
    expect(allowedHosts).toContain('codeload.github.com');
    // The credential's own hosts are implied by the proxy, not listed here.
    expect(allowedHosts).not.toContain('evil.com');
  }, 30_000);

  it('has nothing to swap for a subscription obtained by logging in', async () => {
    const cfg = configFrom();
    const store = storeWith(cfg);
    // What `codex login --device-auth` leaves behind: a document, not a
    // header value, and it authenticates traffic to chatgpt.com, which is
    // deliberately not intercepted. Storing it therefore changes nothing
    // about the wire — the row is kept and refreshed, and the harness health
    // is where a person is told it cannot reach a box yet.
    store.put('openai', 'oauth', '{"tokens":{"access_token":"a.b.c"}}');
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
    const policy = composePolicy(cfg, material, rows(store));

    expect(policy.credentials.find((c) => c.id === 'openai')).toBeUndefined();
    // The placeholder still exists, because a box holds one whether or not
    // its credential does.
    expect(material.placeholders['openai']).toMatch(/^sk-/);
  }, 30_000);

  it('intercepts the OpenAI key host, and only that one', async () => {
    const cfg = configFrom({ EGRESS_ALLOWED_HOSTS: 'registry.npmjs.org' });
    const store = storeWith(cfg, { openai: OPENAI_KEY });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
    const policy = composePolicy(cfg, material, rows(store));

    const openai = policy.credentials.find((c) => c.id === 'openai');
    expect(openai?.hosts).toEqual(['api.openai.com']);
    expect(openai?.headers).toEqual(['authorization']);
    expect(openai?.secret).toBe(OPENAI_KEY);
    expect(openai?.placeholder).toBe(material.placeholders['openai']);

    // Codex logs in and refreshes at one of these and may be talking to the
    // other with a credential Boxes does not hold; both must stay reachable
    // under a narrow allowlist, and neither is a host the key is sent to.
    expect(policy.allowedHosts).toContain('auth.openai.com');
    expect(policy.allowedHosts).toContain('chatgpt.com');
    expect(openai?.hosts).not.toContain('chatgpt.com');
    // A deployment's own choice rather than something the credential implies.
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
    const store = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(cfg.DATA_DIR, CREDENTIAL_SET);
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
  it('hands a box a placeholder for every credential, and the CA', async () => {
    const cfg = configFrom();
    const store = storeWith(cfg, {
      claude: CLAUDE_TOKEN,
      openai: OPENAI_KEY,
      github: GH_TOKEN,
    });
    const manager = new EgressManager(cfg, store);
    await manager.prepare();

    const claude = manager.placeholderFor('claude');
    const github = manager.placeholderFor('github');
    const openai = manager.placeholderFor('openai');

    expect(claude).not.toBe(CLAUDE_TOKEN);
    expect(claude.startsWith('sk-ant-oat01-')).toBe(true);
    expect(github).not.toBe(GH_TOKEN);
    expect(github.startsWith('ghp_')).toBe(true);
    expect(openai).not.toBe(OPENAI_KEY);
    expect(openai.startsWith('sk-')).toBe(true);
    expect(manager.caCertificate()).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('has a placeholder before the credential exists, and the CA with it', async () => {
    const cfg = configFrom();
    const manager = new EgressManager(cfg, storeWith(cfg));
    await manager.prepare();

    // The box created on a deployment that holds nothing is the case this
    // exists for: its environment is fixed now, and the token is entered
    // later.
    expect(manager.placeholderFor('claude')).toMatch(/^sk-ant-oat01-/);
    expect(manager.placeholderFor('github')).toMatch(/^ghp_/);
    // Codex checks the shape of its key, so the placeholder carries the prefix
    // a real one has. It exists whether or not a key has ever been entered.
    expect(manager.placeholderFor('openai')).toMatch(/^sk-/);
    expect(manager.caCertificate()).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('has nothing for a credential this deployment cannot translate', async () => {
    const cfg = configFrom();
    const manager = new EgressManager(cfg, storeWith(cfg));
    await manager.prepare();

    // An empty string rather than an invention: sessionEnv drops a variable
    // with no value, so the box is given nothing rather than nonsense.
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
    const store = storeWith(cfg, {}, () => void manager?.sync());
    manager = new EgressManager(cfg, store);
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
    const manager = new EgressManager(cfg, storeWith(cfg, { claude: CLAUDE_TOKEN }));
    await manager.prepare();

    expect(manager.status()).toBeNull();
    await expect(manager.sync()).rejects.toThrow();
    expect(manager.status()).toMatchObject({ inSync: false });
    expect(manager.status()?.error).toBeTruthy();
  }, 30_000);
});
