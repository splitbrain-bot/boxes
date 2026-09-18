import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoMap } from './repos.ts';

/**
 * The file tree a review browses.
 *
 * A port of the desktop tool's `internal/filetree`, with one addition the
 * desktop tool does not need: an entry cap, because a Boxes workspace can hold
 * an agent's whole dependency tree, and a phone on a slow link is the client.
 *
 * `buildTree` is pure and takes a flat path list. `walkPaths` is the one
 * function here that touches the filesystem.
 *
 * The tree is every file under the workspace that a person could read,
 * whether git tracks it, ignores it, or has never seen it: one walk of the
 * whole workspace, stepping over version-control metadata and Boxes' own
 * scratch, leaving out binaries. Git contributes only what the walk cannot
 * find, which is a file the change deleted.
 */

/** The annotation file, written at the workspace root. Not part of the review. */
export const REVIEW_FILE = 'REVIEW.md';

/**
 * Directory names the walk steps over, because they hold nothing a person
 * reviews: a version control system's own metadata, and Boxes' scratch inside
 * a workspace, which holds the files the user attached to a prompt.
 */
const UNWALKED_DIRS = new Set(['.git', '.svn', '.hg', '.boxes']);

/**
 * File extensions taken as binary, lowercased and with the dot. A file with
 * one of them is left out of the tree.
 */
const IGNORED_EXTS = new Set([
  '.exe',
  '.bin',
  '.so',
  '.dylib',
  '.png',
  '.jpg',
  '.gif',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
]);

/**
 * How many entries a tree may hold before it is cut short.
 *
 * A truncated tree is still usable: the paths that made it in are browsable,
 * and the response says it was cut.
 */
export const MAX_ENTRIES = 20_000;

/** One file or directory in the tree. */
export interface TreeEntry {
  name: string;
  /** Path relative to the workspace, slash-separated. */
  path: string;
  isDir: boolean;
  /** Absent for files. */
  children?: TreeEntry[];
  /** True on the directory a repository is rooted at. Absent everywhere else. */
  repo?: boolean;
}

/** A built tree, and whether the entry cap cut it short. */
export interface Tree {
  entries: TreeEntry[];
  truncated: boolean;
}

/**
 * Whether a file is binary by its extension, and so not worth listing. A
 * reviewer cannot read it, and the view cannot show it.
 */
function isBinary(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && IGNORED_EXTS.has(name.slice(dot).toLowerCase());
}

/** A node while a tree is being assembled. */
interface Node {
  entry: TreeEntry;
  children: Map<string, Node>;
}

/** Builds a tree from a flat list of file paths, relative and slash-separated. */
export function buildTree(paths: string[]): TreeEntry[] {
  const root: Node = { entry: { name: '', path: '', isDir: true }, children: new Map() };

  for (const path of paths) {
    const parts = path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i === parts.length - 1) {
        if (!current.children.has(part)) {
          current.children.set(part, {
            entry: { name: part, path, isDir: false },
            children: new Map(),
          });
        }
      } else {
        let next = current.children.get(part);
        if (!next) {
          next = {
            entry: { name: part, path: parts.slice(0, i + 1).join('/'), isDir: true },
            children: new Map(),
          };
          current.children.set(part, next);
        }
        current = next;
      }
    }
  }

  return collect(root);
}

/**
 * Turns assembled nodes into entries: directories first, then names in order,
 * and an empty directory dropped rather than shown.
 */
function collect(node: Node): TreeEntry[] {
  const result: TreeEntry[] = [];
  for (const child of node.children.values()) {
    if (child.entry.isDir) {
      const children = collect(child);
      if (children.length === 0) continue;
      child.entry.children = children;
    }
    result.push(child.entry);
  }
  result.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return result;
}

/**
 * Walks a directory into a path list.
 *
 * Every file is listed whatever git thinks of it: a tracked one, an untracked
 * one and one the project's ignore rules cover are all things a person may
 * need to read. The walk steps over {@link UNWALKED_DIRS} and leaves out
 * binaries, and nothing else. `skipDir` is asked about every directory before
 * it is descended into, the root included, for a caller with a reason of its
 * own to stay out of one.
 *
 * Directories are read with `withFileTypes`, and a symlink is skipped rather
 * than followed: the tree is agent-controlled, and a link to `/` would
 * otherwise be walked. Reading the file it points at is fs.ts's decision, and
 * it refuses.
 */
export function walkPaths(
  root: string,
  cap: number = MAX_ENTRIES,
  skipDir: (relDir: string) => boolean = () => false,
): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let truncated = false;

  const walk = (absDir: string, relDir: string): void => {
    if (truncated || skipDir(relDir)) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skipped, not fatal
    }
    for (const entry of entries) {
      if (paths.length >= cap) {
        truncated = true;
        return;
      }
      const name = entry.name;
      // Only the one at the root: a REVIEW.md deeper in the tree is a file of
      // the project under review like any other.
      if (relDir === '' && name === REVIEW_FILE) continue;
      const rel = relDir === '' ? name : `${relDir}/${name}`;

      if (entry.isDirectory()) {
        if (UNWALKED_DIRS.has(name)) continue;
        walk(join(absDir, name), rel);
      } else if (entry.isFile()) {
        if (isBinary(rel)) continue;
        paths.push(rel);
      }
      // Anything else — a symlink, a socket, a device — is not walked and not
      // listed. Following one would leave the tree.
    }
  };

  walk(root, '');
  return { paths, truncated };
}

/**
 * One workspace-relative tree: a walk of the whole workspace.
 *
 * The repositories play no part in what is listed. A walk finds every file
 * once, so nothing has to be merged or deduplicated, and a file inside a
 * repository shows whether or not the project's ignore rules cover it. The
 * map is here for where the workspace is.
 *
 * The list is sorted before the cap is applied, so a truncated tree is
 * deterministic.
 */
export async function reviewTree(map: RepoMap): Promise<Tree> {
  const walked = walkPaths(map.workspace, MAX_ENTRIES);
  const paths = walked.paths.filter((path) => path !== REVIEW_FILE).sort();
  const truncated = walked.truncated || paths.length > MAX_ENTRIES;
  return {
    entries: buildTree(truncated ? paths.slice(0, MAX_ENTRIES) : paths),
    truncated,
  };
}

/**
 * Marks the directories repositories are rooted at, in place.
 *
 * Separate from building the tree because {@link withDeleted} rebuilds it, and
 * a mark that had to survive a rebuild would have to be threaded through
 * `buildTree` — which is pure, takes paths, and is the better for knowing
 * nothing about repositories.
 */
export function markRepoRoots(entries: TreeEntry[], map: RepoMap): TreeEntry[] {
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (map.at(entry.path) !== null) entry.repo = true;
    markRepoRoots(entry.children ?? [], map);
  }
  return entries;
}

/**
 * Puts the files a change removed back into the tree.
 *
 * Neither `git ls-files` nor a walk can name a file that is no longer on disk,
 * so without this a deletion is the one kind of change a review cannot show —
 * and once it is committed, the file leaves the tree the moment it starts to
 * matter. The paths come from the status map, which reports a deletion whether
 * it is staged, unstaged or committed against the base.
 */
export function withDeleted(entries: TreeEntry[], deleted: string[]): TreeEntry[] {
  const paths = treePaths(entries);
  const gone = deleted.filter(
    (path) => !paths.has(path) && path !== REVIEW_FILE && !isBinary(path),
  );
  if (gone.length === 0) return entries;
  return buildTree([...paths, ...gone]);
}

/** Every file path in a tree, for validating a client-supplied path against it. */
export function treePaths(entries: TreeEntry[], into: Set<string> = new Set()): Set<string> {
  for (const entry of entries) {
    if (entry.isDir) treePaths(entry.children ?? [], into);
    else into.add(entry.path);
  }
  return into;
}
