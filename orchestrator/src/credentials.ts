/** The credential store, and the refresh that keeps its secrets valid. */

import { randomBytes } from 'node:crypto';
import type {
  CredentialId,
  CredentialMethod,
  CredentialStatus,
  CredentialSummary,
} from '../../shared/types.ts';
import type { Db } from './db.ts';

/** The three credential types, exported again from the shared API types. */
export type { CredentialId, CredentialMethod, CredentialStatus };

/** Every credential id, in the order the settings page lists them. */
export const CREDENTIAL_IDS: readonly CredentialId[] = [
  'claude',
  'openai',
  'github',
  'gitlab',
  'devtunnels',
];

/** Every method to get a secret. */
export const CREDENTIAL_METHODS: readonly CredentialMethod[] = ['token', 'api_key', 'oauth'];

/**
 * Checks if a string is the id of a credential that this deployment knows.
 *
 * @param id The string to check.
 * @returns True for a credential id.
 */
export function isCredentialId(id: string): id is CredentialId {
  return (CREDENTIAL_IDS as readonly string[]).includes(id);
}

/**
 * Checks if a string is a credential method.
 *
 * @param method The string to check.
 * @returns True for a credential method.
 */
export function isCredentialMethod(method: string): method is CredentialMethod {
  return (CREDENTIAL_METHODS as readonly string[]).includes(method);
}

/** One row of the credentials table. */
export interface CredentialRow {
  /** The id of the credential. */
  id: CredentialId;
  /** The method that got the secret. */
  method: CredentialMethod;
  /**
   * The secret, stored unencrypted, because the orchestrator gives it to the
   * proxy at each boot. A pasted secret is a token or an API key. An `oauth`
   * secret is a JSON document, so a refresh has the refresh token next to the
   * access token. For Codex, it is the whole document that the CLI wrote. For
   * Dev Tunnels, it holds `access_token` and `refresh_token`.
   */
  secret: string;
  /**
   * The text for the settings page. It is an account name, or the last four
   * characters of a pasted secret.
   */
  account: string | null;
  /** The expiry in epoch milliseconds, or null for a secret that does not expire. */
  expires_at: number | null;
  /** The last refresh in epoch milliseconds, or null until the first refresh. */
  refreshed_at: number | null;
  /** The result of the last use or refresh of the credential. */
  status: CredentialStatus;
  /** The reason of the last failure, for the settings page, or null. */
  last_error: string | null;
  /**
   * The value that a box holds in place of the secret. It has the format of a
   * real token of the service, but it is worth nothing alone. The store makes
   * it at the first store and keeps it while the row exists, so a box created
   * with it continues to work after each refresh.
   */
  placeholder: string;
  /** Epoch milliseconds of the first store. */
  created_at: number;
  /** Epoch milliseconds of the last write. */
  updated_at: number;
}

/** The number of characters at the end of a pasted secret that the settings page shows. */
const ACCOUNT_TAIL = 4;

/** The number of random bytes in a generated placeholder, after its prefix. */
const PLACEHOLDER_BYTES = 24;

/** The store of the credentials table. */
export class CredentialStore {
  /**
   * @param db The database that holds the credentials table.
   * @param onChange The function that the store calls after each write.
   * @param specs The credentials that this deployment translates.
   */
  constructor(
    /** The database that holds the credentials table. */
    private readonly db: Db,
    /**
     * The function that the store calls after each write, so the egress policy
     * changes at once and not at the next tick of the reconciler.
     */
    private readonly onChange: () => void,
    /**
     * The credentials that this deployment translates, for the prefix of a new
     * placeholder.
     */
    private readonly specs: readonly { id: string; placeholderPrefix: string }[],
  ) {}

  /**
   * Gives one stored credential.
   *
   * @param id The id of the credential.
   * @returns The row, or undefined when no secret is stored for the id.
   */
  get(id: CredentialId): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
      | CredentialRow
      | undefined;
  }

  /**
   * Lists every stored credential.
   *
   * @returns The rows, in the order of the settings page.
   */
  list(): CredentialRow[] {
    const rows = this.db.prepare('SELECT * FROM credentials').all() as CredentialRow[];
    return rows.sort((a, b) => CREDENTIAL_IDS.indexOf(a.id) - CREDENTIAL_IDS.indexOf(b.id));
  }

  /**
   * Stores a credential and replaces the old one. The placeholder stays.
   *
   * When `extra` names no account, the account is the last four characters of
   * the secret. When `extra` names no status and no error, the status goes
   * back to `ok`, and the last error is cleared.
   *
   * @param id The id of the credential.
   * @param method The method that got the secret.
   * @param secret The secret.
   * @param extra The other columns to write.
   * @returns The stored row.
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
      placeholder: existing?.placeholder ?? this.generatePlaceholder(id),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO credentials (id, method, secret, account, expires_at,
           refreshed_at, status, last_error, placeholder, created_at, updated_at)
         VALUES (@id, @method, @secret, @account, @expires_at,
           @refreshed_at, @status, @last_error, @placeholder, @created_at, @updated_at)
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

  /**
   * Gives the placeholder of a credential.
   *
   * With the empty string, the variable is not in the environment of the box,
   * so a box created now gets the credential when its container is created
   * again.
   *
   * @param id The id of the credential.
   * @returns The placeholder, or the empty string when no secret is stored.
   */
  placeholderFor(id: string): string {
    return isCredentialId(id) ? (this.get(id)?.placeholder ?? '') : '';
  }

  /**
   * Makes a new placeholder with the prefix of a real token of the service.
   *
   * @param id The id of the credential.
   * @returns The placeholder.
   */
  private generatePlaceholder(id: CredentialId): string {
    const prefix = this.specs.find((spec) => spec.id === id)?.placeholderPrefix ?? '';
    return `${prefix}${randomBytes(PLACEHOLDER_BYTES).toString('base64url')}`;
  }

  /**
   * Removes a credential. The proxy then stops the interception of its hosts.
   *
   * @param id The id of the credential.
   */
  remove(id: CredentialId): void {
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    this.onChange();
  }

  /**
   * Records the result of the last use or refresh of the credential. The
   * secret and the account stay, because the proxy still sends a failing token.
   *
   * @param id The id of the credential.
   * @param status The new status.
   * @param error The reason of the failure, or null.
   */
  markStatus(id: CredentialId, status: CredentialStatus, error: string | null): void {
    this.db
      .prepare('UPDATE credentials SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, Date.now(), id);
    this.onChange();
  }

  /**
   * Makes the form of a credential that the API reports, without the secret and the placeholder.
   *
   * @param row The stored row.
   * @returns The summary.
   */
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
 * Gives the secret that the egress proxy can put into a header for a box.
 *
 * A Codex `oauth` row is a document that Codex reads from
 * `$CODEX_HOME/auth.json`, and not a header value. Its traffic goes to
 * `chatgpt.com`, which the proxy does not intercept. The store keeps,
 * refreshes and reports such a row, but the row never reaches a box. A Dev
 * Tunnels `oauth` row gives the access token in its document. A row with
 * another method gives its secret as stored.
 *
 * @param row The stored row.
 * @returns The secret, or null when the row has none for a header.
 */
export function deliverableSecret(row: CredentialRow): string | null {
  if (row.method !== 'oauth') return row.secret;
  if (row.id !== 'devtunnels') return null;
  const token = authObject(row.secret)?.access_token;
  return typeof token === 'string' && token !== '' ? token : null;
}

/**
 * Gives the reason why a stored credential cannot reach a box. The dashboard
 * shows the text next to the harness, so a working login that cannot run does
 * not look broken.
 *
 * @param row The stored row.
 * @returns The reason, or null when the credential can reach a box.
 */
export function undeliverableReason(row: CredentialRow): string | null {
  if (deliverableSecret(row) !== null) return null;
  return (
    'stored and kept refreshed, but Boxes cannot hand a subscription login ' +
    'to a box yet \u2014 paste an API key to run this harness'
  );
}

/**
 * Gives the display text of a pasted secret, which is its last four characters.
 *
 * @param secret The secret.
 * @returns The last four characters, or null for a secret of four characters
 *   or fewer, so it is never shown whole.
 */
export function accountOf(secret: string): string | null {
  return secret.length > ACCOUNT_TAIL ? secret.slice(-ACCOUNT_TAIL) : null;
}

/** The parts of a Codex `auth.json` that the settings page and the refresh use. */
export interface AuthDocument {
  /** The account that the id token names, or null. */
  account: string | null;
  /** The expiry of the access token, in epoch milliseconds, or null. */
  expiresAt: number | null;
  /** The `last_refresh` value of the CLI, in epoch milliseconds, or null. */
  lastRefresh: number | null;
}

/**
 * Reads the description of a Codex `auth.json`.
 *
 * The function does not verify the token signatures, because the service that
 * receives the tokens does that. A payload that does not decode only loses the
 * expiry or the email.
 *
 * @param document The content of the `auth.json`.
 * @returns The description, or null when the document has no access token.
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

  const exp = jwtClaims(access)?.exp;
  const lastRefresh = Date.parse(String((parsed as { last_refresh?: unknown }).last_refresh ?? ''));
  return {
    account: typeof id === 'string' ? emailIn(jwtClaims(id)) : null,
    expiresAt: typeof exp === 'number' ? exp * 1000 : null,
    lastRefresh: Number.isNaN(lastRefresh) ? null : lastRefresh,
  };
}

/**
 * Decodes the payload of a JWT, without verification.
 *
 * @param token The JWT.
 * @returns The claims, or null when the token has no payload that decodes.
 */
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
 * Finds the email in the claims of an id token. It is the plain `email` claim,
 * or else the first `email` in a nested claim object, where OpenAI puts the profile.
 *
 * @param claims The claims, or null.
 * @returns The email, or null when the claims have none.
 */
function emailIn(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  const plain = claims.email;
  if (typeof plain === 'string' && plain !== '') return plain;
  for (const value of Object.values(claims)) {
    if (typeof value !== 'object' || value === null) continue;
    const email = (value as { email?: unknown }).email;
    if (typeof email === 'string' && email !== '') return email;
  }
  return null;
}

/**
 * The OAuth client id of Codex. It comes from the Codex CLI and is not a
 * stable API, so a Codex release can change it.
 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** The OAuth token endpoint of Codex. It is not a stable API, so a Codex release can change it. */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * The GitHub App that the Dev Tunnels service accepts user tokens from. It
 * comes from the devtunnel CLI and is not a stable API, so a CLI release can
 * change it.
 */
export const DEVTUNNELS_CLIENT_ID = 'Iv1.e7b89e013f801f03';

/** The OAuth token endpoint of GitHub, for the device login and the refresh. */
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** The time before expiry at which an access token is refreshed, in milliseconds. */
const REFRESH_WINDOW_MS = 60 * 60_000;

/** The maximum age of a login before a refresh without a near expiry, as Codex does it. */
const REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60_000;

/** The timeout for the answer of the token endpoint, in milliseconds. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * The answer of an OAuth endpoint. Each field is optional. GitHub reports a
 * failure with a 200 and the `error` fields.
 */
export interface TokenAnswer {
  /** The new access token. */
  access_token?: string;
  /** The rotated refresh token, when the endpoint rotates it. */
  refresh_token?: string;
  /** The new id token. */
  id_token?: string;
  /** The lifetime of the access token in seconds. The Codex refresh uses it only without `exp`. */
  expires_in?: number;
  /** The device code for the polls of a device login. */
  device_code?: string;
  /** The code that a person enters at `verification_uri`. */
  user_code?: string;
  /** The URL where a person enters `user_code`. */
  verification_uri?: string;
  /** The seconds between two polls of a device login. */
  interval?: number;
  /** An OAuth error code, for example `authorization_pending`. */
  error?: string;
  /** The error as a sentence. */
  error_description?: string;
}

/** Sends one POST to a token endpoint. Tests can pass a fake. */
export type TokenPost = (url: string, body: Record<string, string>) => Promise<TokenAnswer>;

/**
 * Sends the real POST, with a JSON body, as the Codex CLI does.
 *
 * @param url The token endpoint.
 * @param body The fields of the request.
 * @returns The parsed answer.
 * @throws {Error} When the endpoint answers with an error status or the request times out.
 */
export const postToken: TokenPost = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    // GitHub answers in a form encoding unless JSON is asked for.
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${res.status} from the token endpoint: ${text.trim().slice(0, 300)}`);
  return JSON.parse(text) as TokenAnswer;
};

/**
 * Refreshes or checks every stored credential once.
 *
 * A Codex or Dev Tunnels `oauth` row gets the refresh that its CLI would do.
 * The orchestrator holds the only copy, so nothing else rotates the token. A
 * row that is not `oauth` and has a past expiry, for example a Claude
 * `setup-token` token, is marked `expired`, because it cannot be renewed.
 *
 * A failed refresh marks the row `failing` with the reason and keeps it. The
 * next call retries.
 *
 * @param store The credential store.
 * @param post The function that sends a POST to a token endpoint.
 * @param now The current time in epoch milliseconds.
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
 * Checks if an `oauth` row needs a refresh, because its access token is close
 * to expiry, or its last refresh is REFRESH_MAX_AGE_MS old.
 *
 * @param row The stored row.
 * @param doc The description of its document, or null when it does not parse.
 * @param now The current time in epoch milliseconds.
 * @returns True when the row needs a refresh.
 */
export function refreshDue(row: CredentialRow, doc: AuthDocument | null, now: number): boolean {
  // An unreadable document gets a refresh, and the answer is written back in a
  // form that this function can read.
  if (doc === null) return true;
  if (doc.expiresAt !== null && doc.expiresAt - now <= REFRESH_WINDOW_MS) return true;
  const last = doc.lastRefresh ?? row.updated_at;
  return now - last >= REFRESH_MAX_AGE_MS;
}

/**
 * Refreshes one Codex subscription and writes the answer back into the document.
 *
 * The whole document is rewritten, because the refresh token rotates with the
 * access token, and refreshDue reads `last_refresh` next time.
 *
 * @param store The credential store.
 * @param row The stored row.
 * @param post The function that sends a POST to a token endpoint.
 * @param now The current time in epoch milliseconds.
 */
async function refreshCodex(
  store: CredentialStore,
  row: CredentialRow,
  post: TokenPost,
  now: number,
): Promise<void> {
  const parsed = parseAuthDocument(row.secret);
  const doc = authObject(row.secret);
  const refreshToken =
    doc && typeof doc.tokens === 'object' && doc.tokens !== null
      ? (doc.tokens as Record<string, unknown>).refresh_token
      : undefined;

  if (typeof refreshToken !== 'string' || refreshToken === '') {
    // A retry cannot fix this, so the status is written once.
    if (row.status !== 'failing') {
      store.markStatus(
        row.id,
        'failing',
        'the stored login carries no refresh token: log in again',
      );
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

  const tokens = { ...(doc?.tokens as Record<string, unknown>) };
  tokens.access_token = answer.access_token;
  if (answer.refresh_token) tokens.refresh_token = answer.refresh_token;
  if (answer.id_token) tokens.id_token = answer.id_token;
  const updated = {
    ...doc,
    tokens,
    last_refresh: new Date(now).toISOString(),
  };

  const described = parseAuthDocument(JSON.stringify(updated));
  store.put(row.id, 'oauth', JSON.stringify(updated), {
    // The new id token names the account, if it came back.
    account: described?.account ?? row.account,
    expires_at: described?.expiresAt ?? (answer.expires_in ? now + answer.expires_in * 1000 : null),
    refreshed_at: now,
  });
}

/**
 * Refreshes one Dev Tunnels login at GitHub, which rotates the refresh token
 * with the access token.
 *
 * The refresh happens when the access token has less than an hour left, has
 * expired, or has no known expiry. A row without a known expiry gets a refresh
 * at each call, which is each minute in the refresh loop. GitHub needs no
 * client secret, because the login used the device flow.
 *
 * @param store The credential store.
 * @param row The stored row.
 * @param post The function that sends a POST to a token endpoint.
 * @param now The current time in epoch milliseconds.
 */
async function refreshDevTunnels(
  store: CredentialStore,
  row: CredentialRow,
  post: TokenPost,
  now: number,
): Promise<void> {
  const refreshToken = authObject(row.secret)?.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    // A retry cannot fix this, so the status is written once.
    if (row.status !== 'failing') {
      store.markStatus(
        row.id,
        'failing',
        'the stored login carries no refresh token: log in again',
      );
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
    store.markStatus(
      row.id,
      'failing',
      `could not refresh: ${reason}. Log in again if this persists`,
    );
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

/**
 * Parses a stored document as an object.
 *
 * @param document The stored secret.
 * @returns The object, or null when the document is not a JSON object.
 */
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
