import { git, gitOut, type GitBox, type GitTarget } from './git.ts';
import { gitTarget, inWorkspace, type RepoMap } from './repos.ts';
import { REVIEW_FILE } from './tree.ts';

/**
 * Git file statuses and base-revision resolution.
 *
 * A port of the desktop tool's `internal/gitstatus`, with the workspace layer
 * on top: a review spans every repository the workspace holds, so the
 * statuses of all of them are merged into one map and one base expression is
 * resolved separately in each. The parsers are pure and take git's output as a
 * string; the functions that run git sit at the bottom and do nothing but call
 * them.
 */

/** The git status of a file, as the tree shows it. */
type FileStatus =
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'added'
  | 'deleted'
  | 'conflict';

/** File paths to their status, relative to whatever asked for them. */
export type FileStatuses = Record<string, FileStatus>;

/**
 * The commit a review is compared against.
 *
 * `rev` is what the user asked for — a branch, a tag, a short id — and `commit`
 * is what that resolved to. Both empty means comparing against the working
 * tree's HEAD, which is the default.
 */
export interface Base {
  rev: string;
  commit: string;
}

/** Comparing against HEAD: no base revision chosen. */
export const NO_BASE: Base = { rev: '', commit: '' };

/** The revision to hand `git diff`. */
export function baseRev(base: Base): string {
  return base.commit === '' ? 'HEAD' : base.commit;
}

// --- pure parsers -----------------------------------------------------------

/**
 * Cleans a path the way `filepath.Clean` does for the relative, slash-separated
 * paths git reports: collapse `.` segments and duplicate separators, and drop a
 * trailing separator. Nothing here can produce an absolute path or a `..`, and
 * containment is fs.ts's job either way.
 */
function cleanPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  return parts.join('/');
}

/**
 * Parses `git status --porcelain -z -uall` into per-file statuses.
 *
 * One NUL-terminated record per file, `XY path`, and the path verbatim: `-z`
 * is what stops git quoting a name with a special character in it and what
 * makes a name holding a space, an arrow or a newline one record rather than
 * an ambiguous line.
 *
 * Untracked files are listed individually — `-uall` — because the file tree
 * lists them individually too; a collapsed directory entry would match none of
 * them.
 */
export function parsePorcelain(out: string): FileStatuses {
  const result: FileStatuses = {};
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    // A rename or a copy is followed by a second record holding the path it
    // came from, which is not this record's.
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
    // Renames and copies report both the old and the new path.
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
    // Also changed in the working tree: the more urgent of the two wins.
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
 * `--no-renames` makes git report a rename as a deletion and an addition, so
 * the path the file was moved away from is still named — the tree can only
 * show a file the change removed if something reports it gone.
 *
 * Returns null when the directory is no git repository, which is the same
 * answer a separate check would have given and is what turns the git features
 * off in the UI.
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
 * The status of every file in the workspace, from every repository in it.
 *
 * One `git status` per repository, run in parallel, keys prefixed with the
 * repository's own path, and the same closest-repo filter the tree runs: a
 * status contributed by repository `P` for path `p` is dropped when the
 * closest repository to `P/p` is not `P`. That is what stops an outer
 * repository reporting an inner work tree as one untracked entry, and what
 * makes the merged keys disjoint rather than merely last-writer-wins.
 *
 * `/workspace/REVIEW.md` is left out for the same reason the tree leaves it
 * out: it is the review, not a file of it. That only ever comes up when the
 * workspace is itself a repository, which is the one shape where the review
 * file is inside one.
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
 * HEAD. A repository the revision names nothing in is absent from the result,
 * which leaves it compared against its own working tree: a workspace holding
 * one repository on a branch and another that never heard of it is an ordinary
 * shape.
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
