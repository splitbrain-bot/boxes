import type { FileService } from '../files.ts';
import { type GitBox, type GitTarget, isTopLevel } from './git.ts';

/** One repository found in a workspace. */
export interface Repo {
  /**
   * The path relative to the workspace, with slashes. Empty when the workspace
   * is itself the repository.
   */
  path: string;
  /** The display name. It is the last path segment, or the name of the workspace directory. */
  name: string;
  /** The box and the repository root in it, where git runs. */
  git: GitTarget;
}

/**
 * The directory names that the discovery walk does not enter.
 *
 * A dependency tree can hold many repositories that a reviewer does not want
 * listed. The walk does not find a repository cloned into such a directory, for example `vendor/`.
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
 * The maximum depth under the workspace at which the discovery looks for a repository.
 * The workspace has depth 0.
 *
 * Clones are usually near the top, as in `/workspace/projects/foo`. Much deeper
 * directories are usually part of dependency trees.
 */
export const MAX_REPO_DEPTH = 6;

/**
 * The maximum number of directories that one discovery walk reads before it stops.
 *
 * After `npm install`, a workspace can hold tens of thousands of directories.
 * The walk skips most of them through {@link PRUNED_DIRS}, and this cap limits the rest.
 */
export const MAX_SCANNED_DIRS = 4000;

/**
 * The maximum number of repositories that the discovery returns for one workspace. The walk stops when it
 * finds this number of candidates.
 */
const MAX_REPOS = 32;

/**
 * The repositories of one workspace, with the lookup that assigns a path to
 * one of them.
 *
 * A workspace can hold several repositories, also one inside another. The
 * review shows a path that no repository encloses without a git status or a diff. The map is
 * immutable.
 */
export class RepoMap {
  /** The repositories, sorted by path. The API reports them in this order. */
  readonly repos: readonly Repo[];

  /**
   * Creates the map and sorts the repositories by path.
   *
   * @param workspace The workspace that every path in this map is relative to.
   * @param repos The repositories of the workspace.
   */
  constructor(
    /** The workspace that every path in this map is relative to. */
    readonly workspace: string,
    repos: Repo[],
  ) {
    this.repos = [...repos].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** True when the workspace holds a repository. */
  get hasGit(): boolean {
    return this.repos.length > 0;
  }

  /**
   * Finds the closest repository that encloses a workspace-relative path.
   *
   * The longest enclosing path wins, so a nested repository claims its own
   * files.
   *
   * @param path The workspace-relative path.
   * @returns The repository, or null when no repository encloses the path.
   */
  repoFor(path: string): Repo | null {
    let best: Repo | null = null;
    for (const repo of this.repos) {
      if (!encloses(repo.path, path)) continue;
      if (best === null || repo.path.length > best.path.length) best = repo;
    }
    return best;
  }

  /**
   * Finds the repository whose root is exactly at a workspace-relative path.
   *
   * @param path The workspace-relative path.
   * @returns The repository, or null when no repository has its root there.
   */
  at(path: string): Repo | null {
    return this.repos.find((repo) => repo.path === path) ?? null;
  }
}

/**
 * Checks if a repository at `prefix` encloses a workspace-relative path.
 *
 * @param prefix The workspace-relative path of the repository.
 * @param path The workspace-relative path.
 * @returns True when the path is the repository root or inside it.
 */
function encloses(prefix: string, path: string): boolean {
  if (prefix === '') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Converts a repository-relative path into a workspace-relative path.
 *
 * @param repo The repository.
 * @param path The path relative to the repository.
 * @returns The path relative to the workspace.
 */
export function inWorkspace(repo: Repo, path: string): string {
  return repo.path === '' ? path : `${repo.path}/${path}`;
}

/**
 * Makes the git target of one repository from its workspace-relative path.
 *
 * @param box The box and the workspace in it.
 * @param repoPath The workspace-relative path of the repository.
 * @returns The git target for the repository root.
 */
export function gitTarget(box: GitBox, repoPath: string): GitTarget {
  return {
    boxId: box.boxId,
    dir: repoPath === '' ? box.workspaceDir : `${box.workspaceDir}/${repoPath}`,
  };
}

/**
 * Converts a workspace-relative path into a path relative to its repository.
 *
 * The repository must enclose the path, as {@link RepoMap.repoFor} ensures. The
 * function does not check it.
 *
 * @param repo The repository that encloses the path.
 * @param path The workspace-relative path.
 * @returns The path relative to the repository.
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
 *
 * @param files The file service in the box.
 * @param box The box and the workspace in it.
 * @returns The confirmed repositories.
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

/**
 * Gives the name of a repository that is the workspace itself.
 *
 * @param workspace The path of the workspace directory.
 * @returns The last segment of the path, or 'workspace' when the path has none.
 */
function workspaceName(workspace: string): string {
  return (
    workspace
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? 'workspace'
  );
}
