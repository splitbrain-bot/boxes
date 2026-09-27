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

/** The most bytes of a file the file endpoint returns. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The most bytes read of REVIEW.md, and of any file that is hashed. */
export const MAX_REVIEW_BYTES = 8 * 1024 * 1024;

/** Why {@link resolveInRoot} refused a path. */
type PathRefusal = 'invalid' | 'outside' | 'symlink' | 'missing';

/** A resolved path, or the reason it was refused. */
export type Resolved = { ok: true; path: string } | { ok: false; reason: PathRefusal };

/**
 * Whether a client-supplied relative path is well-formed, checked before
 * anything touches the filesystem.
 *
 * Refuses an empty or overlong path, a NUL byte, an absolute path, a leading
 * backslash, a drive letter, an empty segment and any `..` segment. Slashes and
 * backslashes both separate segments. The check works on whole segments, so a
 * name like `[...slug].astro` stays valid.
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
 * The agent controls the tree, so a link such as `ln -s /data x` could expose
 * the deployment's database and gateway token. The resolved path must lie at or
 * under the root's own realpath, and its final component must not be a symlink.
 *
 * An agent can still race this check against the later open or write, because
 * Node offers no way to open a file beneath a directory atomically. Swapping a
 * directory for a link in between redirects that one read or write to a path
 * the orchestrator's uid can reach.
 *
 * `mustExist` is false for a path about to be written. The file may then be
 * missing, but its parent must resolve inside the root.
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

/** A file that was read, and what had to be left out. */
export interface FileRead {
  /** The text read, up to the cap. */
  content: string;
  /** True when the file was longer than the cap and the rest was dropped. */
  truncated: boolean;
  /** True when the file holds a NUL byte, in which case content is empty. */
  binary: boolean;
  /** The file's real size in bytes, whatever was returned. */
  size: number;
}

/**
 * Reads a text file under a review root, up to `cap` bytes.
 *
 * A NUL byte anywhere in the bytes read marks the file as binary, like git's
 * own heuristic. A binary file comes back with `binary: true` and no content
 * rather than as an error, because the tree lists files the viewer cannot show.
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
  /** The bytes read: at most the cap plus one. */
  buffer: Buffer;
  /** The file's real size in bytes, whatever was returned. */
  size: number;
}

/**
 * Reads at most `cap` bytes of a file, plus the one byte that tells a file
 * ending at the cap from one going past it.
 *
 * It reads through a descriptor, so bytes past the cap are never held in
 * memory. A workspace can hold a log of hundreds of megabytes.
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

/** Splits file content into lines without terminators, tolerating CRLF. */
export function fileLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Writes a file under a review root atomically, and hands it to the agent.
 *
 * The content goes to a temp file that is then renamed, so a reader never sees
 * a half-written file and a crash leaves the previous version. The chown lets
 * the agent edit or delete the file. An existing file keeps its permissions, so
 * a saved shell script stays executable.
 */
export function writeFileAtomic(path: string, content: string): void {
  const { fd, tmp } = openTemp(path);
  try {
    try {
      writeFileSync(fd, content, { encoding: 'utf8' });
      // Mode and owner go through the descriptor, so they land on the opened
      // file. The mode is set here because the umask masks a mode given to open.
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
 * Counts the atomic writes this process has started, so each temp file gets
 * its own name.
 */
let tmpWrites = 0;

/** How many times one atomic write tries to get its temp name to itself. */
const TMP_ATTEMPTS = 5;

/** An open temp file, and the name it is open under. */
interface TempFile {
  /** The open descriptor. */
  fd: number;
  /** The temp file's path. */
  tmp: string;
}

/**
 * Creates the temp file an atomic write goes through, next to its target.
 *
 * The name is predictable and the agent owns the directory, so the agent can
 * plant a link at that name. The open creates the file and follows no link.
 * When the name is taken, by a link or a leftover, the function removes it and
 * tries again.
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
 * Hashes a file's content, or returns '' when there is no file.
 *
 * Callers compare two values of it to notice a change made in between, such as
 * an agent's edit to REVIEW.md or to a file being saved. Only the first
 * {@link MAX_REVIEW_BYTES} bytes, plus one, are hashed.
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
