import type {
  CredentialId,
  CredentialMethod,
  CredentialStatus,
  CredentialSummary,
} from '../../shared/types.ts';
import type { Db } from './db.ts';

/**
 * The credential store: the deployment's secrets, owned by the orchestrator
 * and managed from the settings page rather than from the environment.
 *
 * A credential is a row rather than a string because more than the secret has
 * to be remembered. A login records when it expires and which account it
 * belongs to; a refresh records when it last happened; a request that failed
 * records why, so the settings page can say what is wrong instead of leaving
 * a turn to fail with a 401 nobody sees.
 *
 * Secrets are stored as-is, which puts them on the data volume and therefore
 * in any backup of it. That is a deliberate trade — the orchestrator has to
 * be able to hand a credential to the proxy on every boot, so there is nobody
 * to ask for a passphrase — and it is why the reverse proxy in front of the
 * dashboard is a requirement rather than a suggestion.
 */

/**
 * The three credential types, re-exported from the shared API shapes.
 *
 * They are declared there because the settings page names them, and every
 * orchestrator module reads them from here, which is where the store is.
 */
export type { CredentialId, CredentialMethod, CredentialStatus };

/** Every credential id, in the order the settings page lists them. */
export const CREDENTIAL_IDS: readonly CredentialId[] = ['claude', 'openai', 'github'];

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
  id: CredentialId;
  method: CredentialMethod;
  /**
   * The material, as the harness needs it: a token or an API key for a pasted
   * secret, and the whole JSON document the CLI wrote for an `oauth` one, so
   * a refresh has the refresh token beside the access token.
   */
  secret: string;
  /** What the settings page shows: an account name, or a pasted secret's last four. */
  account: string | null;
  /** Epoch milliseconds, or null for a secret that does not expire. */
  expires_at: number | null;
  /** Epoch milliseconds, or null until something has refreshed it. */
  refreshed_at: number | null;
  status: CredentialStatus;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** How much of a pasted secret is shown, from the end. */
const ACCOUNT_TAIL = 4;

/**
 * Owns the credentials table.
 *
 * Every write calls `onChange`, which is how the egress policy is recomposed
 * and re-pushed the moment a credential is entered: a box holds a placeholder
 * for a credential that does not exist yet, and the push is what makes that
 * placeholder mean something. Waiting for the reconciler's minute tick would
 * leave a freshly pasted token failing for up to a minute with nothing to
 * explain it.
 */
export class CredentialStore {
  constructor(
    private readonly db: Db,
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
   * The account is derived from the secret unless the caller knows better: a
   * pasted secret is recognised by its last four characters, and a login
   * passes the account name the CLI reported instead. Storing a credential is
   * also a statement that it is expected to work, so the status goes back to
   * `ok` and the last error is cleared — a person pasting a new token has
   * answered whatever the old one's error said.
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
   *
   * The secret is left alone: a token that is failing is still the token the
   * proxy has to send, and the page needs the account to say which one it is
   * talking about.
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
 * The part of a credential a box can actually be given, or null when there is
 * none.
 *
 * Delivery to a box is one mechanism: the box holds a placeholder, and the
 * egress proxy swaps the real secret into a header on the way out. That works
 * for anything that *is* a header value — a pasted token, an API key — and it
 * does not work for a subscription obtained by logging in, for two reasons
 * read out of section 5.2 and Appendix A:
 *
 * - The material is not a string but a document: an access token, a refresh
 *   token and an id token, which Codex reads from `$CODEX_HOME/auth.json`
 *   rather than from any environment variable.
 * - The traffic it authenticates does not pass through the swap at all.
 *   ChatGPT inference goes to `chatgpt.com`, which is deliberately *not*
 *   intercepted — that is what lets a deployment's API key and a person's
 *   subscription coexist in one box, since the two endpoints reject each
 *   other's credentials.
 *
 * So an `oauth` row is stored, refreshed and reported, and is not delivered.
 * Making it reach a box means minting a short-lived `auth.json` into the box
 * instead of swapping a header, and that is not built. Until it is, the
 * harness whose only credential is an `oauth` one reports `runnable: false`
 * and says why.
 *
 * Everything else is the secret itself, whatever it was pasted as.
 */
export function deliverableSecret(row: CredentialRow): string | null {
  return row.method === 'oauth' ? null : row.secret;
}

/**
 * Why a stored credential still cannot reach a box, or null when it can.
 *
 * What the settings page and the health probe show beside a harness that has
 * a credential and is not runnable, so that "logged in, still greyed out"
 * reads as a missing piece of Boxes rather than as a broken login.
 */
export function undeliverableReason(row: CredentialRow): string | null {
  if (deliverableSecret(row) !== null) return null;
  return (
    'stored and kept refreshed, but Boxes cannot hand a subscription login ' +
    'to a box yet \u2014 paste an API key to run this harness'
  );
}

/**
 * What a pasted secret is shown as: its last four characters.
 *
 * Enough to tell two tokens apart when one is being replaced, and not enough
 * to be worth anything on its own. A secret too short to have four characters
 * to spare is shown as nothing rather than as most of itself.
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
 * Reads a Codex `auth.json` far enough to describe it, or null when it is not
 * one.
 *
 * Nothing is verified. The orchestrator is not the audience of either token
 * and holds none of the keys they are signed with — it is the holder, and the
 * service it sends them to is the verifier. So the claims are decoded for two
 * facts worth showing a person, an expiry and an email, and a token whose
 * payload will not decode costs those two facts and nothing else.
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
 * The email in a set of id-token claims, wherever the issuer put it.
 *
 * OpenAI's id token carries the profile under a namespaced claim as well as,
 * sometimes, a plain `email`. Both are read, because which one is present is
 * the issuer's business and neither is promised.
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
 * Codex's own OAuth client id and token endpoint.
 *
 * Neither is a stable API. Both are read out of the Codex CLI's source
 * (`codex-rs/login/src/auth/manager.rs`), which is also where the refresh
 * cadence below comes from, and a Codex release is free to move either. They
 * are written down here because the alternative — running the CLI again for
 * every refresh — costs a container a day per credential, and because a
 * refresh is one POST. If OpenAI moves them, this is the pair to re-read.
 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/** How close to expiry an access token is refreshed. */
const REFRESH_WINDOW_MS = 60 * 60_000;

/** How old a login is allowed to get before it is refreshed anyway. */
const REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60_000;

/** How long the token endpoint gets to answer. */
const REFRESH_TIMEOUT_MS = 15_000;

/** What the token endpoint answers with, of which everything is optional. */
export interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  /** Seconds, as OAuth writes it. Only used when the token carries no `exp`. */
  expires_in?: number;
}

/**
 * One POST to a token endpoint.
 *
 * A function rather than a call so the refresh can be tested without a network
 * and without OpenAI: the loop is the part with the rules in it, and the HTTP
 * is the part that cannot run here.
 */
export type TokenPost = (url: string, body: Record<string, string>) => Promise<TokenAnswer>;

/** The real POST, as the Codex CLI makes it. */
export const postToken: TokenPost = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from the token endpoint: ${text.trim().slice(0, 300)}`);
  return JSON.parse(text) as TokenAnswer;
};

/**
 * Keeps the stored credentials true, once a minute.
 *
 * Two jobs, and only one of them can do anything about what it finds. A Codex
 * `oauth` row is refreshed the way the CLI would have refreshed it — while the
 * orchestrator holds the only copy, so nothing else is rotating the token
 * under it, and a copy handed to a box is never refreshed there. Everything
 * else that expires can only be reported: a Claude `setup-token` token has no
 * refresh token at all, so at expiry the row is marked `expired` and the
 * settings page asks for another login.
 *
 * A failure marks the row `failing` with the reason rather than removing it.
 * A network that was down for a minute is the common case, and the next tick
 * is the retry; a refresh token that has been revoked keeps saying so until
 * somebody logs in again.
 */
export async function refreshCredentials(
  store: CredentialStore,
  post: TokenPost = postToken,
  now: number = Date.now(),
): Promise<void> {
  for (const row of store.list()) {
    if (row.method === 'oauth') {
      if (row.id === 'openai') await refreshCodex(store, row, post, now);
      continue;
    }
    // Nothing here can be renewed, so the only honest thing to do with an
    // expiry that has passed is to say so.
    if (row.expires_at !== null && row.expires_at <= now && row.status !== 'expired') {
      store.markStatus(row.id, 'expired', 'the credential has expired: log in again');
    }
  }
}

/** Whether an `oauth` row is due a refresh, and for which of the two reasons. */
export function refreshDue(row: CredentialRow, doc: AuthDocument | null, now: number): boolean {
  // A document this does not understand cannot say when it expires, and a
  // refresh is how that is found out: the answer is written back in a shape
  // this does understand, so it settles after one round rather than looping.
  if (doc === null) return true;
  if (doc.expiresAt !== null && doc.expiresAt - now <= REFRESH_WINDOW_MS) return true;
  // Codex refreshes a login that has simply sat for eight days, whatever its
  // access token says, and the refresh token is what goes stale otherwise.
  const last = doc.lastRefresh ?? row.updated_at;
  return now - last >= REFRESH_MAX_AGE_MS;
}

/**
 * Refreshes one Codex subscription, writing the answer back into the document.
 *
 * The whole document is rewritten rather than the access token alone, because
 * the document is what the credential *is*: the refresh token rotates with the
 * access token, and `last_refresh` is what the eight-day rule reads next time.
 * Writing through the store is also what pushes the new material to the proxy,
 * through the same `onChange` a pasted secret goes out on.
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
    // Nothing a retry can fix, so it is said once and then left alone.
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
    // The account rarely changes and the fresh id token is the better source
    // when there is one; the stored account is what is kept otherwise.
    account: described?.account ?? row.account,
    expires_at:
      described?.expiresAt ??
      (answer.expires_in ? now + answer.expires_in * 1000 : null),
    refreshed_at: now,
  });
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
