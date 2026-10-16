import type { FileService } from '../files.ts';
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
 * The box holds the workspace at `box.workspaceDir`, so the repository
 * root inside the box is the two joined.
 */
export function gitTarget(box: GitBox, repoPath: string): GitTarget {
  return {
    boxId: box.boxId,
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
 * The file service in the box walks the workspace breadth first. It skips
 * {@link PRUNED_DIRS} and stops at {@link MAX_REPO_DEPTH},
 * {@link MAX_SCANNED_DIRS} or {@link MAX_REPOS}. Every directory holding a
 * `.git` file or directory is a candidate. Git in the box then confirms that
 * each candidate is the top of a work tree.
 */
export async function discoverRepos(files: FileService, box: GitBox): Promise<RepoMap> {
  const paths = await files.findRepos({
    maxDepth: MAX_REPO_DEPTH,
    maxScanned: MAX_SCANNED_DIRS,
    maxRepos: MAX_REPOS,
    pruned: [...PRUNED_DIRS],
  });
  const candidates = paths.map((path) => ({
    path,
    name: path === '' ? workspaceName(box.workspaceDir) : (path.split('/').pop() ?? ''),
    git: gitTarget(box, path),
  }));
  const confirmed = await Promise.all(
    candidates.map(async (candidate) => ((await isTopLevel(candidate.git)) ? candidate : null)),
  );
  return new RepoMap(
    box.workspaceDir,
    confirmed.filter((repo) => repo !== null).slice(0, MAX_REPOS),
  );
}

/** What to call a repository that is the workspace itself. */
function workspaceName(workspace: string): string {
  return workspace.split('/').filter((part) => part !== '').pop() ?? 'workspace';
}
