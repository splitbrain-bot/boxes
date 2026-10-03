import type {
  CredentialId,
  CredentialMethod,
  CredentialStatus,
  CredentialSummary,
} from '../../shared/types.ts';
import type { Db } from './db.ts';

/** The credential store, and the refresh that keeps its secrets valid. */

/** The three credential types, re-exported from the shared API shapes. */
export type { CredentialId, CredentialMethod, CredentialStatus };

/** Every credential id, in the order the settings page lists them. */
export const CREDENTIAL_IDS: readonly CredentialId[] = [
  'claude',
  'openai',
  'github',
  'gitlab',
  'devtunnels',
];

/** Every way a secret can be obtained. */
export const CREDENTIAL_METHODS: readonly CredentialMethod[] = ['token', 'api_key', 'oauth'];

/** Whether a string names a credential this deployment knows. */
export function isCredentialId(id: string): id is CredentialId {
  return (CREDENTIAL_IDS as readonly string[]).includes(id);
}

/** Whether a string names a way a secret can have been obtained. */
export function isCredentialMethod(method: string): method is CredentialMethod {
  return (CREDENTIAL_METHODS as readonly string[]).includes(method);
}

/** One row of the credentials table. */
export interface CredentialRow {
  /** Which credential this is. */
  id: CredentialId;
  /** How the secret was obtained. */
  method: CredentialMethod;
  /**
   * The material, stored unencrypted: a token or an API key for a pasted
   * secret, and a JSON document for an `oauth` one, so a refresh has the
   * refresh token beside the access token. For Codex it is the whole document
   * the CLI wrote; for Dev Tunnels it holds `access_token` and
   * `refresh_token`.
   */
  secret: string;
  /** What the settings page shows: an account name, or a pasted secret's last four. */
  account: string | null;
  /** Epoch milliseconds, or null for a secret that does not expire. */
  expires_at: number | null;
  /** Epoch milliseconds, or null until something has refreshed it. */
  refreshed_at: number | null;
  /** Whether the credential worked the last time it was used or refreshed. */
  status: CredentialStatus;
  /** Why it failed, for the settings page, or null. */
  last_error: string | null;
  /** Epoch milliseconds of the first store. */
  created_at: number;
  /** Epoch milliseconds of the last write. */
  updated_at: number;
}

/** How much of a pasted secret is shown, from the end. */
const ACCOUNT_TAIL = 4;

/** Owns the credentials table. */
export class CredentialStore {
  constructor(
    /** The database that holds the credentials table. */
    private readonly db: Db,
    /**
     * Called after every write, so the egress policy is pushed at once rather
     * than at the reconciler's next tick.
     */
    private readonly onChange: () => void,
  ) {}

  /** One credential, or undefined when the deployment holds none for it. */
  get(id: CredentialId): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
      | CredentialRow
      | undefined;
  }

  /** Every stored credential, in the order the settings page lists them. */
  list(): CredentialRow[] {
    const rows = this.db.prepare('SELECT * FROM credentials').all() as CredentialRow[];
    return rows.sort(
      (a, b) => CREDENTIAL_IDS.indexOf(a.id) - CREDENTIAL_IDS.indexOf(b.id),
    );
  }

  /**
   * Stores a credential, replacing whatever was there.
   *
   * Unless `extra` names an account, the account is the secret's last four
   * characters. Unless `extra` says otherwise, the status goes back to `ok`
   * and the last error is cleared.
   */
  put(
    id: CredentialId,
    method: CredentialMethod,
    secret: string,
    extra: Partial<CredentialRow> = {},
  ): CredentialRow {
    const now = Date.now();
    const existing = this.get(id);
    const row: CredentialRow = {
      id,
      method,
      secret,
      account: extra.account ?? accountOf(secret),
      expires_at: extra.expires_at ?? null,
      refreshed_at: extra.refreshed_at ?? null,
      status: extra.status ?? 'ok',
      last_error: extra.last_error ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO credentials (id, method, secret, account, expires_at,
           refreshed_at, status, last_error, created_at, updated_at)
         VALUES (@id, @method, @secret, @account, @expires_at,
           @refreshed_at, @status, @last_error, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           method = excluded.method, secret = excluded.secret,
           account = excluded.account, expires_at = excluded.expires_at,
           refreshed_at = excluded.refreshed_at, status = excluded.status,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(row);
    this.onChange();
    return row;
  }

  /** Forgets a credential. The hosts it travelled to stop being intercepted. */
  remove(id: CredentialId): void {
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    this.onChange();
  }

  /**
   * Records what happened the last time the credential was used or refreshed.
   * The secret and the account stay, as a failing token is still the one the
   * proxy sends.
   */
  markStatus(id: CredentialId, status: CredentialStatus, error: string | null): void {
    this.db
      .prepare('UPDATE credentials SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, Date.now(), id);
    this.onChange();
  }

  /** A row as the API reports it: everything but the secret. */
  summarize(row: CredentialRow): CredentialSummary {
    return {
      id: row.id,
      method: row.method,
      account: row.account,
      status: row.status,
      lastError: row.last_error,
      expiresAt: row.expires_at,
      refreshedAt: row.refreshed_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * The secret the egress proxy can swap into a header for a box, or null when
 * the row has none.
 *
 * A Codex `oauth` row is a document that Codex reads from
 * `$CODEX_HOME/auth.json`, not a header value. Its traffic goes to
 * `chatgpt.com`, which the proxy does not intercept. Such a row is stored,
 * refreshed and reported, but never reaches a box. A Dev Tunnels `oauth` row
 * delivers the access token inside its document. Every other row delivers its
 * secret as stored.
 */
export function deliverableSecret(row: CredentialRow): string | null {
  if (row.method !== 'oauth') return row.secret;
  if (row.id !== 'devtunnels') return null;
  const token = authObject(row.secret)?.['access_token'];
  return typeof token === 'string' && token !== '' ? token : null;
}

/**
 * Why a stored credential cannot reach a box, or null when it can. The text
 * is shown beside the harness, so a working login that cannot run does not
 * look broken.
 */
export function undeliverableReason(row: CredentialRow): string | null {
  if (deliverableSecret(row) !== null) return null;
  return (
    'stored and kept refreshed, but Boxes cannot hand a subscription login ' +
    'to a box yet \u2014 paste an API key to run this harness'
  );
}

/**
 * What a pasted secret is shown as: its last four characters. A secret of
 * four characters or fewer is shown as null, so it is never shown whole.
 */
function accountOf(secret: string): string | null {
  return secret.length > ACCOUNT_TAIL ? secret.slice(-ACCOUNT_TAIL) : null;
}

// --- what a Codex auth.json says --------------------------------------------

/** The parts of a Codex `auth.json` the settings page and the refresh use. */
export interface AuthDocument {
  /** The account the id token names, where it names one. */
  account: string | null;
  /** When the access token expires, in epoch milliseconds, or null. */
  expiresAt: number | null;
  /** The CLI's own `last_refresh`, in epoch milliseconds, or null. */
  lastRefresh: number | null;
}

/**
 * Reads a Codex `auth.json` far enough to describe it, or null when it has no
 * access token.
 *
 * The token signatures are not verified; the service that receives the tokens
 * does that. A payload that does not decode only loses the expiry or email.
 */
export function parseAuthDocument(document: string): AuthDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (typeof tokens !== 'object' || tokens === null) return null;
  const { access_token: access, id_token: id } = tokens as Record<string, unknown>;
  if (typeof access !== 'string' || access === '') return null;

  const exp = jwtClaims(access)?.['exp'];
  const lastRefresh = Date.parse(
    String((parsed as { last_refresh?: unknown }).last_refresh ?? ''),
  );
  return {
    account: typeof id === 'string' ? emailIn(jwtClaims(id)) : null,
    expiresAt: typeof exp === 'number' ? exp * 1000 : null,
    lastRefresh: Number.isNaN(lastRefresh) ? null : lastRefresh,
  };
}

/** A JWT's payload, decoded and not verified, or null when there is none. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The email in a set of id-token claims: the plain `email` claim, or else the
 * first `email` inside a nested claim object, where OpenAI puts the profile.
 */
function emailIn(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  const plain = claims['email'];
  if (typeof plain === 'string' && plain !== '') return plain;
  for (const value of Object.values(claims)) {
    if (typeof value !== 'object' || value === null) continue;
    const email = (value as { email?: unknown }).email;
    if (typeof email === 'string' && email !== '') return email;
  }
  return null;
}


// --- keeping an account credential alive ------------------------------------

/**
 * Codex's own OAuth client id. It is taken from the Codex CLI and is not a
 * stable API, so a Codex release may change it.
 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Codex's OAuth token endpoint. It is not a stable API either. */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * The GitHub App the Dev Tunnels service accepts user tokens from. It is
 * taken from the devtunnel CLI and is not a stable API, so a CLI release may
 * change it.
 */
export const DEVTUNNELS_CLIENT_ID = 'Iv1.e7b89e013f801f03';

/** GitHub's OAuth token endpoint, for the device login and the refresh. */
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** How close to expiry an access token is refreshed, in milliseconds. */
const REFRESH_WINDOW_MS = 60 * 60_000;

/** How old a login may get before it is refreshed anyway, as Codex does. */
const REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60_000;

/** How long the token endpoint gets to answer, in milliseconds. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * What an OAuth endpoint answers with. Every field is optional. GitHub
 * reports a failure with a 200 and the `error` fields.
 */
export interface TokenAnswer {
  /** The new access token. */
  access_token?: string;
  /** The rotated refresh token, when the endpoint rotates it. */
  refresh_token?: string;
  /** The new id token. */
  id_token?: string;
  /** Seconds, as OAuth writes it. Only used when the token carries no `exp`. */
  expires_in?: number;
  /** The device code a device login polls with. */
  device_code?: string;
  /** The code a person enters at `verification_uri`. */
  user_code?: string;
  /** Where a person enters `user_code`. */
  verification_uri?: string;
  /** Seconds a device login waits between two polls. */
  interval?: number;
  /** An OAuth error code, such as `authorization_pending`. */
  error?: string;
  /** The error in a sentence. */
  error_description?: string;
}

/** One POST to a token endpoint. A type, so tests can pass a fake. */
export type TokenPost = (url: string, body: Record<string, string>) => Promise<TokenAnswer>;

/** The real POST, as the Codex CLI makes it. */
export const postToken: TokenPost = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    // GitHub answers in a form encoding unless JSON is asked for.
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from the token endpoint: ${text.trim().slice(0, 300)}`);
  return JSON.parse(text) as TokenAnswer;
};

/**
 * Refreshes or checks every stored credential once.
 *
 * A Codex or Dev Tunnels `oauth` row is refreshed the way its CLI would
 * refresh it. The orchestrator holds the only copy, so nothing else rotates
 * the token. Any
 * other row with a past expiry, such as a Claude `setup-token` token, is
 * marked `expired`, as it cannot be renewed.
 *
 * A failed refresh marks the row `failing` with the reason and keeps it. The
 * next call retries.
 */
export async function refreshCredentials(
  store: CredentialStore,
  post: TokenPost = postToken,
  now: number = Date.now(),
): Promise<void> {
  for (const row of store.list()) {
    if (row.method === 'oauth') {
      if (row.id === 'openai') await refreshCodex(store, row, post, now);
      if (row.id === 'devtunnels') await refreshDevTunnels(store, row, post, now);
      continue;
    }
    if (row.expires_at !== null && row.expires_at <= now && row.status !== 'expired') {
      store.markStatus(row.id, 'expired', 'the credential has expired: log in again');
    }
  }
}

/**
 * Whether an `oauth` row is due a refresh: its access token is close to
 * expiry, or its last refresh is REFRESH_MAX_AGE_MS old.
 */
export function refreshDue(row: CredentialRow, doc: AuthDocument | null, now: number): boolean {
  // An unreadable document is refreshed, and the answer is written back in a
  // shape this can read.
  if (doc === null) return true;
  if (doc.expiresAt !== null && doc.expiresAt - now <= REFRESH_WINDOW_MS) return true;
  const last = doc.lastRefresh ?? row.updated_at;
  return now - last >= REFRESH_MAX_AGE_MS;
}

/**
 * Refreshes one Codex subscription, writing the answer back into the document.
 *
 * The whole document is rewritten, because the refresh token rotates with the
 * access token, and refreshDue reads `last_refresh` next time.
 */
async function refreshCodex(
  store: CredentialStore,
  row: CredentialRow,
  post: TokenPost,
  now: number,
): Promise<void> {
  const parsed = parseAuthDocument(row.secret);
  const doc = authObject(row.secret);
  const refreshToken = doc && typeof doc['tokens'] === 'object' && doc['tokens'] !== null
    ? (doc['tokens'] as Record<string, unknown>)['refresh_token']
    : undefined;

  if (typeof refreshToken !== 'string' || refreshToken === '') {
    // A retry cannot fix this, so the status is written once.
    if (row.status !== 'failing') {
      store.markStatus(row.id, 'failing', 'the stored login carries no refresh token: log in again');
    }
    return;
  }
  if (!refreshDue(row, parsed, now)) return;

  let answer: TokenAnswer;
  try {
    answer = await post(CODEX_TOKEN_URL, {
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } catch (err) {
    store.markStatus(row.id, 'failing', `could not refresh: ${(err as Error).message}`);
    return;
  }

  if (!answer.access_token) {
    store.markStatus(row.id, 'failing', 'the token endpoint answered without an access token');
    return;
  }

  const tokens = { ...(doc?.['tokens'] as Record<string, unknown>) };
  tokens['access_token'] = answer.access_token;
  if (answer.refresh_token) tokens['refresh_token'] = answer.refresh_token;
  if (answer.id_token) tokens['id_token'] = answer.id_token;
  const updated = {
    ...doc,
    tokens,
    last_refresh: new Date(now).toISOString(),
  };

  const described = parseAuthDocument(JSON.stringify(updated));
  store.put(row.id, 'oauth', JSON.stringify(updated), {
    // The new id token names the account, if it came back.
    account: described?.account ?? row.account,
    expires_at:
      described?.expiresAt ??
      (answer.expires_in ? now + answer.expires_in * 1000 : null),
    refreshed_at: now,
  });
}

/**
 * Refreshes one Dev Tunnels login against GitHub, which rotates the refresh
 * token with the access token.
 *
 * It refreshes once the access token has less than an hour left, or has
 * expired. GitHub needs no client secret for this app.
 */
async function refreshDevTunnels(
  store: CredentialStore,
  row: CredentialRow,
  post: TokenPost,
  now: number,
): Promise<void> {
  const refreshToken = authObject(row.secret)?.['refresh_token'];
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    // A retry cannot fix this, so the status is written once.
    if (row.status !== 'failing') {
      store.markStatus(row.id, 'failing', 'the stored login carries no refresh token: log in again');
    }
    return;
  }
  if (row.expires_at !== null && row.expires_at - now > REFRESH_WINDOW_MS) return;

  let answer: TokenAnswer;
  try {
    answer = await post(GITHUB_TOKEN_URL, {
      client_id: DEVTUNNELS_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } catch (err) {
    store.markStatus(row.id, 'failing', `could not refresh: ${(err as Error).message}`);
    return;
  }

  if (!answer.access_token) {
    const reason = answer.error_description ?? answer.error ?? 'no access token in the answer';
    store.markStatus(row.id, 'failing', `could not refresh: ${reason}. Log in again if this persists`);
    return;
  }

  store.put(
    row.id,
    'oauth',
    JSON.stringify({
      access_token: answer.access_token,
      refresh_token: answer.refresh_token ?? refreshToken,
    }),
    {
      account: row.account,
      expires_at: answer.expires_in ? now + answer.expires_in * 1000 : null,
      refreshed_at: now,
    },
  );
}

/** The stored document as an object, or null when it is not one. */
function authObject(document: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(document);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
