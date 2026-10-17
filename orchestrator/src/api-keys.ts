import { randomInt } from 'node:crypto';
import type { ApiKeySummary } from '../../shared/types.ts';
import { reservedEnvNames } from './boxenv.ts';
import { accountOf } from './credentials.ts';
import type { Db } from './db.ts';
import { HttpError } from './http-error.ts';

/**
 * The API keys a user adds for services Boxes has no credential for.
 *
 * The environment variable a key is named by holds a placeholder for the key
 * in every box. The egress proxy swaps the placeholder for the key in any
 * header of a request to one of the key's hosts.
 */

/** One row of the api_keys table, with its hosts parsed. */
export interface ApiKeyRow {
  /** The environment variable that holds the placeholder in each box. */
  name: string;
  /** Hosts intercepted so the key can be swapped in, as allowlist patterns. */
  hosts: string[];
  /** The key, stored unencrypted for the same reason as a credential. */
  secret: string;
  /**
   * What the environment of a box holds in place of the key: the key's
   * prefix and random characters, as long as the key. Kept while the key
   * keeps its shape, so a box created with it keeps working.
   */
  placeholder: string;
  /** Epoch milliseconds of the first store. */
  created_at: number;
  /** Epoch milliseconds of the last write. */
  updated_at: number;
}

/** A shell-safe environment variable name. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An exact hostname, or one with a leading one-label wildcard. */
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The prefix of a key that a placeholder copies: leading segments of up to
 * eight lowercase letters or digits, each followed by a dash or an
 * underscore, like `sk-or-v1-`. The limit keeps the random part of a key out
 * of its placeholder.
 */
const PREFIX_PATTERN = /^(?:[a-z0-9]{1,8}[-_])*/;

/** The fewest random characters a placeholder has, however short the key. */
const MIN_RANDOM = 16;

/** The characters the random part of a placeholder is made of. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The raw row as SQLite returns it, with the hosts still JSON. */
type StoredRow = Omit<ApiKeyRow, 'hosts'> & { hosts: string };

/** Owns the api_keys table. */
export class ApiKeyStore {
  constructor(
    /** The database that holds the api_keys table. */
    private readonly db: Db,
    /** Called after every write, so the egress policy is pushed at once. */
    private readonly onChange: () => void,
  ) {}

  /** One key, or undefined when none has this name. */
  get(name: string): ApiKeyRow | undefined {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE name = ?').get(name) as
      | StoredRow
      | undefined;
    return row ? parse(row) : undefined;
  }

  /** Every key, by name. */
  list(): ApiKeyRow[] {
    const rows = this.db.prepare('SELECT * FROM api_keys ORDER BY name').all() as StoredRow[];
    return rows.map(parse);
  }

  /**
   * Stores a key under a variable name, replacing the one stored there.
   *
   * Without a secret, the stored key stays and only its hosts change. A new
   * key gets a new placeholder when its prefix or its length differs from
   * the old one, so the placeholder keeps the shape of the key.
   */
  put(name: string, hosts: readonly string[], secret: string | undefined): ApiKeyRow {
    if (!NAME_PATTERN.test(name)) {
      throw new HttpError(400, `${name} is not a valid environment variable name`);
    }
    if (reservedEnvNames().has(name)) {
      throw new HttpError(400, `${name} is set by Boxes itself`);
    }
    const patterns = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].filter((h) => h);
    if (patterns.length === 0) throw new HttpError(400, 'hosts: name at least one host');
    for (const pattern of patterns) {
      if (!HOST_PATTERN.test(pattern)) {
        throw new HttpError(400, `hosts: ${pattern} is not a hostname or a *. wildcard`);
      }
    }

    const existing = this.get(name);
    const key = secret ?? existing?.secret;
    if (!key) throw new HttpError(400, 'secret: must not be empty');
    const keepPlaceholder = existing !== undefined && sameShape(existing.secret, key);

    const now = Date.now();
    const row: ApiKeyRow = {
      name,
      hosts: patterns,
      secret: key,
      placeholder: keepPlaceholder ? existing.placeholder : placeholderFor(key),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (name, hosts, secret, placeholder, created_at, updated_at)
         VALUES (@name, @hosts, @secret, @placeholder, @created_at, @updated_at)
         ON CONFLICT(name) DO UPDATE SET
           hosts = excluded.hosts, secret = excluded.secret,
           placeholder = excluded.placeholder, updated_at = excluded.updated_at`,
      )
      .run({ ...row, hosts: JSON.stringify(row.hosts) });
    this.onChange();
    return row;
  }

  /** Forgets a key. Throws a 404 when none has this name. */
  remove(name: string): void {
    const info = this.db.prepare('DELETE FROM api_keys WHERE name = ?').run(name);
    if (info.changes === 0) throw new HttpError(404, `No API key named ${name}`);
    this.onChange();
  }

  /** A row as the API reports it: everything but the secret and the placeholder. */
  summarize(row: ApiKeyRow): ApiKeySummary {
    return {
      name: row.name,
      hosts: row.hosts,
      account: accountOf(row.secret),
      updatedAt: row.updated_at,
    };
  }
}

/** A stored row with its hosts parsed. */
function parse(row: StoredRow): ApiKeyRow {
  return { ...row, hosts: JSON.parse(row.hosts) as string[] };
}

/** The prefix a placeholder for this key starts with. */
function prefixOf(secret: string): string {
  return PREFIX_PATTERN.exec(secret)?.[0] ?? '';
}

/** Whether two keys have the same prefix and the same length. */
function sameShape(a: string, b: string): boolean {
  return a.length === b.length && prefixOf(a) === prefixOf(b);
}

/**
 * A new placeholder for a key: its prefix, then random characters up to the
 * length of the key, or more for a key with too few characters after its
 * prefix.
 */
export function placeholderFor(secret: string): string {
  const prefix = prefixOf(secret);
  const length = Math.max(secret.length - prefix.length, MIN_RANDOM);
  let random = '';
  for (let i = 0; i < length; i++) random += ALPHABET[randomInt(ALPHABET.length)];
  return prefix + random;
}
