import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isTopLevel, type GitBox, type GitTarget } from './git.ts';

/** One repository found in a workspace. */
export interface Repo {
  /**
   * Where it sits relative to the workspace, slash-separated. Empty when the
   * workspace is itself the repository.
   */
  path: string;
  /** What to call it: its last path segment, or the workspace's own name. */
  name: string;
  /** Where its git runs: the box's container, and its root inside it. */
  git: GitTarget;
}

/**
 * Directory names the discovery walk does not enter.
 *
 * A dependency tree can hold dozens of repositories that no reviewer wants
 * listed. A repository cloned into such a directory, for example `vendor/`, is
 * not found.
 */
const PRUNED_DIRS = new Set([
  '.boxes',
  'vendor',
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svn',
  '.hg',
]);

/**
 * How deep under the workspace a repository is looked for.
 *
 * Clones sit near the top, as in `/workspace/projects/foo`. Much deeper
 * directories belong to dependency trees.
 */
export const MAX_REPO_DEPTH = 6;

/**
 * How many directories one discovery walk may read before it stops looking.
 *
 * After `npm install`, a workspace can hold tens of thousands of directories.
 * {@link PRUNED_DIRS} drops most of them, and this cap bounds the rest.
 */
export const MAX_SCANNED_DIRS = 4000;

/** How many repositories a workspace may contribute before the rest are left out. */
const MAX_REPOS = 32;

/**
 * The repositories of one workspace, with the lookup that assigns a path to
 * one of them.
 *
 * A workspace can hold several repositories: side by side, deeper down, or one
 * inside another. Each path belongs to its closest enclosing repository, and a
 * path that no repository encloses is shown without git. The map is immutable.
 */
export class RepoMap {
  /** The repositories, sorted by path. The API reports them in this order. */
  readonly repos: readonly Repo[];

  constructor(
    /** The workspace every path in this map is relative to. */
    readonly workspace: string,
    repos: Repo[],
  ) {
    this.repos = [...repos].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Whether the workspace holds any repository at all. */
  get hasGit(): boolean {
    return this.repos.length > 0;
  }

  /**
   * The closest repository enclosing a workspace-relative path, or null when
   * no repository claims it.
   *
   * The longest enclosing path wins, so a nested repository claims its own
   * files.
   */
  repoFor(path: string): Repo | null {
    let best: Repo | null = null;
    for (const repo of this.repos) {
      if (!encloses(repo.path, path)) continue;
      if (best === null || repo.path.length > best.path.length) best = repo;
    }
    return best;
  }

  /** The repository rooted exactly at this workspace-relative path, or null. */
  at(path: string): Repo | null {
    return this.repos.find((repo) => repo.path === path) ?? null;
  }
}

/** Whether a repository at `prefix` encloses a workspace-relative path. */
function encloses(prefix: string, path: string): boolean {
  if (prefix === '') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** A path inside a repository, as the workspace names it. */
export function inWorkspace(repo: Repo, path: string): string {
  return repo.path === '' ? path : `${repo.path}/${path}`;
}

/**
 * Where one repository's git runs, from its workspace-relative path.
 *
 * The container holds the workspace at `box.workspaceDir`, so the repository
 * root inside the box is the two joined.
 */
export function gitTarget(box: GitBox, repoPath: string): GitTarget {
  return {
    containerId: box.containerId,
    dir: repoPath === '' ? box.workspaceDir : `${box.workspaceDir}/${repoPath}`,
  };
}

/**
 * A workspace-relative path as its own repository names it.
 *
 * The repository must enclose the path, as {@link RepoMap.repoFor} ensures.
 * This function does not check it.
 */
export function inRepo(repo: Repo, path: string): string {
  return repo.path === '' ? path : path.slice(repo.path.length + 1);
}

/**
 * Finds every repository in a workspace, up to {@link MAX_REPOS}.
 *
 * The walk reads the workspace directory on this process's filesystem, which
 * is the same tree the box holds at `box.workspaceDir`. Every directory holding
 * a `.git` file or directory is a candidate. Git in the box then confirms that
 * each candidate is the top of a work tree.
 */
export async function discoverRepos(workspace: string, box: GitBox): Promise<RepoMap> {
  const candidates = candidateDirs(workspace, box);
  const confirmed = await Promise.all(
    candidates.map(async (candidate) => ((await isTopLevel(candidate.git)) ? candidate : null)),
  );
  return new RepoMap(workspace, confirmed.filter((repo) => repo !== null).slice(0, MAX_REPOS));
}

/**
 * The directories under a workspace that hold a `.git`, breadth first.
 *
 * The walk skips {@link PRUNED_DIRS} and stops at {@link MAX_REPO_DEPTH},
 * {@link MAX_SCANNED_DIRS} or {@link MAX_REPOS}. Breadth first means a cap
 * leaves the deepest directories unread, where dependency trees sit.
 */
function candidateDirs(workspace: string, box: GitBox): Repo[] {
  const found: Repo[] = [];
  let scanned = 0;
  let queue: Array<{ absolute: string; path: string }> = [{ absolute: workspace, path: '' }];

  for (let depth = 0; depth <= MAX_REPO_DEPTH && queue.length > 0; depth++) {
    const next: typeof queue = [];
    for (const dir of queue) {
      if (scanned >= MAX_SCANNED_DIRS || found.length >= MAX_REPOS) return found;
      scanned++;

      let entries;
      try {
        entries = readdirSync(dir.absolute, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: skipped, not fatal
      }

      for (const entry of entries) {
        // A `.git` file marks a linked worktree or a submodule.
        if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
          found.push({
            path: dir.path,
            name: dir.path === '' ? workspaceName(workspace) : (dir.path.split('/').pop() ?? ''),
            git: gitTarget(box, dir.path),
          });
        }
        // `isDirectory` is false for a symlink, so the walk never follows a
        // link out of the agent's tree.
        if (!entry.isDirectory() || PRUNED_DIRS.has(entry.name)) continue;
        next.push({
          absolute: join(dir.absolute, entry.name),
          path: dir.path === '' ? entry.name : `${dir.path}/${entry.name}`,
        });
      }
    }
    queue = next;
  }

  return found;
}

/** What to call a repository that is the workspace itself. */
function workspaceName(workspace: string): string {
  return workspace.split('/').filter((part) => part !== '').pop() ?? 'workspace';
}
