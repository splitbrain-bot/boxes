import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyStore } from './api-keys.ts';
import { boxEnv } from './boxenv.ts';
import { type Config, loadConfig } from './config.ts';
import { type CredentialId, type CredentialMethod, CredentialStore } from './credentials.ts';
import { type Db, openDb } from './db.ts';
import { EgressManager } from './egress.ts';
import { DockerRuntime } from './runtime/docker.ts';

/** A real Claude token as the store holds it. */
const CLAUDE_TOKEN = 'sk-ant-oat01-the-real-claude-token';

/** A real Anthropic API key as the store holds it. */
const ANTHROPIC_KEY = 'sk-ant-api03-the-real-anthropic-key';

/** A real GitHub token as the store holds it. */
const GH_TOKEN = 'ghp_therealgithubtoken';

/** A real OpenAI API key as the store holds it. */
const OPENAI_KEY = 'sk-therealopenaiapikey';

/** A real GitLab token as the store holds it. */
const GITLAB_TOKEN = 'glpat-therealgitlabtoken';

/** A real Dev Tunnels token as the store holds it. */
const DEVTUNNELS_TOKEN = 'ghu_therealdevtunnelstoken';

/** The temporary data directories of the current test. */
let dirs: string[] = [];
/** The open databases of the current test. */
let dbs: Db[] = [];

afterEach(() => {
  for (const d of dbs) d.close();
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * Creates a temporary data directory that afterEach removes.
 *
 * @returns The path of the directory.
 */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-boxenv-'));
  dirs.push(dir);
  return dir;
}

/**
 * Creates a deployment with a config, a credential store with the given
 * secrets, and a prepared egress manager.
 *
 * @param secrets The secret of each stored credential.
 * @param over The config variables that replace the defaults.
 * @param methods The method of each stored credential. The default is a token.
 * @returns The config, the database and the egress manager.
 */
async function deployment(
  secrets: Partial<Record<CredentialId, string>> = {},
  over: Record<string, string> = {},
  methods: Partial<Record<CredentialId, CredentialMethod>> = {},
): Promise<{ cfg: Config; db: Db; egress: EgressManager }> {
  const cfg = loadConfig({ DATA_DIR: dataDir(), ...over });
  const db = openDb(cfg.DATA_DIR);
  dbs.push(db);
  const credentials = new CredentialStore(db, () => {}, cfg.credentialSet);
  for (const [id, secret] of Object.entries(secrets)) {
    credentials.put('', id as CredentialId, methods[id as CredentialId] ?? 'token', secret);
  }
  const egress = new EgressManager(cfg, credentials, new ApiKeyStore(db, () => {}), db);
  await egress.prepare();
  return { cfg, db, egress };
}

/**
 * Builds the environment of one box for a deployment with the given secrets.
 *
 * @param secrets The secret of each stored credential.
 * @param over The config variables that replace the defaults.
 * @param methods The method of each stored credential. The default is a token.
 * @returns The variables by name.
 */
async function envFor(
  secrets: Partial<Record<CredentialId, string>> = {},
  over: Record<string, string> = {},
  methods: Partial<Record<CredentialId, CredentialMethod>> = {},
): Promise<Record<string, string>> {
  const { cfg, egress } = await deployment(secrets, over, methods);
  return boxEnv({
    placeholderFor: (id) => egress.placeholderFor('', id),
    methodFor: (id) => egress.methodFor('', id),
    gitlabHost: cfg.GITLAB_HOST,
    proxyUrl: new DockerRuntime(cfg).proxyUrl(),
    hasCa: egress.caCertificate() !== '',
    apiKeys: egress.apiKeyEnv(''),
  });
}

describe('boxEnv', () => {
  it('carries placeholders, and no real credential anywhere in it', async () => {
    const env = await envFor({ claude: CLAUDE_TOKEN, github: GH_TOKEN });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^sk-ant-oat01-/);
    expect(env.GH_TOKEN).toMatch(/^ghp_/);

    const everything = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    expect(everything).not.toContain(CLAUDE_TOKEN);
    expect(everything).not.toContain(GH_TOKEN);
  }, 30_000);

  it('carries a Claude API key as ANTHROPIC_API_KEY instead of the OAuth token', async () => {
    // Claude Code sends the API key as x-api-key, and it wins over a token.
    const env = await envFor({ claude: ANTHROPIC_KEY }, {}, { claude: 'api_key' });

    expect(env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-/);
    expect(env.ANTHROPIC_API_KEY).not.toBe(ANTHROPIC_KEY);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  }, 30_000);

  it('carries no credential variable where nothing is configured', async () => {
    const env = await envFor();

    // The environment holds a placeholder only for a stored credential.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    // The other variables of each harness still come from the registry.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/agent/.claude');
    expect(env.CODEX_HOME).toBe('/home/agent/.codex');
  }, 30_000);

  it('carries the GitLab host always, and the token once one is stored', async () => {
    // glab reads the host, and the box setup points the git credential helper at it.
    const env = await envFor();
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.GITLAB_HOST).toBe('gitlab.com');

    const own = await envFor({ gitlab: GITLAB_TOKEN }, { GITLAB_HOST: 'gitlab.example.com' });
    expect(own.GITLAB_TOKEN).toMatch(/^glpat-/);
    expect(own.GITLAB_TOKEN).not.toBe(GITLAB_TOKEN);
    expect(own.GITLAB_HOST).toBe('gitlab.example.com');
  }, 30_000);

  it('carries a Dev Tunnels placeholder for the share-app skill', async () => {
    const env = await envFor({ devtunnels: DEVTUNNELS_TOKEN });
    expect(env.DEVTUNNELS_TOKEN).toMatch(/^ghu_/);
    expect(env.DEVTUNNELS_TOKEN).not.toBe(DEVTUNNELS_TOKEN);
  }, 30_000);

  it('carries what Codex needs to log itself in from the environment', async () => {
    // `codex-acp` reads CODEX_API_KEY when it logs in with the api-key method.
    // DEFAULT_AUTH_REQUEST selects that method for a `session/*` call that needs a
    // login. The value must be the JSON that the adapter parses.
    const env = await envFor({ openai: OPENAI_KEY });

    expect(env.CODEX_API_KEY).toMatch(/^sk-/);
    expect(env.CODEX_API_KEY).not.toBe(OPENAI_KEY);
    expect(env.DEFAULT_AUTH_REQUEST).toBe('{"methodId":"api-key"}');
    expect(JSON.parse(env.DEFAULT_AUTH_REQUEST!)).toEqual({ methodId: 'api-key' });
    // A new Codex thread starts in the mode from the registry. The browser login
    // is hidden, because nothing in a box can open a browser.
    expect(env.INITIAL_AGENT_MODE).toBe('agent-full-access');
    expect(env.NO_BROWSER).toBe('1');
  }, 30_000);

  it('points every client at the CA, whether or not anything is intercepted', async () => {
    const path = '/home/agent/.boxes/ca-bundle.crt';
    for (const env of [await envFor({ github: GH_TOKEN }), await envFor()]) {
      expect(env.NODE_EXTRA_CA_CERTS).toBe(path);
      expect(env.SSL_CERT_FILE).toBe(path);
      expect(env.GIT_SSL_CAINFO).toBe(path);
      expect(env.CURL_CA_BUNDLE).toBe(path);
      // Codex reads this one before SSL_CERT_FILE.
      expect(env.CODEX_CA_CERTIFICATE).toBe(path);
    }
  }, 30_000);

  it('still routes every client through the proxy', async () => {
    const env = await envFor();
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
  }, 30_000);

  it('carries the API keys a user added, under their own names', () => {
    const env = boxEnv({
      placeholderFor: () => 'ghp_placeholder',
      methodFor: () => 'token',
      gitlabHost: 'gitlab.com',
      proxyUrl: 'http://proxy:3128',
      hasCa: true,
      apiKeys: { OPENROUTER_API_KEY: 'sk-or-v1-placeholder', GH_TOKEN: 'sk-other' },
    });

    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-placeholder');
    // A variable of Boxes has priority over a key with the same name.
    expect(env.GH_TOKEN).toBe('ghp_placeholder');
  });
});
