/**
 * The egress profiles of the users. A profile sets the mode and the hosts that
 * decide which hosts a box can reach through the egress proxy. Each box uses
 * one profile.
 */

import { randomBytes } from 'node:crypto';
import { hostPatternProblem } from '../../shared/hosts.ts';
import type { EgressProfileDetail, EgressProfileSummary } from '../../shared/types.ts';
import type { Db, EgressProfileRow } from './db.ts';
import { HttpError } from './http-error.ts';

/** The maximum length of the display name of a profile. */
const MAX_PROFILE_NAME = 100;

/** The maximum number of host patterns in one profile. */
export const MAX_PROFILE_HOSTS = 200;

/** The display name of the default profile of a user. */
const DEFAULT_PROFILE_NAME = 'Default';

/** The fields of a profile that a create or an update can set. */
export interface EgressProfileInput {
  /** The display name. */
  name?: unknown;
  /** True for the open mode, false for the closed mode. */
  open?: unknown;
  /** The host patterns. */
  hosts?: unknown;
}

/**
 * The store of egress profiles.
 *
 * Each profile belongs to one user. Each user has one default profile, which
 * a box without a selected profile uses.
 */
export class EgressProfileStore {
  /**
   * @param db The database that stores the profiles.
   * @param onChange The function that the store calls after each write that can change the egress policy.
   */
  constructor(
    /** Where the profiles are stored. */
    private readonly db: Db,
    /** Called after each write that can change the egress policy. */
    private readonly onChange: () => void = () => {},
  ) {}

  /**
   * Lists the profiles of a user.
   *
   * @param owner The user.
   * @returns The summaries of the profiles, the default profile first and the rest by name.
   */
  list(owner: string): EgressProfileSummary[] {
    this.defaultId(owner);
    const rows = this.db
      .prepare(
        `SELECT * FROM egress_profiles WHERE owner = ?
         ORDER BY is_default DESC, name COLLATE NOCASE ASC`,
      )
      .all(owner) as EgressProfileRow[];
    return rows.map((row) => this.summarize(row));
  }

  /**
   * Gives the id of the default profile of a user, and makes the profile when
   * the user has none. The new profile is open and has no hosts, so the egress
   * policy stays the same.
   *
   * @param owner The user.
   * @returns The id of the default profile.
   */
  defaultId(owner: string): string {
    const row = this.db
      .prepare('SELECT id FROM egress_profiles WHERE owner = ? AND is_default = 1')
      .get(owner) as { id: string } | undefined;
    if (row) return row.id;
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO egress_profiles (id, owner, is_default, name, open, hosts, created_at, updated_at)
         VALUES (?, ?, 1, ?, 1, '[]', ?, ?)`,
      )
      .run(id, owner, DEFAULT_PROFILE_NAME, now, now);
    return id;
  }

  /**
   * Gives one profile of a user with its hosts.
   *
   * @param owner The user.
   * @param id The id of the profile.
   * @returns The profile.
   * @throws {HttpError} A 404 when the user has no profile with this id.
   */
  get(owner: string, id: string): EgressProfileDetail {
    const row = this.mustGet(owner, id);
    return { ...this.summarize(row), hosts: parseHosts(row) };
  }

  /**
   * Checks if a user has a profile.
   *
   * @param owner The user.
   * @param id The id of the profile.
   * @returns True when the profile exists and belongs to the user.
   */
  has(owner: string, id: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM egress_profiles WHERE id = ? AND owner = ?').get(id, owner) !==
      undefined
    );
  }

  /**
   * Gives the profile that a box uses.
   *
   * @param owner The owner of the box.
   * @param id The selected profile of the box, or null for the default profile.
   * @returns The profile, with its hosts.
   */
  forBox(
    owner: string,
    id: string | null,
  ): Pick<EgressProfileDetail, 'id' | 'name' | 'open' | 'hosts'> {
    const selected =
      id === null
        ? undefined
        : (this.db
            .prepare('SELECT * FROM egress_profiles WHERE id = ? AND owner = ?')
            .get(id, owner) as EgressProfileRow | undefined);
    const row = selected ?? this.mustGet(owner, this.defaultId(owner));
    return { id: row.id, name: row.name, open: row.open === 1, hosts: parseHosts(row) };
  }

  /**
   * Adds a profile for a user. The orchestrator makes the id.
   *
   * @param owner The user.
   * @param input The name, and optionally the mode and the hosts. The mode is closed and the hosts are empty
   *   when absent.
   * @returns The new profile.
   * @throws {HttpError} A 400 when a field is not valid.
   */
  create(owner: string, input: EgressProfileInput): EgressProfileDetail {
    this.defaultId(owner);
    const name = validName(input.name);
    const open = input.open === undefined ? false : validOpen(input.open);
    const hosts = input.hosts === undefined ? [] : validHosts(input.hosts);
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO egress_profiles (id, owner, is_default, name, open, hosts, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(id, owner, name, open ? 1 : 0, JSON.stringify(hosts), now, now);
    this.onChange();
    return this.get(owner, id);
  }

  /**
   * Changes the name, the mode or the hosts of a profile. A field that is absent stays the same.
   *
   * @param owner The user.
   * @param id The id of the profile.
   * @param input The fields to change.
   * @returns The changed profile.
   * @throws {HttpError} A 404 when the user has no such profile, or a 400 when a field is not valid.
   */
  update(owner: string, id: string, input: EgressProfileInput): EgressProfileDetail {
    const row = this.mustGet(owner, id);
    const name = input.name === undefined ? row.name : validName(input.name);
    const open = input.open === undefined ? row.open === 1 : validOpen(input.open);
    const hosts = input.hosts === undefined ? parseHosts(row) : validHosts(input.hosts);
    this.db
      .prepare(
        'UPDATE egress_profiles SET name = ?, open = ?, hosts = ?, updated_at = ? WHERE id = ?',
      )
      .run(name, open ? 1 : 0, JSON.stringify(hosts), Date.now(), id);
    this.onChange();
    return this.get(owner, id);
  }

  /**
   * Removes a profile. The default profile cannot be removed. The database
   * clears the profile from each box that uses it, so these boxes use the
   * default profile.
   *
   * @param owner The user.
   * @param id The id of the profile.
   * @throws {HttpError} A 404 when the user has no such profile, or a 400 for the default profile.
   */
  delete(owner: string, id: string): void {
    const row = this.mustGet(owner, id);
    if (row.is_default === 1) {
      throw new HttpError(400, 'The default profile cannot be deleted');
    }
    this.db.prepare('DELETE FROM egress_profiles WHERE id = ?').run(id);
    this.onChange();
  }

  /**
   * Gives the stored row of a profile of a user.
   *
   * @param owner The user.
   * @param id The id of the profile.
   * @returns The row.
   * @throws {HttpError} A 404 when the user has no profile with this id.
   */
  private mustGet(owner: string, id: string): EgressProfileRow {
    const row = this.db
      .prepare('SELECT * FROM egress_profiles WHERE id = ? AND owner = ?')
      .get(id, owner) as EgressProfileRow | undefined;
    if (!row) throw new HttpError(404, 'Egress profile not found');
    return row;
  }

  /**
   * Makes the summary of a profile, without the hosts.
   *
   * @param row The stored row of the profile.
   * @returns The summary. The box count of the default profile includes the boxes without a selected profile.
   */
  private summarize(row: EgressProfileRow): EgressProfileSummary {
    const used = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM boxes WHERE status != 'deleted'
           AND (egress_profile_id = ? OR (? = 1 AND egress_profile_id IS NULL AND owner = ?))`,
      )
      .get(row.id, row.is_default, row.owner) as { n: number };
    return {
      id: row.id,
      name: row.name,
      isDefault: row.is_default === 1,
      open: row.open === 1,
      boxCount: used.n,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * Makes a new profile id.
 *
 * @returns The id, as ep and ten hex digits.
 */
function newId(): string {
  return `ep${randomBytes(5).toString('hex')}`;
}

/**
 * Parses the hosts of a stored row.
 *
 * @param row The stored row.
 * @returns The host patterns.
 */
function parseHosts(row: EgressProfileRow): string[] {
  return JSON.parse(row.hosts) as string[];
}

/**
 * Checks a profile name after trim.
 *
 * @param value The name from the request.
 * @returns The trimmed name.
 * @throws {HttpError} A 400 when the name is empty or longer than {@link MAX_PROFILE_NAME}.
 */
function validName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') throw new HttpError(400, 'name is required');
  if (name.length > MAX_PROFILE_NAME) {
    throw new HttpError(400, `name must be ${MAX_PROFILE_NAME} characters or fewer`);
  }
  return name;
}

/**
 * Checks the mode of a profile.
 *
 * @param value The mode from the request.
 * @returns The mode.
 * @throws {HttpError} A 400 when the mode is not a boolean.
 */
function validOpen(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, 'open must be true or false');
  return value;
}

/**
 * Checks the host patterns of a profile. Each pattern is trimmed and in
 * lower case. Empty patterns and duplicates are dropped.
 *
 * @param value The host patterns from the request.
 * @returns The patterns.
 * @throws {HttpError} A 400 when the value is not a list of strings, when a pattern is not valid, or when the list
 *   has more than {@link MAX_PROFILE_HOSTS} patterns.
 */
function validHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((h) => typeof h !== 'string')) {
    throw new HttpError(400, 'hosts must be a list of host patterns');
  }
  const hosts = [...new Set((value as string[]).map((h) => h.trim().toLowerCase()))].filter(
    (h) => h !== '',
  );
  if (hosts.length > MAX_PROFILE_HOSTS) {
    throw new HttpError(400, `A profile holds at most ${MAX_PROFILE_HOSTS} hosts`);
  }
  for (const host of hosts) {
    const problem = hostPatternProblem(host);
    if (problem !== null) throw new HttpError(400, `hosts: ${problem}`);
  }
  return hosts;
}
