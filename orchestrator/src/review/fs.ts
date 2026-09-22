import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { chownFdToAgent } from '../workspaces.ts';

/**
 * Contained reads and writes under one root, which for a review is the
 * box's whole workspace.
 *
 * This file holds the symlink-containment invariant, and it holds it alone, so
 * that it stays reviewable. A review serves a whole source tree that an agent
 * controls and has no access control of its own, so the obvious attack is a
 * link: `ln -s /data x` in the workspace would otherwise serve the
 * deployment's database and its gateway token through the file endpoint.
 *
 * The rule is: resolve the client's path with `realpath`, require the result to
 * be at or under the root's own realpath, and refuse a final component that is
 * a symlink at all. A review covers the whole workspace, so a contained path
 * may be in any repository it holds, or in none.
 *
 * Accepted residual: a determined agent can race the check against the open,
 * because Node exposes no way to open a file beneath a directory atomically
 * (there is no `openat`/`RESOLVE_BENEATH` binding). The window is between the
 * `realpath` and the `readFileSync` below. What it buys an attacker is one read
 * of one file that the orchestrator's own uid can read, and closing it costs
 * either a native dependency or an exec per read. Every read here uses this
 * process's own file descriptors — no shell, no argument interpolation — so
 * nothing beyond the read itself follows from winning the race.
 */

/** How much of a file the file endpoint will return. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How large a REVIEW.md may be before it is refused as not one. */
export const MAX_REVIEW_BYTES = 8 * 1024 * 1024;

/** Why a path was refused. Every reason is a 404 to the client. */
type PathRefusal = 'invalid' | 'outside' | 'symlink' | 'missing';

/** A resolved path, or the reason it was refused. */
export type Resolved = { ok: true; path: string } | { ok: false; reason: PathRefusal };

/**
 * Whether a client-supplied relative path is well-formed before anything
 * touches the filesystem.
 *
 * Rejects absolute paths, NUL bytes, Windows drive letters and backslashes, and
 * any `..` segment. A segment rather than the two characters anywhere:
 * `[...slug].astro` is a real filename and has to stay openable, so the check
 * is on segments rather than on the text.
 */
export function validRelativePath(path: string): boolean {
  if (path === '' || path.length > 4096) return false;
  if (path.includes('\0')) return false;
  if (isAbsolute(path) || path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split(/[/\\]/);
  return !segments.some((s) => s === '..' || s === '');
}

/**
 * Resolves a client-supplied path under a review root, or says why not.
 *
 * `mustExist` is false for a path being written to, where the file is allowed
 * not to be there yet — but its parent still has to be inside the root and not
 * reached through a link.
 */
export function resolveInRoot(root: string, relPath: string, mustExist = true): Resolved {
  if (!validRelativePath(relPath)) return { ok: false, reason: 'invalid' };

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, reason: 'missing' };
  }

  const candidate = resolve(rootReal, relPath);
  if (!contains(rootReal, candidate)) return { ok: false, reason: 'outside' };

  // The final component must not be a link, even one that stays inside the
  // root: what it points at can be changed after the tree was listed.
  let stats;
  try {
    stats = lstatSync(candidate);
  } catch {
    if (mustExist) return { ok: false, reason: 'missing' };
    // Not there yet. The parent still has to resolve inside the root, so a
    // link somewhere above it cannot be used to write out of the tree.
    const parent = candidate.slice(0, candidate.lastIndexOf(sep));
    try {
      if (!contains(rootReal, realpathSync(parent))) return { ok: false, reason: 'outside' };
    } catch {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true, path: candidate };
  }
  if (stats.isSymbolicLink()) return { ok: false, reason: 'symlink' };

  // And nothing on the way to it may be a link out of the root either.
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

/** A file that was read, and what had to be left out. */
export interface FileRead {
  content: string;
  /** True when the file was longer than the cap and the rest was dropped. */
  truncated: boolean;
  /** True when the file holds a NUL byte, in which case content is empty. */
  binary: boolean;
  /** The file's real size in bytes, whatever was returned. */
  size: number;
}

/**
 * Reads a text file under a review root, capped and refusing binaries.
 *
 * A NUL byte in the first chunk is what says "binary": the same heuristic git
 * uses, and cheaper and more honest than a content-type guess. A binary file
 * comes back as `binary: true` with no content rather than as an error, because
 * the tree legitimately lists files the viewer cannot show.
 */
export function readTextFile(path: string, cap = MAX_FILE_BYTES): FileRead {
  const { buffer, size } = readCapped(path, cap);
  const slice = buffer.length > cap ? buffer.subarray(0, cap) : buffer;
  if (slice.includes(0)) return { content: '', truncated: false, binary: true, size };
  return {
    content: slice.toString('utf8'),
    truncated: buffer.length > cap,
    binary: false,
    size,
  };
}

/** What one capped read got, and how large the file it came from is. */
interface CappedRead {
  buffer: Buffer;
  /** The file's real size in bytes, whatever was returned. */
  size: number;
}

/**
 * At most `cap` bytes of a file, plus the one byte that tells a file ending at
 * the cap from one going past it.
 *
 * Through a descriptor rather than with `readFileSync`, because the cap is
 * only worth having if the bytes past it are never held: a workspace holds
 * whatever the agent generated, and a hundred-megabyte log is an ordinary
 * thing to tap in a file tree.
 */
function readCapped(path: string, cap: number): CappedRead {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.allocUnsafe(Math.min(size, cap) + 1);
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, null);
      if (got === 0) break;
      read += got;
    }
    return { buffer: buffer.subarray(0, read), size };
  } finally {
    closeSync(fd);
  }
}

/** A file's lines, without terminators, for taking an annotation's context. */
export function fileLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Writes a file under a review root atomically, and hands it to the agent.
 *
 * Temp file then rename, so a reader — the agent, reading REVIEW.md — never
 * sees a half-written document, and so a crash mid-write leaves the previous
 * version rather than a truncated one. The chown is what lets the agent edit
 * or delete what was written.
 *
 * A file that is already there keeps its permissions, because the rename
 * replaces it whole: without this, saving a shell script from the review would
 * take its executable bit off.
 */
export function writeFileAtomic(path: string, content: string): void {
  const { fd, tmp } = openTemp(path);
  try {
    try {
      writeFileSync(fd, content, { encoding: 'utf8' });
      // Through the descriptor, so the mode and the owner land on the file
      // that was opened rather than on whatever the name holds by now. The
      // mode comes after the write rather than through the open, which the
      // umask masks.
      fchmodSync(fd, currentMode(path));
      chownFdToAgent(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

/**
 * How many atomic writes this process has started, which together with its pid
 * names a temp file no other write can be holding.
 */
let tmpWrites = 0;

/** How many times one atomic write tries to get its temp name to itself. */
const TMP_ATTEMPTS = 5;

/** An open temp file, and the name it is open under. */
interface TempFile {
  fd: number;
  tmp: string;
}

/**
 * Creates the temp file an atomic write goes through, next to its target.
 *
 * The name is predictable and the directory is the agent's, so the agent can
 * be holding it: a link planted there would otherwise take the write, the
 * mode and the chown to whatever it points at. The open creates the file
 * itself and follows nothing, so a name that is taken — by a link or by a
 * leftover — is refused, removed, and tried again.
 */
function openTemp(path: string): TempFile {
  const tmp = `${path}.${process.pid}.${tmpWrites++}.tmp`;
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  for (let attempt = 0; attempt < TMP_ATTEMPTS; attempt++) {
    try {
      return { fd: openSync(tmp, flags, 0o644), tmp };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ELOOP') throw err;
      try {
        unlinkSync(tmp);
      } catch {
        // gone on its own, or not a file this can clear
      }
    }
  }
  throw new Error(`could not get a clean temp file to write ${path}`);
}

/** The permissions a file already has, or the default for a new one. */
function currentMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
}

/** Removes a file, reporting whether there was one. */
export function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A hash of a file's content, or '' when there is no file.
 *
 * Used as a guard rather than as a fingerprint: every REVIEW.md mutation reads
 * it before and after applying, so an edit the agent made in between is caught
 * instead of overwritten. What it is compared against is a previous value of
 * itself, so the algorithm matters only in being cheap and stable.
 *
 * At most {@link MAX_REVIEW_BYTES} are read, which is the whole of REVIEW.md
 * and of every file the review will serve, and bounds what hashing a huge one
 * costs.
 */
export function fileHash(path: string): string {
  try {
    const { buffer } = readCapped(path, MAX_REVIEW_BYTES);
    return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  } catch {
    return '';
  }
}

/** Whether a path is a directory this process can read. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
