import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { validRelativePath } from '../../shared/files.ts';

/** Why {@link resolveInRoot} refused a path. */
export type PathRefusal = 'invalid' | 'outside' | 'symlink' | 'missing';

/** A resolved path, or the reason it was refused. */
export type Resolved = { ok: true; path: string } | { ok: false; reason: PathRefusal };

/**
 * Resolves a client-supplied path under a root, or says why not.
 *
 * The resolved path must lie at or under the root's own realpath, and its
 * final component must not be a symlink. This keeps an operation inside the
 * workspace. The empty path is the root itself.
 *
 * `mustExist` is false for a path about to be written. The file may then be
 * missing, but its parent must resolve inside the root.
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

  // A link is refused even when it stays inside the root, because its target
  // can change after the tree was listed.
  let stats;
  try {
    stats = lstatSync(candidate);
  } catch {
    if (mustExist) return { ok: false, reason: 'missing' };
    // Not there yet. The parent must resolve inside the root, so a link above
    // it cannot lead a write out of the tree.
    const parent = candidate.slice(0, candidate.lastIndexOf(sep));
    try {
      if (!contains(rootReal, realpathSync(parent))) return { ok: false, reason: 'outside' };
    } catch {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true, path: candidate };
  }
  if (stats.isSymbolicLink()) return { ok: false, reason: 'symlink' };

  // No directory on the way may be a link out of the root.
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!contains(rootReal, real)) return { ok: false, reason: 'outside' };

  return { ok: true, path: real };
}

/** Whether `path` is `root` itself or sits under it. */
function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
