import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import {
  GLOBAL_AGENT_SET,
  type AgentBundlePreview,
  type AgentItem,
  type AgentItemBody,
  type AgentSetDetail,
  type AgentSetSummary,
} from '../../shared/types.ts';
import type { AgentItemRow, AgentSetRow, Db } from './db.ts';
import { HARNESSES } from './harness.ts';
import { HttpError } from './http-error.ts';
import { chownToAgent } from './workspaces.ts';

/**
 * Agent sets: the AGENTS.md and skills a box's agent is
 * configured with. The database holds them, and the files a box gets are
 * derived from it.
 */

/** Where the merged sets are materialized, under DATA_DIR. */
const AGENTS_SUBDIR = 'agents';

/**
 * A name that is safe as a single path component and is what the agent will
 * call the skill: its directory, and the word after the slash.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Longest a set's display name may be. */
const MAX_SET_NAME = 100;

/** Longest an AGENTS.md or one skill's content may be. */
const MAX_CONTENT = 100_000;

/** Most skills a single set may hold. */
const MAX_ITEMS = 100;

/** The parent of every materialized set. */
function agentsRoot(dataDir: string): string {
  return join(dataDir, AGENTS_SUBDIR);
}

/** Where a box's merged configuration is written, as this process sees it. */
export function agentConfigPath(dataDir: string, boxId: string): string {
  return join(agentsRoot(dataDir), boxId);
}

/**
 * The same directory as the Docker daemon sees it, which is the path a bind
 * source names.
 */
export function hostAgentConfigPath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, AGENTS_SUBDIR, boxId);
}

/** Creates the parent of every materialized set, mode 0700. */
export function ensureAgentsRoot(dataDir: string): void {
  mkdirSync(agentsRoot(dataDir), { recursive: true, mode: 0o700 });
}

/**
 * Sets, their items, and the merged bundle a box is given.
 *
 * Every mutation returns the whole set, so a client needs one round trip per
 * screen rather than one per field.
 */
export class AgentStore {
  constructor(
    /** Where the sets are stored. */
    private readonly db: Db,
    /** The DATA_DIR the merged sets are written under. */
    private readonly dataDir: string,
  ) {}

  // --- reading --------------------------------------------------------------

  /** Every set, the global one first and the rest by name. */
  listSets(): AgentSetSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_sets ORDER BY (id = ?) DESC, name COLLATE NOCASE ASC')
      .all(GLOBAL_AGENT_SET) as AgentSetRow[];
    return rows.map((row) => this.summarize(row));
  }

  /** One set with everything in it, or a 404. */
  getSet(id: string): AgentSetDetail {
    const row = this.mustGet(id);
    return {
      ...this.summarize(row),
      agentsMd: row.agents_md,
      items: this.items(id),
    };
  }

  /** The stored row for a set, or a 404. */
  private mustGet(id: string): AgentSetRow {
    const row = this.db.prepare('SELECT * FROM agent_sets WHERE id = ?').get(id) as
      | AgentSetRow
      | undefined;
    if (!row) throw new HttpError(404, 'Agent set not found');
    return row;
  }

  /** A set's skills, by name. */
  private items(setId: string): AgentItem[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_items WHERE set_id = ? ORDER BY name COLLATE NOCASE ASC')
      .all(setId) as AgentItemRow[];
    return rows.map((row) => ({
      name: row.name,
      content: row.content,
      updatedAt: row.updated_at,
    }));
  }

  /** Counts and flags, without loading any content. */
  private summarize(row: AgentSetRow): AgentSetSummary {
    const counts = this.db
      .prepare('SELECT COUNT(*) AS skills FROM agent_items WHERE set_id = ?')
      .get(row.id) as { skills: number };
    const used = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM boxes WHERE agent_set_id = ? AND status != 'deleted'",
      )
      .get(row.id) as { n: number };
    return {
      id: row.id,
      name: row.name,
      global: row.id === GLOBAL_AGENT_SET,
      hasAgentsMd: row.agents_md.trim() !== '',
      skillCount: counts.skills,
      boxCount: used.n,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Whether a set exists, without loading it. */
  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM agent_sets WHERE id = ?').get(id) !== undefined;
  }

  /** A set's display name, or null when it is gone. */
  nameOf(id: string | null): string | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT name FROM agent_sets WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    return row?.name ?? null;
  }

  // --- writing --------------------------------------------------------------

  /** Adds a set. Its id is server-generated: user input never names a path. */
  createSet(name: string): AgentSetDetail {
    const clean = validSetName(name);
    const now = Date.now();
    const id = `as${randomBytes(5).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO agent_sets (id, name, agents_md, created_at, updated_at)
         VALUES (?, ?, '', ?, ?)`,
      )
      .run(id, clean, now, now);
    return this.getSet(id);
  }

  /** Renames a set, or replaces its AGENTS.md. An absent field is left alone. */
  updateSet(id: string, body: { name?: unknown; agentsMd?: unknown }): AgentSetDetail {
    const row = this.mustGet(id);
    const name = body.name === undefined ? row.name : validSetName(body.name);
    const agentsMd =
      body.agentsMd === undefined ? row.agents_md : validContent(body.agentsMd, 'agentsMd');
    this.db
      .prepare('UPDATE agent_sets SET name = ?, agents_md = ?, updated_at = ? WHERE id = ?')
      .run(name, agentsMd, Date.now(), id);
    return this.getSet(id);
  }

  /**
   * Removes a set. The global set cannot be removed, because every box gets
   * it.
   *
   * The database clears the set from every box that named it. Those boxes
   * get the global set alone at their next start.
   */
  deleteSet(id: string): void {
    this.mustGet(id);
    if (id === GLOBAL_AGENT_SET) {
      throw new HttpError(400, 'The global set is applied to every box and cannot be deleted');
    }
    this.db.prepare('DELETE FROM agent_sets WHERE id = ?').run(id);
  }

  /** Creates a skill, or replaces the one already under that name. */
  putItem(id: string, body: AgentItemBody | undefined): AgentSetDetail {
    this.mustGet(id);
    const name = validItemName(body?.name);
    const content = validContent(body?.content, 'content');
    const now = Date.now();

    const existing = this.db
      .prepare('SELECT 1 FROM agent_items WHERE set_id = ? AND name = ?')
      .get(id, name);
    if (!existing) {
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM agent_items WHERE set_id = ?')
        .get(id) as { n: number };
      if (count.n >= MAX_ITEMS) {
        throw new HttpError(400, `A set holds at most ${MAX_ITEMS} skills`);
      }
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_items (set_id, name, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(set_id, name) DO UPDATE SET
             content = excluded.content, updated_at = excluded.updated_at`,
        )
        .run(id, name, content, now, now);
      this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(now, id);
    })();
    return this.getSet(id);
  }

  /** Removes one skill. Removing what is not there is a 404. */
  deleteItem(id: string, name: unknown): AgentSetDetail {
    this.mustGet(id);
    const info = this.db
      .prepare('DELETE FROM agent_items WHERE set_id = ? AND name = ?')
      .run(id, validItemName(name));
    if (info.changes === 0) throw new HttpError(404, 'No such skill');
    this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    return this.getSet(id);
  }

  // --- merging --------------------------------------------------------------

  /**
   * What a box that selected `setId` gets: the global set with that one
   * laid over it.
   *
   * The two kinds of content merge differently. An AGENTS.md is prose and
   * accumulates: the global one comes first and the set's follows, separated
   * by a blank line. A skill is addressed by name, and two skills cannot
   * share one, so the set's wins.
   */
  bundle(setId: string | null): AgentBundlePreview {
    const global = this.db
      .prepare('SELECT * FROM agent_sets WHERE id = ?')
      .get(GLOBAL_AGENT_SET) as AgentSetRow | undefined;
    const extra =
      setId && setId !== GLOBAL_AGENT_SET
        ? (this.db.prepare('SELECT * FROM agent_sets WHERE id = ?').get(setId) as
            | AgentSetRow
            | undefined)
        : undefined;

    const agentsMd = [global?.agents_md ?? '', extra?.agents_md ?? '']
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n');

    const byName = new Map<string, AgentItem>();
    for (const item of global ? this.items(global.id) : []) {
      byName.set(item.name, item);
    }
    const overrides: string[] = [];
    for (const item of extra ? this.items(extra.id) : []) {
      if (byName.has(item.name)) overrides.push(item.name);
      byName.set(item.name, item);
    }

    const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { agentsMd, items, overrides };
  }

  // --- materializing --------------------------------------------------------

  /**
   * Writes a box's merged set to its directory and returns that path. The
   * container mounts the directory read-only, and the entrypoint installs it
   * into the home at each start, so an edited set reaches a box at its next
   * start.
   *
   * The set is written once for each harness, in that harness's layout,
   * because a box may hold threads of both. Every path is relative to the
   * home and is already the path inside the box. The `manifest` file lists
   * every path, and the entrypoint removes what the previous manifest
   * installed before it installs the new one.
   *
   * The directory itself stays and only its contents change, because a
   * running container has it bind-mounted. The new bundle is written before
   * the old entries are removed, so the directory is never empty while a box
   * may read it.
   */
  materialize(boxId: string, setId: string | null): string {
    const dir = agentConfigPath(this.dataDir, boxId);
    ensureAgentsRoot(this.dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o755 });

    const bundle = this.bundle(setId);
    const manifest: string[] = [];

    for (const { layout } of Object.values(HARNESSES)) {
      if (bundle.agentsMd !== '') {
        // The harness's user-level memory, so it applies in every directory
        // the agent works in.
        this.write(dir, layout.agentsMd, bundle.agentsMd);
        manifest.push(layout.agentsMd);
      }
      for (const item of bundle.items) {
        // A skill is a directory, so the manifest names the directory and a
        // removal takes everything the skill carried with it.
        const rel = `${layout.skills}/${item.name}`;
        this.write(dir, `${rel}/SKILL.md`, item.content);
        manifest.push(rel);
      }
    }
    this.write(dir, 'manifest', manifest.join('\n'));
    this.prune(dir, [...manifest, 'manifest']);

    chownToAgent(dir);
    return dir;
  }

  /**
   * Removes whatever an earlier bundle left in the directory and this one
   * does not have, so a skill deleted here disappears from the box.
   *
   * Only the two places a layout names are looked at, once per harness:
   * the instructions file, and the entries of the skills directory, each of
   * which is one skill.
   *
   * @param dir The box's materialized directory.
   * @param keep Every path this bundle wrote, relative to `dir`.
   */
  private prune(dir: string, keep: readonly string[]): void {
    const wanted = new Set(keep);
    for (const { layout } of Object.values(HARNESSES)) {
      if (!wanted.has(layout.agentsMd)) rmSync(join(dir, layout.agentsMd), { force: true });
      const rel = layout.skills;
      if (!existsSync(join(dir, rel))) continue;
      for (const child of readdirSync(join(dir, rel))) {
        if (wanted.has(`${rel}/${child}`)) continue;
        rmSync(join(dir, rel, child), { recursive: true, force: true });
      }
    }
    removeEmptyDirs(dir);
  }

  /** Writes one file under the materialized directory, agent-owned. */
  private write(dir: string, rel: string, content: string): void {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    // Every directory on the way down has to be traversable by the agent user,
    // not only the leaf.
    for (let at = dirname(path); relative(dir, at) !== ''; at = dirname(at)) {
      chownToAgent(at);
    }
    writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o644 });
    chownToAgent(path);
  }

  /** Drops a box's materialized directory, when the box is deleted. */
  removeMaterialized(boxId: string): void {
    rmSync(agentConfigPath(this.dataDir, boxId), { recursive: true, force: true });
  }
}

/**
 * Removes every empty directory under `dir`, deepest first, leaving `dir`.
 *
 * A layout's directories nest, so the last skill of a harness leaving takes
 * the directory it was in and the harness directory above it: a harness with
 * nothing installed keeps nothing.
 */
function removeEmptyDirs(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    removeEmptyDirs(path);
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  }
}

// --- validation ---------------------------------------------------------------

/** Checks a set's display name. */
function validSetName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') throw new HttpError(400, 'name is required');
  if (name.length > MAX_SET_NAME) {
    throw new HttpError(400, `name must be ${MAX_SET_NAME} characters or fewer`);
  }
  return name;
}

/**
 * Checks a skill name. The name becomes a path component and the word after
 * the slash, so a name that does not match is refused rather than changed.
 */
function validItemName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      'name must be lowercase letters, digits and dashes, start with a letter or digit, ' +
        'and be 64 characters or fewer',
    );
  }
  return name;
}

/** Checks a file's content, which may legitimately be empty. */
function validContent(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  if (value.length > MAX_CONTENT) {
    throw new HttpError(400, `${field} must be ${MAX_CONTENT} characters or fewer`);
  }
  // Line endings become LF, so what is stored is what the editor showed.
  return value.replace(/\r\n?/g, '\n');
}
