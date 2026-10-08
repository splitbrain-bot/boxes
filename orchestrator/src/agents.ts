import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import {
  GLOBAL_AGENT_SET,
  type AgentBundlePreview,
  type AgentItem,
  type AgentItemBody,
  type AgentRepoBody,
  type AgentSetDetail,
  type AgentSetSummary,
} from '../../shared/types.ts';
import type { AgentItemRow, AgentRepoRow, AgentSetRow, Db } from './db.ts';
import { HARNESSES } from './harness.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import {
  fetchRepo,
  findSkills,
  repoDir,
  repoDirIds,
  repoName,
  repoTree,
  type RepoFetcher,
  type RepoSkill,
} from './skill-repos.ts';
import { chownToAgent } from './workspaces.ts';

/**
 * Agent sets: the AGENTS.md and skills a box's agent is configured with. The
 * database holds them, and the files a box gets are derived from it. A set
 * can also take skills from git repositories, which are pulled into
 * checkouts under DATA_DIR.
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

/** Most skills a single set may hold, and most a repository may give. */
const MAX_ITEMS = 100;

/** Most repositories a single set may take skills from. */
const MAX_REPOS = 20;

/** Longest a repository URL may be. */
const MAX_URL = 500;

/** A branch, tag or full commit hash, which cannot be read as a git option. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** How old the last pull of a repository may be before it is pulled again. */
const PULL_EVERY_MS = 24 * 60 * 60_000;

/**
 * One skill of a merged set: written from its stored SKILL.md, or copied
 * from a repository's checkout.
 */
type BundleSkill =
  | { name: string; repo: null; content: string }
  | { name: string; repo: string; dir: string };

/** A merged set, with the source of each skill. */
interface Bundle {
  /** The merged AGENTS.md. */
  agentsMd: string;
  /** Every skill, by name. */
  skills: BundleSkill[];
  /** Names the selected set took over from the global one. */
  overrides: string[];
}

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
    /** The DATA_DIR the merged sets and the repository checkouts are written under. */
    private readonly dataDir: string,
    /** Fetches a repository into its checkout. */
    private readonly fetcher: RepoFetcher = (dir, url, ref, keep) =>
      fetchRepo(dir, url, ref, null, keep),
  ) {}

  /** The pulls running now, by repository id. */
  private readonly pulls = new Map<string, Promise<void>>();

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
      repos: this.repoRows(id).map((repo) => ({
        id: repo.id,
        url: repo.url,
        ref: repo.ref,
        commit: repo.commit_sha,
        skills: repoSkills(repo).map((skill) => skill.name),
        pulledAt: repo.pulled_at,
        error: repo.error,
      })),
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

  /** A set's repositories, in the order they were added. */
  private repoRows(setId: string): AgentRepoRow[] {
    return this.db
      .prepare('SELECT * FROM agent_repos WHERE set_id = ? ORDER BY created_at, rowid')
      .all(setId) as AgentRepoRow[];
  }

  /** One repository's row, or undefined when it is gone. */
  private repoRow(repoId: string): AgentRepoRow | undefined {
    return this.db.prepare('SELECT * FROM agent_repos WHERE id = ?').get(repoId) as
      | AgentRepoRow
      | undefined;
  }

  /** Counts and flags, without loading any content. */
  private summarize(row: AgentSetRow): AgentSetSummary {
    const counts = this.db
      .prepare('SELECT COUNT(*) AS skills FROM agent_items WHERE set_id = ?')
      .get(row.id) as { skills: number };
    const repos = this.db
      .prepare('SELECT COUNT(*) AS n FROM agent_repos WHERE set_id = ?')
      .get(row.id) as { n: number };
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
      repoCount: repos.n,
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
   * get the global set alone at their next start. The checkouts of the set's
   * repositories are removed with it.
   */
  deleteSet(id: string): void {
    this.mustGet(id);
    if (id === GLOBAL_AGENT_SET) {
      throw new HttpError(400, 'The global set is applied to every box and cannot be deleted');
    }
    const repos = this.repoRows(id);
    this.db.prepare('DELETE FROM agent_sets WHERE id = ?').run(id);
    for (const repo of repos) rmSync(repoDir(this.dataDir, repo.id), { recursive: true, force: true });
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

  // --- repositories ---------------------------------------------------------

  /**
   * Adds a repository to a set and pulls it. A failed pull is recorded on the
   * repository, which stays in the set.
   */
  async addRepo(setId: string, body: AgentRepoBody | undefined): Promise<AgentSetDetail> {
    this.mustGet(setId);
    const url = validRepoUrl(body?.url);
    const ref = validRef(body?.ref);
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM agent_repos WHERE set_id = ?')
      .get(setId) as { n: number };
    if (count.n >= MAX_REPOS) {
      throw new HttpError(400, `A set takes skills from at most ${MAX_REPOS} repositories`);
    }

    const id = `ar${randomBytes(5).toString('hex')}`;
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_repos (id, set_id, url, ref, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, setId, url, ref, now);
      this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(now, setId);
    })();
    await this.pullRepo(id);
    return this.getSet(setId);
  }

  /** Removes a repository from a set, with its checkout. */
  deleteRepo(setId: string, repoId: string): AgentSetDetail {
    this.mustGet(setId);
    const info = this.db
      .prepare('DELETE FROM agent_repos WHERE id = ? AND set_id = ?')
      .run(repoId, setId);
    if (info.changes === 0) throw new HttpError(404, 'No such repository');
    rmSync(repoDir(this.dataDir, repoId), { recursive: true, force: true });
    this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(Date.now(), setId);
    return this.getSet(setId);
  }

  /** Pulls one repository of a set now. */
  async refreshRepo(setId: string, repoId: string): Promise<AgentSetDetail> {
    this.mustGet(setId);
    if (this.repoRow(repoId)?.set_id !== setId) throw new HttpError(404, 'No such repository');
    await this.pullRepo(repoId);
    return this.getSet(setId);
  }

  /**
   * Pulls every repository whose last pull is a day old, one after the
   * other, and removes the checkouts that no repository owns.
   */
  async pullDue(now = Date.now()): Promise<void> {
    const ids = this.db.prepare('SELECT id FROM agent_repos').all() as Array<{ id: string }>;
    const known = new Set(ids.map((row) => row.id));
    for (const id of repoDirIds(this.dataDir)) {
      if (!known.has(id)) rmSync(repoDir(this.dataDir, id), { recursive: true, force: true });
    }

    const due = this.db
      .prepare(
        `SELECT id FROM agent_repos WHERE pulled_at IS NULL OR pulled_at <= ?
          ORDER BY created_at, rowid`,
      )
      .all(now - PULL_EVERY_MS) as Array<{ id: string }>;
    for (const { id } of due) await this.pullRepo(id);
  }

  /** Pulls one repository, or joins the pull of it that runs already. */
  pullRepo(repoId: string): Promise<void> {
    const running = this.pulls.get(repoId);
    if (running) return running;
    const pull = this.fetchAndRecord(repoId).finally(() => this.pulls.delete(repoId));
    this.pulls.set(repoId, pull);
    return pull;
  }

  /**
   * Fetches one repository and records its commit and skills. A failed fetch
   * is recorded, not thrown, and the last good checkout stays in use.
   */
  private async fetchAndRecord(repoId: string): Promise<void> {
    const row = this.repoRow(repoId);
    if (!row) return;
    const exists = (): boolean => this.repoRow(repoId) !== undefined;

    let commit: string;
    try {
      commit = await this.fetcher(repoDir(this.dataDir, repoId), row.url, row.ref, exists);
    } catch (err) {
      const error = (err as Error).message;
      log.warn('could not pull a skill repository', { url: row.url, ref: row.ref, error });
      this.db
        .prepare('UPDATE agent_repos SET pulled_at = ?, error = ? WHERE id = ?')
        .run(Date.now(), error, repoId);
      return;
    }
    if (!exists()) return;

    const skills = findSkills(
      repoTree(this.dataDir, repoId),
      repoName(row.url),
      (name) => NAME_PATTERN.test(name),
      MAX_ITEMS,
    );
    this.db
      .prepare(
        `UPDATE agent_repos SET commit_sha = ?, skills = ?, pulled_at = ?, error = NULL
          WHERE id = ?`,
      )
      .run(commit, JSON.stringify(skills), Date.now(), repoId);
  }

  // --- merging --------------------------------------------------------------

  /**
   * What a box that selected `setId` gets, as the editor shows it: the
   * global set with that one laid over it.
   */
  bundle(setId: string | null): AgentBundlePreview {
    const { agentsMd, skills, overrides } = this.merge(setId);
    return {
      agentsMd,
      skills: skills.map((skill) => ({ name: skill.name, repo: skill.repo })),
      overrides,
    };
  }

  /**
   * The global set with the selected one laid over it.
   *
   * The two kinds of content merge differently. An AGENTS.md is prose and
   * accumulates: the global one comes first and the set's follows, separated
   * by a blank line. A skill is addressed by name, and two skills cannot
   * share one, so the set's wins.
   */
  private merge(setId: string | null): Bundle {
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

    const byName = global ? this.skillsOf(global.id) : new Map<string, BundleSkill>();
    const overrides: string[] = [];
    for (const skill of extra ? this.skillsOf(extra.id).values() : []) {
      if (byName.has(skill.name)) overrides.push(skill.name);
      byName.set(skill.name, skill);
    }

    const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { agentsMd, skills, overrides };
  }

  /**
   * The skills of one set, by name. A skill of the set wins over a skill of
   * its repositories, and a repository wins over the ones added after it.
   */
  private skillsOf(setId: string): Map<string, BundleSkill> {
    const byName = new Map<string, BundleSkill>();
    for (const repo of this.repoRows(setId)) {
      const tree = repoTree(this.dataDir, repo.id);
      for (const skill of repoSkills(repo)) {
        if (byName.has(skill.name)) continue;
        byName.set(skill.name, { name: skill.name, repo: repo.url, dir: join(tree, skill.path) });
      }
    }
    for (const item of this.items(setId)) {
      byName.set(item.name, { name: item.name, repo: null, content: item.content });
    }
    return byName;
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

    const bundle = this.merge(setId);
    const manifest: string[] = [];

    for (const { layout } of Object.values(HARNESSES)) {
      if (bundle.agentsMd !== '') {
        // The harness's user-level memory, so it applies in every directory
        // the agent works in.
        this.write(dir, layout.agentsMd, bundle.agentsMd);
        manifest.push(layout.agentsMd);
      }
      for (const skill of bundle.skills) {
        // A skill is a directory, so the manifest names the directory and a
        // removal takes everything the skill carried with it.
        const rel = `${layout.skills}/${skill.name}`;
        // A pull may have replaced the checkout this skill was found in.
        if (skill.repo !== null && !existsSync(skill.dir)) continue;
        rmSync(join(dir, rel), { recursive: true, force: true });
        if (skill.repo === null) {
          this.write(dir, `${rel}/SKILL.md`, skill.content);
        } else {
          this.makeParents(dir, rel);
          copyTree(skill.dir, join(dir, rel));
        }
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
    this.makeParents(dir, rel);
    writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o644 });
    chownToAgent(path);
  }

  /** Creates the directories above `rel` in the materialized directory, agent-owned. */
  private makeParents(dir: string, rel: string): void {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    // Every directory on the way down has to be traversable by the agent user,
    // not only the leaf.
    for (let at = dirname(path); relative(dir, at) !== ''; at = dirname(at)) {
      chownToAgent(at);
    }
  }

  /** Drops a box's materialized directory, when the box is deleted. */
  removeMaterialized(boxId: string): void {
    rmSync(agentConfigPath(this.dataDir, boxId), { recursive: true, force: true });
  }
}

/** The skills a repository's last good pull found. */
function repoSkills(row: AgentRepoRow): RepoSkill[] {
  return JSON.parse(row.skills) as RepoSkill[];
}

/**
 * Copies a skill's directory from a checkout, agent-owned. Files keep their
 * mode, so a script stays executable. Links are left out, because they could
 * point anywhere on this host.
 */
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { mode: 0o755 });
  chownToAgent(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      chownToAgent(to);
    }
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

/**
 * Checks a repository URL. Only HTTPS is fetched, and credentials in the URL
 * are refused, because the URL is stored and shown.
 */
function validRepoUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'url must be an HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'url must be an HTTPS URL');
  if (raw.length > MAX_URL) {
    throw new HttpError(400, `url must be ${MAX_URL} characters or fewer`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpError(400, 'url must not contain credentials');
  }
  return raw;
}

/** Checks a branch, tag or commit. Absent or empty means the default branch. */
function validRef(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'ref must be a string');
  const ref = value.trim();
  if (ref !== '' && !REF_PATTERN.test(ref)) {
    throw new HttpError(400, 'ref must be a branch, a tag or a full commit hash');
  }
  return ref;
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
