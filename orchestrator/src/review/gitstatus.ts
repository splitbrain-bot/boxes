import { type GitBox, type GitTarget, git, gitOut } from './git.ts';
import { gitTarget, inWorkspace, type RepoMap } from './repos.ts';
import { REVIEW_FILE } from './tree.ts';

/** The git status of a file, as the tree shows it. */
type FileStatus = 'modified' | 'staged' | 'untracked' | 'added' | 'deleted' | 'conflict';

/** Git statuses by file path, relative to a repository or to the workspace. */
export type FileStatuses = Record<string, FileStatus>;

/**
 * The commit a review is compared against. Both fields empty means HEAD, which
 * is the default.
 */
export interface Base {
  /** The revision that the user gave, for example a branch, a tag or a short commit id. */
  rev: string;
  /** The commit resolved from `rev` that the review compares against. */
  commit: string;
}

/** No base revision chosen, so the review compares against HEAD. */
export const NO_BASE: Base = { rev: '', commit: '' };

/**
 * Returns the revision that `git diff` compares against.
 *
 * @param base The base of the review.
 * @returns The base commit, or 'HEAD' when no base is set.
 */
export function baseRev(base: Base): string {
  return base.commit === '' ? 'HEAD' : base.commit;
}

/**
 * Normalises a relative, slash-separated path from git. It drops `.` segments,
 * duplicate separators and a trailing separator.
 *
 * @param path The path from git.
 * @returns The normalised path.
 */
function cleanPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  return parts.join('/');
}

/**
 * Parses `git status --porcelain -z` output into per-file statuses.
 *
 * Each record is `XY path`, ends in a NUL byte and holds the path verbatim.
 * With `-z`, git writes names unquoted, and a name holding a space, an arrow or
 * a newline stays one record.
 *
 * @param out The output of git status.
 * @returns The statuses by path.
 */
export function parsePorcelain(out: string): FileStatuses {
  const result: FileStatuses = {};
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    const x = record.charAt(0);
    const y = record.charAt(1);
    // A rename or a copy is followed by a record holding the source path,
    // which is skipped.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    const status = classifyStatus(x, y);
    if (status) result[cleanPath(record.slice(3))] = status;
  }
  return result;
}

/**
 * Parses `git diff --name-status <base>` into per-file statuses.
 *
 * @param out The output of git diff.
 * @returns The statuses by path.
 */
export function parseNameStatus(out: string): FileStatuses {
  const result: FileStatuses = {};
  for (const line of out.split('\n')) {
    const [code, ...rest] = line.split('\t');
    // Renames and copies list the old path first, so the last field is the path.
    const path = rest.at(-1);
    if (!code || path === undefined) continue;
    const status = classifyDiffStatus(code.charAt(0));
    if (status) result[cleanPath(path)] = status;
  }
  return result;
}

/**
 * Parses a newline-separated path list, as `ls-files` writes it.
 *
 * @param out The output of git.
 * @returns The normalised paths.
 */
export function parsePathList(out: string): string[] {
  return out
    .split('\n')
    .filter((path) => path !== '')
    .map(cleanPath);
}

/**
 * Maps a `git diff --name-status` letter onto a status.
 *
 * @param code The status letter.
 * @returns The status, or null for a letter that the tree does not show.
 */
function classifyDiffStatus(code: string): FileStatus | null {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
    case 'R':
    case 'C':
    case 'T':
      return 'modified';
    default:
      return null;
  }
}

/**
 * Maps a porcelain letter pair onto a status.
 *
 * @param x The letter for the index.
 * @param y The letter for the work tree.
 * @returns The status, or null for a pair that the tree does not show.
 */
function classifyStatus(x: string, y: string): FileStatus | null {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflict';
  }
  // A staged addition or deletion has priority over a change in the work tree.
  if (x === 'A') return 'added';
  if (x === 'D') return 'deleted';
  if (x === 'M' || x === 'R' || x === 'C') {
    // A further change in the work tree shows as modified.
    if (y === 'M' || y === 'D') return 'modified';
    return 'staged';
  }
  if (y === 'M') return 'modified';
  if (y === 'D') return 'deleted';
  return null;
}

/**
 * Reads the status of every file in a repository. With a base commit set, the status
 * compares the files against that commit. Without one, it compares against HEAD.
 *
 * `-uall` lists untracked files one by one, as the file tree lists them.
 * `--no-renames` reports a rename as a deletion and an addition, so the tree
 * can show the path the file moved away from.
 *
 * @param target The repository to run git in.
 * @param base The base to compare against.
 * @returns The statuses by path relative to the repository, or null when git fails, as it does outside a
 *   repository.
 */
export async function fileStatuses(target: GitTarget, base: Base): Promise<FileStatuses | null> {
  if (base.commit !== '') return statusesSince(target, base);

  const result = await git(target, ['status', '--porcelain', '-z', '-uall', '--no-renames']);
  if (!result.ok) return null;
  return parsePorcelain(result.stdout);
}

/**
 * Reads the differences between the work tree and a base commit, with committed and
 * uncommitted changes. The result also lists untracked files, because they are
 * part of the review.
 *
 * @param target The repository to run git in.
 * @param base The base to compare against. Its commit is set.
 * @returns The statuses by path relative to the repository, or null when git diff fails.
 */
async function statusesSince(target: GitTarget, base: Base): Promise<FileStatuses | null> {
  const named = await git(target, ['diff', '--name-status', '--no-renames', base.commit]);
  if (!named.ok) return null;
  const result = parseNameStatus(named.stdout);

  const untracked = await gitOut(target, ['ls-files', '--others', '--exclude-standard']);
  for (const path of parsePathList(untracked)) result[path] = 'untracked';

  return result;
}

/**
 * Resolves a revision from the user, for example a branch, a tag or a commit id,
 * into the commit that a review compares against.
 *
 * The function uses the merge base of the revision and HEAD, so commits on the
 * base branch after the branch point do not show as changes. When the two have
 * no common ancestor, it uses the revision itself.
 *
 * @param target The repository to run git in.
 * @param rev The revision from the user.
 * @returns The base, or an error message when the target is not a repository or the revision names no commit.
 */
export async function resolveBase(
  target: GitTarget,
  rev: string,
): Promise<{ base: Base } | { error: string }> {
  const isRepo = await git(target, ['rev-parse', '--git-dir']);
  if (!isRepo.ok) return { error: 'not a git repository' };

  const verified = await git(target, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (!verified.ok) return { error: `unknown revision: ${rev}` };
  let commit = verified.stdout.trim();

  const mergeBase = await git(target, ['merge-base', commit, 'HEAD']);
  if (mergeBase.ok) {
    const found = mergeBase.stdout.trim();
    if (found !== '') commit = found;
  }

  return { base: { rev, commit } };
}

/**
 * Reads the status of every file in the workspace, merged from every repository in
 * it.
 *
 * The function runs git in all repositories in parallel and puts the path of each
 * repository in front of its paths. It keeps a status from repository `P` only
 * when `P` is the closest repository to that path. Thus an outer repository
 * cannot report an inner work tree as one untracked entry, and no two
 * repositories report the same path.
 *
 * The result leaves out the REVIEW.md of the workspace, because it is the
 * review and not a file under review. Git reports it only when the workspace is
 * itself a repository.
 *
 * @param box The box and the workspace in it.
 * @param map The repositories of the workspace.
 * @param bases The base of each repository, by repository path. A repository without an entry compares against HEAD.
 * @returns The statuses by workspace-relative path.
 */
export async function workspaceStatuses(
  box: GitBox,
  map: RepoMap,
  bases: Map<string, Base>,
): Promise<FileStatuses> {
  const perRepo = await Promise.all(
    map.repos.map(async (repo) => {
      const statuses = await fileStatuses(
        gitTarget(box, repo.path),
        bases.get(repo.path) ?? NO_BASE,
      );
      const owned: FileStatuses = {};
      for (const [path, status] of Object.entries(statuses ?? {})) {
        const full = inWorkspace(repo, path);
        if (full === REVIEW_FILE) continue;
        if (map.repoFor(full)?.path !== repo.path) continue;
        owned[full] = status;
      }
      return owned;
    }),
  );
  return Object.assign({}, ...perRepo) as FileStatuses;
}

/**
 * Resolves one revision expression in every repository of a workspace.
 *
 * For example, `main` resolves to the merge base of `main` and HEAD in each
 * repository. The result leaves out a repository where the revision names
 * nothing, so that repository is compared against its own HEAD.
 *
 * @param box The box and the workspace in it.
 * @param map The repositories of the workspace.
 * @param rev The revision expression, or '' for no base.
 * @returns The base of each repository, by repository path. The map is empty when `rev` is ''.
 */
export async function resolveBases(
  box: GitBox,
  map: RepoMap,
  rev: string,
): Promise<Map<string, Base>> {
  const bases = new Map<string, Base>();
  if (rev === '') return bases;
  const resolved = await Promise.all(
    map.repos.map(
      async (repo) => [repo.path, await resolveBase(gitTarget(box, repo.path), rev)] as const,
    ),
  );
  for (const [path, result] of resolved) {
    if ('base' in result) bases.set(path, result.base);
  }
  return bases;
}
