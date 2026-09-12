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
 * What a pasted secret is shown as: its last four characters.
 *
 * Enough to tell two tokens apart when one is being replaced, and not enough
 * to be worth anything on its own. A secret too short to have four characters
 * to spare is shown as nothing rather than as most of itself.
 */
function accountOf(secret: string): string | null {
  return secret.length > ACCOUNT_TAIL ? secret.slice(-ACCOUNT_TAIL) : null;
}
