import type { DirChild } from '../../../shared/files.ts';
import type { ReviewDirEntry, ReviewFileStatus } from '../../../shared/types.ts';
import type { RepoMap } from './repos.ts';

/** The name of the review file at the workspace root. The review tree does not list it. */
export const REVIEW_FILE = 'REVIEW.md';

/**
 * The directory names that the listing skips. They are the version control metadata, and the Boxes
 * directory that holds files attached to prompts.
 */
const SKIPPED_DIRS = new Set(['.git', '.svn', '.hg', '.boxes']);

export { type DirChild, MAX_DIR_ENTRIES } from '../../../shared/files.ts';

/**
 * Checks if a segment of a path names a directory that the listing skips.
 *
 * @param path The workspace-relative path.
 * @returns True when a segment is in {@link SKIPPED_DIRS}.
 */
function inSkippedDir(path: string): boolean {
  return path.split('/').some((segment) => SKIPPED_DIRS.has(segment));
}

/**
 * Checks if the review lists a file at a workspace-relative path.
 *
 * The file endpoints use this rule. The function does not check that the path
 * is inside the workspace.
 *
 * @param relPath The workspace-relative path of the file.
 * @returns True when the review lists the file.
 */
export function listedFile(relPath: string): boolean {
  return !inSkippedDir(relPath) && relPath !== REVIEW_FILE;
}

/**
 * Checks if the review lists a directory at a workspace-relative path.
 *
 * @param relDir The workspace-relative path of the directory.
 * @returns True when the review lists the directory.
 */
export function listedDir(relDir: string): boolean {
  return !inSkippedDir(relDir);
}

/**
 * Filters the children of one directory of the workspace to those that the review lists. The
 * function removes the skipped directories, and the review file at the
 * workspace root.
 *
 * @param relDir The workspace-relative path of the directory.
 * @param entries The children on disk.
 * @returns The children that the review lists.
 */
export function reviewChildren(relDir: string, entries: readonly DirChild[]): DirChild[] {
  return entries.filter((entry) =>
    entry.isDir
      ? !SKIPPED_DIRS.has(entry.name)
      : // A REVIEW.md deeper in the tree is a project file like any other.
        !(relDir === '' && entry.name === REVIEW_FILE),
  );
}

/**
 * Builds the entries of one directory of the review, as the API reports them.
 *
 * The function merges the children on disk with the git statuses and comment
 * counts of the review. A file gets its own status and comment count. A folder gets flags for
 * its whole subtree. It gets `changed` when git reports a change in it, and `commented`
 * when it holds a comment. A folder at a repository root gets `repo`.
 *
 * Files that the change deleted come from the status map, because they are not on
 * disk. A folder that is missing on disk also comes from the status map when it holds a deleted file, unless the
 * review skips the folder.
 *
 * @param relDir The workspace-relative path of the directory, or '' for the root.
 * @param children The children that the review lists.
 * @param statuses The git statuses of the workspace, by workspace-relative path.
 * @param counts The number of comments of each annotated file, by workspace-relative path.
 * @param map The repositories of the workspace.
 * @returns The entries. Folders come first, then files, each in name order.
 */
export function dirEntries(
  relDir: string,
  children: DirChild[],
  statuses: Record<string, ReviewFileStatus>,
  counts: Map<string, number>,
  map: RepoMap,
): ReviewDirEntry[] {
  const prefix = relDir === '' ? '' : `${relDir}/`;
  const folders = new Map<string, ReviewDirEntry>();
  const files = new Map<string, ReviewDirEntry>();

  for (const child of children) {
    const entry: ReviewDirEntry = {
      name: child.name,
      path: prefix + child.name,
      isDir: child.isDir,
    };
    (child.isDir ? folders : files).set(child.name, entry);
  }

  for (const [path, status] of Object.entries(statuses)) {
    const rest = under(prefix, path);
    if (rest === null) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      let file = files.get(rest);
      if (!file) {
        if (status !== 'deleted' || !listedFile(path)) continue;
        file = { name: rest, path, isDir: false };
        files.set(rest, file);
      }
      file.status = status;
    } else {
      const name = rest.slice(0, slash);
      let folder = folders.get(name);
      if (!folder) {
        if (status !== 'deleted' || SKIPPED_DIRS.has(name)) continue;
        folder = { name, path: prefix + name, isDir: true };
        folders.set(name, folder);
      }
      folder.changed = true;
    }
  }

  for (const [path, count] of counts) {
    const rest = under(prefix, path);
    if (rest === null) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const file = files.get(rest);
      if (file) file.comments = count;
    } else {
      const folder = folders.get(rest.slice(0, slash));
      if (folder) folder.commented = true;
    }
  }

  for (const folder of folders.values()) {
    if (map.at(folder.path) !== null) folder.repo = true;
  }

  return [...sorted(folders), ...sorted(files)];
}

/**
 * Gives the rest of a path under a directory prefix.
 *
 * @param prefix The directory with a trailing slash, or '' for the root.
 * @param path The workspace-relative path.
 * @returns The rest of the path, or null when the path is not under the prefix.
 */
function under(prefix: string, path: string): string | null {
  if (prefix === '') return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/**
 * Sorts the entries of one kind by name.
 *
 * @param entries The entries by name.
 * @returns The entries in name order.
 */
function sorted(entries: Map<string, ReviewDirEntry>): ReviewDirEntry[] {
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Checks if the change deleted a file under a directory.
 *
 * @param statuses The git statuses of the workspace, by workspace-relative path.
 * @param relDir The workspace-relative path of the directory.
 * @returns True when a file under the directory has the status deleted.
 */
export function holdsDeleted(statuses: Record<string, ReviewFileStatus>, relDir: string): boolean {
  const prefix = `${relDir}/`;
  return Object.entries(statuses).some(
    ([path, status]) => status === 'deleted' && path.startsWith(prefix),
  );
}
