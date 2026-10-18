import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { resolve, sep } from 'node:path';
import { validRelativePath } from '../../shared/files.ts';

/** The reason that {@link resolveInRoot} refuses a path. */
export type PathRefusal = 'invalid' | 'outside' | 'symlink' | 'missing';

/** A resolved path, or the reason it was refused. */
export type Resolved = { ok: true; path: string } | { ok: false; reason: PathRefusal };

/**
 * Resolves a path from a client under a root, or gives the reason for the refusal.
 *
 * The resolved path must be at or under the realpath of the root, and its final component must not be a symlink. The
 * empty path is the root itself.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @param mustExist False for a path that a write can create. The file can then be missing, but its parent must resolve
 *   inside the root.
 * @returns The resolved path, or the reason for the refusal.
 */
export function resolveInRoot(root: string, relPath: string, mustExist = true): Resolved {
  if (relPath !== '' && !validRelativePath(relPath)) return { ok: false, reason: 'invalid' };

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (relPath === '') return { ok: true, path: rootReal };

  const candidate = resolve(rootReal, relPath);
  if (!contains(rootReal, candidate)) return { ok: false, reason: 'outside' };

  let stats: Stats;
  try {
    stats = lstatSync(candidate);
  } catch {
    if (mustExist) return { ok: false, reason: 'missing' };
    // The parent of a new file must resolve inside the root, so a link above it cannot lead a write out of the root.
    const parent = candidate.slice(0, candidate.lastIndexOf(sep));
    try {
      if (!contains(rootReal, realpathSync(parent))) return { ok: false, reason: 'outside' };
    } catch {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true, path: candidate };
  }
  // A link inside the root is also refused, because its target can change after the listing.
  if (stats.isSymbolicLink()) return { ok: false, reason: 'symlink' };

  // A directory on the path must not be a link out of the root.
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!contains(rootReal, real)) return { ok: false, reason: 'outside' };

  return { ok: true, path: real };
}

/**
 * Checks if a path is the root or is under the root.
 *
 * @param root The root directory.
 * @param path The path to check.
 * @returns True when `path` is `root` or is under `root`.
 */
function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
