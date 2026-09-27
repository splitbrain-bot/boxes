import { git, gitOut, type GitBox, type GitTarget } from './git.ts';
import { gitTarget, inWorkspace, type RepoMap } from './repos.ts';
import { REVIEW_FILE } from './tree.ts';

/** The git status of a file, as the tree shows it. */
type FileStatus =
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'added'
  | 'deleted'
  | 'conflict';

/** Git statuses by file path, relative to a repository or to the workspace. */
export type FileStatuses = Record<string, FileStatus>;

/**
 * The commit a review is compared against. Both fields empty means HEAD, which
 * is the default.
 */
export interface Base {
  /** What the user asked for: a branch, a tag or a short id. */
  rev: string;
  /** The commit resolved from `rev` that the review compares against. */
  commit: string;
}

/** No base revision chosen, so the review compares against HEAD. */
export const NO_BASE: Base = { rev: '', commit: '' };

/** The revision to hand `git diff`. */
export function baseRev(base: Base): string {
  return base.commit === '' ? 'HEAD' : base.commit;
}

// --- pure parsers -----------------------------------------------------------

/**
 * Normalises a relative, slash-separated path from git. It drops `.` segments,
 * duplicate separators and a trailing separator.
 */
function cleanPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  return parts.join('/');
}

/**
 * Parses `git status --porcelain -z` output into per-file statuses.
 *
 * Each record is `XY path`, ends in a NUL byte and holds the path verbatim.
 * With `-z`, git does not quote names, and a name holding a space, an arrow or
 * a newline stays one record.
 */
export function parsePorcelain(out: string): FileStatuses {
  const result: FileStatuses = {};
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    // A rename or a copy is followed by a record holding the source path,
    // which is skipped.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    const status = classifyStatus(x, y);
    if (status) result[cleanPath(record.slice(3))] = status;
  }
  return result;
}

/** Parses `git diff --name-status <base>` into per-file statuses. */
export function parseNameStatus(out: string): FileStatuses {
  const result: FileStatuses = {};
  for (const line of out.split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 2 || fields[0] === '') continue;
    // Renames and copies list the old path first, so the last field is the path.
    const path = fields[fields.length - 1]!;
    const status = classifyDiffStatus(fields[0]![0]!);
    if (status) result[cleanPath(path)] = status;
  }
  return result;
}

/** Parses a newline-separated path list, as `ls-files` produces. */
export function parsePathList(out: string): string[] {
  return out
    .split('\n')
    .filter((path) => path !== '')
    .map(cleanPath);
}

/** Maps a `git diff --name-status` letter onto a status. */
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

/** Maps a porcelain index/work-tree letter pair onto a status. */
function classifyStatus(x: string, y: string): FileStatus | null {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflict';
  }
  // Staged changes take priority in what is shown.
  if (x === 'A') return 'added';
  if (x === 'D') return 'deleted';
  if (x === 'M' || x === 'R' || x === 'C') {
    // A further change in the working tree shows as modified.
    if (y === 'M' || y === 'D') return 'modified';
    return 'staged';
  }
  if (y === 'M') return 'modified';
  if (y === 'D') return 'deleted';
  return null;
}

// --- the invocations --------------------------------------------------------

/**
 * The status of every file in a repository. With a base commit set, files are
 * reported by how they differ from that commit rather than from HEAD.
 *
 * `-uall` lists untracked files one by one, as the file tree lists them.
 * `--no-renames` reports a rename as a deletion and an addition, so the tree
 * can show the path the file moved away from.
 *
 * Returns null when git fails, as it does outside a repository.
 */
export async function fileStatuses(target: GitTarget, base: Base): Promise<FileStatuses | null> {
  if (base.commit !== '') return statusesSince(target, base);

  const result = await git(target, ['status', '--porcelain', '-z', '-uall', '--no-renames']);
  if (!result.ok) return null;
  return parsePorcelain(result.stdout);
}

/**
 * How the working tree differs from a base commit, covering both committed and
 * uncommitted changes. Untracked files are listed as well, since they are part
 * of what is under review.
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
 * Resolves a user-supplied revision — a branch, a tag, a commit id — into the
 * commit a review is compared against.
 *
 * The merge base of that revision and HEAD is used, so commits made on the base
 * branch after branching off are not reported as this branch's changes. Falls
 * back to the revision itself when the two have no common ancestor.
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

// --- the workspace layer ----------------------------------------------------

/**
 * The status of every file in the workspace, merged from every repository in
 * it.
 *
 * The repositories are asked in parallel, and each prefixes its paths with its
 * own path. A status from repository `P` is kept only when `P` is the closest
 * repository to that path. This stops an outer repository from reporting an
 * inner work tree as one untracked entry, and keeps the merged keys disjoint.
 *
 * The workspace's REVIEW.md is left out, because it is the review and not a
 * file under review. Git reports it only when the workspace is itself a
 * repository.
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
 * `main` means main-in-each, through the merge base with that repository's own
 * HEAD. A repository where the revision names nothing is left out of the
 * result, so it is compared against its own HEAD. A workspace can hold one
 * repository with the branch and another without it.
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
