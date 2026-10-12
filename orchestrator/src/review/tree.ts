import type { DirChild } from '../../../shared/files.ts';
import type { ReviewDirEntry, ReviewFileStatus } from '../../../shared/types.ts';
import type { RepoMap } from './repos.ts';

/** The review file at the workspace root, which the tree does not list. */
export const REVIEW_FILE = 'REVIEW.md';

/**
 * Directory names the listing skips: version control metadata, and the Boxes
 * directory that holds files attached to prompts.
 */
const SKIPPED_DIRS = new Set(['.git', '.svn', '.hg', '.boxes']);

export { MAX_DIR_ENTRIES, type DirChild } from '../../../shared/files.ts';

/** Whether any segment of a path names a directory the listing steps over. */
function inSkippedDir(path: string): boolean {
  return path.split('/').some((segment) => SKIPPED_DIRS.has(segment));
}

/**
 * Whether the review lists a file at this workspace-relative path.
 *
 * It applies the listing's rule to one path: the path is not inside a skipped
 * directory, and it is not the review file at the workspace root. The file
 * endpoints serve by this rule. It does not check containment.
 */
export function listedFile(relPath: string): boolean {
  return !inSkippedDir(relPath) && relPath !== REVIEW_FILE;
}

/**
 * Whether the review browses a directory at this workspace-relative path: the
 * path is not inside a skipped directory.
 */
export function listedDir(relDir: string): boolean {
  return !inSkippedDir(relDir);
}

/**
 * The children of one directory of the workspace that the review lists.
 *
 * The file service lists only this directory, with its plain files and
 * directories. This leaves out the directories the listing skips and the
 * review file at the workspace root.
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
 * One directory of the review, as the API reports it.
 *
 * It merges the children on disk with the review's git statuses and comment
 * counts. A file gets its own status and comment count. A folder gets flags for
 * its whole subtree: `changed` when git reports a change in it, and `commented`
 * when it holds a comment. A folder at a repository root gets `repo`.
 *
 * Files the change deleted come from the status map, because they are not on
 * disk. So do folders the change emptied. Folders come first, then files, each
 * in name order.
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
        if (status !== 'deleted') continue;
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

/** What is left of a path under a directory prefix, or null when it is elsewhere. */
function under(prefix: string, path: string): string | null {
  if (prefix === '') return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** The entries of one kind, in name order. */
function sorted(entries: Map<string, ReviewDirEntry>): ReviewDirEntry[] {
  return [...entries.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** Whether the change deleted a file somewhere under a directory. */
export function holdsDeleted(statuses: Record<string, ReviewFileStatus>, relDir: string): boolean {
  const prefix = `${relDir}/`;
  return Object.entries(statuses).some(
    ([path, status]) => status === 'deleted' && path.startsWith(prefix),
  );
}
