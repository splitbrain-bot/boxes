import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewDirEntry, ReviewFileStatus } from '../../../shared/types.ts';
import type { RepoMap } from './repos.ts';

/**
 * The file tree a review browses, one directory at a time.
 *
 * Opening a folder is one `readdirSync` of that folder plus a scan of the two
 * maps a review holds: git status per path, and comment count per path. So the
 * cost of a folder is the size of that folder, and a dependency tree beside the
 * code costs nothing until somebody opens it.
 *
 * What is listed is every file under the workspace, whether git tracks it,
 * ignores it, or has never seen it. The listing steps over version-control
 * metadata and Boxes' own scratch. Git contributes only what a directory
 * cannot show, which is a file the change deleted.
 */

/** The annotation file, written at the workspace root. Not part of the review. */
export const REVIEW_FILE = 'REVIEW.md';

/**
 * Directory names the listing steps over, because they hold nothing a person
 * reviews: a version control system's own metadata, and Boxes' scratch inside
 * a workspace, which holds the files the user attached to a prompt.
 */
const SKIPPED_DIRS = new Set(['.git', '.svn', '.hg', '.boxes']);

/**
 * How many entries one directory may hold before the rest are left out.
 *
 * A generated directory with more of them in it than this is one no phone can
 * paint anyway, and the cap is per directory rather than over the whole
 * workspace, so a huge folder costs the reviewer that folder and nothing else.
 */
export const MAX_DIR_ENTRIES = 2000;

/** One child of a directory, as the filesystem reports it. */
export interface DirChild {
  /** Its own name inside the directory. */
  name: string;
  /** True for a directory. */
  isDir: boolean;
}

/** Whether any segment of a path names a directory the listing steps over. */
function inSkippedDir(path: string): boolean {
  return path.split('/').some((segment) => SKIPPED_DIRS.has(segment));
}

/**
 * Whether the review lists a file at this workspace-relative path.
 *
 * The listing's own rule, asked about one path: not inside version-control
 * metadata or Boxes' scratch, and not the review's own file at the workspace
 * root. This is what the file endpoint serves by, so it offers exactly what a
 * directory offered. Containment is fs.ts's and this says nothing about it.
 */
export function listedFile(relPath: string): boolean {
  return !inSkippedDir(relPath) && relPath !== REVIEW_FILE;
}

/**
 * Whether the review browses a directory at this workspace-relative path.
 *
 * The same rule without the part about the review file.
 */
export function listedDir(relDir: string): boolean {
  return !inSkippedDir(relDir);
}

/**
 * Reads one directory of the workspace into its children.
 *
 * Read with `withFileTypes`, and a symlink is neither listed nor followed: the
 * tree is agent-controlled, and a link to `/` would otherwise be browsable.
 * Reading the file it points at is fs.ts's decision, and it refuses. A
 * directory that cannot be read lists nothing rather than failing.
 */
export function readDir(root: string, relDir: string): DirChild[] {
  let entries;
  try {
    entries = readdirSync(relDir === '' ? root : join(root, relDir), { withFileTypes: true });
  } catch {
    return []; // unreadable directory: empty, not fatal
  }

  const children: DirChild[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(name)) continue;
      children.push({ name, isDir: true });
    } else if (entry.isFile()) {
      // Only the one at the root: a REVIEW.md deeper in the tree is a file of
      // the project under review like any other.
      if (relDir === '' && name === REVIEW_FILE) continue;
      children.push({ name, isDir: false });
    }
    // Anything else — a symlink, a socket, a device — is not listed.
    // Following one would leave the tree.
  }
  return children;
}

/**
 * One directory of the review, as the API reports it.
 *
 * Merges three things into one list: the children on disk, the review's git
 * statuses and its comment counts. A file carries its own status and its own
 * count. A folder carries what its whole subtree holds — whether git reports
 * something in it changed, and whether the review has a comment in it — which
 * is a prefix scan of the two maps rather than a walk of the folder.
 *
 * A directory read can only name what is on disk, so a file the change deleted
 * is merged in from the status map instead. That is also where a folder with
 * nothing left in it comes from: the change emptied it, and the files it held
 * are still part of what is under review.
 *
 * Folders come first, then files, each in name order.
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
