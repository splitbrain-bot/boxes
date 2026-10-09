import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { loadConfig } from './config.ts';
import {
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  CredentialStore,
  DEVTUNNELS_CLIENT_ID,
  GITHUB_TOKEN_URL,
  deliverableSecret,
  refreshCredentials,
  undeliverableReason,
  type TokenAnswer,
} from './credentials.ts';
import { openDb, type Db } from './db.ts';

let dir: string;
let db: Db;
let changes: number;
let store: CredentialStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-credentials-'));
  db = openDb(dir);
  changes = 0;
  store = new CredentialStore(
    db,
    () => {
      changes += 1;
    },
    loadConfig({ DATA_DIR: dir }).credentialSet,
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a pasted secret is stored whole and shown as its last four characters', () => {
  const row = store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');

  assert.equal(row.secret, 'sk-ant-oat01-abcdefgh1234');
  assert.equal(row.account, '1234');
  assert.equal(row.status, 'ok');
  assert.equal(row.expires_at, null);
  assert.equal(store.get('claude')?.secret, 'sk-ant-oat01-abcdefgh1234');
});

test('a secret with nothing to spare is shown as nothing rather than as itself', () => {
  assert.equal(store.put('github', 'token', 'ghp_').account, null);
});

test('a login passes the account it was told, instead of the derived one', () => {
  const row = store.put('claude', 'oauth', '{"access_token":"a"}', {
    account: 'someone@example.com',
    expires_at: 1000,
  });
  assert.equal(row.account, 'someone@example.com');
  assert.equal(row.expires_at, 1000);
});

test('a replacement keeps the credential created_at and clears the old error', () => {
  const first = store.put('github', 'token', 'ghp_oldtoken');
  store.markStatus('github', 'failing', '401 from GitHub');
  assert.equal(store.get('github')?.status, 'failing');

  const second = store.put('github', 'token', 'ghp_newtoken');
  assert.equal(second.created_at, first.created_at);
  assert.ok(second.updated_at >= first.updated_at);
  // Pasting a new token is the answer to whatever the old one's error said.
  assert.equal(second.status, 'ok');
  assert.equal(second.last_error, null);
  assert.equal(store.list().length, 1);
});

test('a status is recorded without touching the secret', () => {
  store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  store.markStatus('claude', 'expired', 'the token is a year old');

  const row = store.get('claude');
  assert.equal(row?.status, 'expired');
  assert.equal(row?.last_error, 'the token is a year old');
  // Still the token the proxy has to send, and still the one the page names.
  assert.equal(row?.secret, 'sk-ant-oat01-abcdefgh1234');
  assert.equal(row?.account, '1234');
});

test('a new credential gets a placeholder shaped like its token, kept across replacements', () => {
  const first = store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  assert.match(first.placeholder, /^sk-ant-oat01-.{20,}$/);
  assert.notEqual(first.placeholder, first.secret);
  assert.equal(store.placeholderFor('claude'), first.placeholder);

  // A box holds the placeholder in its environment, and Codex copies its own
  // into auth.json, so neither a refresh nor a new paste may change it.
  const second = store.put('claude', 'token', 'sk-ant-oat01-replaced5678');
  assert.equal(second.placeholder, first.placeholder);
  assert.equal(store.get('claude')?.placeholder, first.placeholder);
});

test('a credential entered again after removal gets a new placeholder', () => {
  const before = store.put('github', 'token', 'ghp_thefirsttoken').placeholder;
  store.remove('github');
  assert.equal(store.placeholderFor('github'), '');

  const after = store.put('github', 'token', 'ghp_thesecondtoken').placeholder;
  assert.match(after, /^ghp_/);
  assert.notEqual(after, before);
});

test('a credential that is not stored has no placeholder, nor has an unknown one', () => {
  assert.equal(store.placeholderFor('claude'), '');
  assert.equal(store.placeholderFor('gemini'), '');
});

test('a summary carries everything but the secret', () => {
  const row = store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  const summary = store.summarize(row);

  assert.deepEqual(summary, {
    id: 'claude',
    method: 'token',
    account: '1234',
    status: 'ok',
    lastError: null,
    expiresAt: null,
    refreshedAt: null,
    updatedAt: row.updated_at,
  });
  assert.ok(!JSON.stringify(summary).includes('sk-ant-oat01-abcdefgh1234'));
});

test('every write is announced, because the policy is composed from these rows', () => {
  store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  assert.equal(changes, 1);
  store.markStatus('claude', 'failing', 'nope');
  assert.equal(changes, 2);
  store.remove('claude');
  assert.equal(changes, 3);
  assert.equal(store.get('claude'), undefined);
});

test('the list is in the order the settings page shows them', () => {
  store.put('github', 'token', 'ghp_therealgithubtoken');
  store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');

  assert.deepEqual(
    store.list().map((r) => r.id),
    ['claude', 'github'],
  );
});

// --- keeping an account credential alive -------------------------------------

/** A JWT whose payload holds claims. The header and signature are placeholders. */
function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `header.${body}.signature`;
}

/** What the Codex CLI leaves in `$CODEX_HOME/auth.json`. */
function authJson(expSeconds: number, lastRefresh: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: 'someone@example.com' }),
      access_token: jwt({ exp: expSeconds }),
      refresh_token: 'the-refresh-token',
      account_id: 'acct_123',
    },
    last_refresh: lastRefresh,
  });
}

/** A recording POST that answers with whatever it was given. */
function posts(answer: TokenAnswer | Error): {
  calls: Array<{ url: string; body: Record<string, string> }>;
  post: (url: string, body: Record<string, string>) => Promise<TokenAnswer>;
} {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** The clock every refresh case runs at, in epoch milliseconds. */
const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

/** Ten minutes after NOW, in epoch seconds as a JWT exp claim holds it. */
const IN_TEN_MINUTES = Math.floor((NOW + 10 * 60_000) / 1000);

/** Five hours after NOW, in epoch seconds as a JWT exp claim holds it. */
const IN_FIVE_HOURS = Math.floor((NOW + 5 * 60 * 60_000) / 1000);

test('a Codex access token about to expire is refreshed, whole document and all', async () => {
  store.put('openai', 'oauth', authJson(IN_TEN_MINUTES, '2026-09-12T11:00:00Z'), {
    account: 'someone@example.com',
    expires_at: (IN_TEN_MINUTES) * 1000,
  });
  const fresh = jwt({ exp: IN_FIVE_HOURS });
  const { calls, post } = posts({ access_token: fresh, refresh_token: 'rotated' });

  await refreshCredentials(store, post, NOW);

  // The call the Codex CLI makes. It is not a documented API, so a change
  // shows up here.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CODEX_TOKEN_URL);
  assert.deepEqual(calls[0]?.body, {
    client_id: CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: 'the-refresh-token',
  });

  const row = store.get('openai');
  const stored = JSON.parse(row?.secret ?? '{}') as {
    tokens: Record<string, string>;
    last_refresh: string;
    OPENAI_API_KEY: string | null;
  };
  // The whole document is kept: the rotated refresh token is what the next
  // refresh needs, and last_refresh is what the eight-day rule reads.
  assert.equal(stored.tokens['access_token'], fresh);
  assert.equal(stored.tokens['refresh_token'], 'rotated');
  assert.equal(stored.tokens['account_id'], 'acct_123');
  assert.equal(stored.last_refresh, new Date(NOW).toISOString());
  assert.equal(row?.expires_at, IN_FIVE_HOURS * 1000);
  assert.equal(row?.refreshed_at, NOW);
  assert.equal(row?.account, 'someone@example.com');
  assert.equal(row?.status, 'ok');
});

test('a healthy token is left alone until it is either old or nearly out', async () => {
  store.put('openai', 'oauth', authJson(IN_FIVE_HOURS, new Date(NOW - 60_000).toISOString()));
  const { calls, post } = posts({ access_token: 'unused' });

  await refreshCredentials(store, post, NOW);
  assert.deepEqual(calls, []);

  // Eight days without a refresh also triggers one, because the refresh
  // token goes stale.
  const nineDays = NOW + 9 * 24 * 60 * 60_000;
  await refreshCredentials(store, post, nineDays);
  assert.equal(calls.length, 1);
});

test('a refresh that fails says why and keeps the credential', async () => {
  const document = authJson(IN_TEN_MINUTES, '2026-09-12T11:00:00Z');
  store.put('openai', 'oauth', document);
  const { post } = posts(new Error('400 from the token endpoint: invalid_grant'));

  await refreshCredentials(store, post, NOW);

  const row = store.get('openai');
  assert.equal(row?.status, 'failing');
  assert.match(row?.last_error ?? '', /invalid_grant/);
  // Still the document the next attempt refreshes from.
  assert.equal(row?.secret, document);
});

test('a Claude token cannot be refreshed, so at expiry it is marked expired', async () => {
  store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234', { expires_at: NOW - 1000 });
  store.put('github', 'token', 'ghp_therealgithubtoken');
  const { calls, post } = posts({ access_token: 'unused' });

  await refreshCredentials(store, post, NOW);

  // Nothing to POST for either: one has no refresh token, the other no expiry.
  assert.deepEqual(calls, []);
  assert.equal(store.get('claude')?.status, 'expired');
  assert.match(store.get('claude')?.last_error ?? '', /log in again/);
  assert.equal(store.get('claude')?.secret, 'sk-ant-oat01-abcdefgh1234');
  assert.equal(store.get('github')?.status, 'ok');
});

test('a stored login with no refresh token says so once rather than every minute', async () => {
  store.put('openai', 'oauth', JSON.stringify({ tokens: { access_token: jwt({ exp: 1 }) } }));
  const { calls, post } = posts({ access_token: 'unused' });

  await refreshCredentials(store, post, NOW);
  assert.deepEqual(calls, []);
  assert.equal(store.get('openai')?.status, 'failing');

  const before = store.get('openai')?.updated_at;
  await refreshCredentials(store, post, NOW + 60_000);
  assert.equal(store.get('openai')?.updated_at, before);
});

test('an account credential is stored and refreshed, and is not delivered to a box', () => {
  const oauth = store.put('openai', 'oauth', authJson(IN_FIVE_HOURS, '2026-09-12T11:00:00Z'));
  // The proxy swaps a header value. This row is a document for traffic that
  // the proxy does not intercept.
  assert.equal(deliverableSecret(oauth), null);
  assert.match(undeliverableReason(oauth) ?? '', /cannot hand a subscription login to a box/);

  const pasted = store.put('claude', 'token', 'sk-ant-oat01-abcdefgh1234');
  assert.equal(deliverableSecret(pasted), 'sk-ant-oat01-abcdefgh1234');
  assert.equal(undeliverableReason(pasted), null);
});

/** A Dev Tunnels login document, as the device login stores it. */
function devTunnelsJson(access: string, refresh = 'ghr_the-refresh-token'): string {
  return JSON.stringify({ access_token: access, refresh_token: refresh });
}

test('a Dev Tunnels login delivers its access token, not the document', () => {
  const row = store.put('devtunnels', 'oauth', devTunnelsJson('ghu_theaccesstoken'));
  assert.equal(deliverableSecret(row), 'ghu_theaccesstoken');
  assert.equal(undeliverableReason(row), null);

  const broken = store.put('devtunnels', 'oauth', 'not json');
  assert.equal(deliverableSecret(broken), null);
});

test('a Dev Tunnels token in its last hour is refreshed against GitHub', async () => {
  store.put('devtunnels', 'oauth', devTunnelsJson('ghu_old'), {
    account: 'octocat',
    expires_at: NOW + 10 * 60_000,
  });
  const { calls, post } = posts({
    access_token: 'ghu_new',
    refresh_token: 'ghr_rotated',
    expires_in: 28_800,
  });

  await refreshCredentials(store, post, NOW);

  // The call the devtunnel CLI makes, with no client secret.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, GITHUB_TOKEN_URL);
  assert.deepEqual(calls[0]?.body, {
    client_id: DEVTUNNELS_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: 'ghr_the-refresh-token',
  });
  const row = store.get('devtunnels');
  assert.deepEqual(JSON.parse(row?.secret ?? '{}'), {
    access_token: 'ghu_new',
    refresh_token: 'ghr_rotated',
  });
  assert.equal(row?.expires_at, NOW + 28_800_000);
  assert.equal(row?.refreshed_at, NOW);
  assert.equal(row?.account, 'octocat');
  assert.equal(row?.status, 'ok');
});

test('a Dev Tunnels token with hours left is not refreshed', async () => {
  store.put('devtunnels', 'oauth', devTunnelsJson('ghu_current'), {
    expires_at: NOW + 5 * 60 * 60_000,
  });
  const { calls, post } = posts({ access_token: 'unused' });

  await refreshCredentials(store, post, NOW);
  assert.deepEqual(calls, []);
});

test('GitHub refusing a Dev Tunnels refresh with a 200 marks the login failing', async () => {
  const document = devTunnelsJson('ghu_old');
  store.put('devtunnels', 'oauth', document, { expires_at: NOW + 10 * 60_000 });
  // GitHub reports an OAuth error in the body of a successful response.
  const { post } = posts({
    error: 'bad_refresh_token',
    error_description: 'The refresh token passed is incorrect or expired.',
  });

  await refreshCredentials(store, post, NOW);

  const row = store.get('devtunnels');
  assert.equal(row?.status, 'failing');
  assert.match(row?.last_error ?? '', /incorrect or expired/);
  assert.equal(row?.secret, document);
});
