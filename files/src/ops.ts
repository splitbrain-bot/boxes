import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  type Dirent,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  type ReadStream,
  readdirSync,
  readSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type FindReposReply,
  type FindReposRequest,
  HASH_BYTES,
  type ListReply,
  MAX_CREATE_COLLISIONS,
  MAX_DIR_ENTRIES,
  type StatReply,
  validRelativePath,
} from '../../shared/files.ts';
import { resolveInRoot } from './paths.ts';

/** A failed operation, with the HTTP status that reports it. */
export class FileError extends Error {
  /** The HTTP status of the reply. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolves a client-supplied path under the root, or throws the refusal.
 *
 * A malformed path is a 400, a missing one a 404, and a path that leaves the
 * root or ends in a link a 403.
 */
function resolved(root: string, relPath: string, mustExist = true): string {
  const r = resolveInRoot(root, relPath, mustExist);
  if (r.ok) return r.path;
  if (r.reason === 'invalid') throw new FileError(400, `invalid path: ${relPath}`);
  if (r.reason === 'missing') throw new FileError(404, `not found: ${relPath}`);
  throw new FileError(403, `refused (${r.reason}): ${relPath}`);
}

/**
 * The status that reports a failed filesystem call, from its error code.
 * An error without a known code is rethrown as it is.
 */
function asFileError(err: unknown, relPath: string): FileError {
  if (err instanceof FileError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new FileError(404, `not found: ${relPath}`);
  if (code === 'EACCES' || code === 'EPERM') return new FileError(403, `no access: ${relPath}`);
  if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'EEXIST') {
    return new FileError(409, `conflict (${code}): ${relPath}`);
  }
  throw err;
}

/**
 * The plain files and directories in one directory, up to
 * {@link MAX_DIR_ENTRIES}.
 *
 * Symlinks are left out, because their target can change after the listing.
 */
export function listDir(root: string, relDir: string): ListReply {
  const dir = resolved(root, relDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw asFileError(err, relDir);
  }
  const children = entries
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  return {
    entries: children.slice(0, MAX_DIR_ENTRIES),
    truncated: children.length > MAX_DIR_ENTRIES,
  };
}

/**
 * The directories under the root that hold a `.git` file or directory,
 * breadth first.
 *
 * The walk skips the pruned names and stops at the depth, the count of read
 * directories or the count of finds. Breadth first means a limit leaves the
 * deepest directories unread, where dependency trees sit. The walk never
 * follows a link.
 */
export function findRepos(root: string, limits: FindReposRequest): FindReposReply {
  const pruned = new Set(limits.pruned);
  const found: string[] = [];
  let scanned = 0;
  let queue: Array<{ absolute: string; path: string }> = [
    { absolute: resolved(root, ''), path: '' },
  ];

  for (let depth = 0; depth <= limits.maxDepth && queue.length > 0; depth++) {
    const next: typeof queue = [];
    for (const dir of queue) {
      if (scanned >= limits.maxScanned || found.length >= limits.maxRepos) return { paths: found };
      scanned++;

      let entries: Dirent[];
      try {
        entries = readdirSync(dir.absolute, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: skipped, not fatal
      }

      for (const entry of entries) {
        // A `.git` file marks a linked worktree or a submodule.
        if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
          found.push(dir.path);
        }
        // `isDirectory` is false for a symlink.
        if (!entry.isDirectory() || pruned.has(entry.name)) continue;
        next.push({
          absolute: join(dir.absolute, entry.name),
          path: dir.path === '' ? entry.name : `${dir.path}/${entry.name}`,
        });
      }
    }
    queue = next;
  }

  return { paths: found };
}

/** The type and the size of one path. */
export function statPath(root: string, relPath: string): StatReply {
  const path = resolved(root, relPath);
  try {
    const stats = statSync(path);
    const type = stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : 'other';
    return { type, size: stats.size };
  } catch (err) {
    throw asFileError(err, relPath);
  }
}

/** What one capped read got. */
export interface FileRead {
  /** The bytes up to the cap. Empty for a binary file. */
  content: Buffer;
  /** True when the file was longer than the cap and the rest was dropped. */
  truncated: boolean;
  /** True when the bytes up to the cap hold a NUL byte. */
  binary: boolean;
  /** The file's real size in bytes. */
  size: number;
  /** The hash of the file, as {@link hashOf} gives it. */
  hash: string;
}

/**
 * Reads one plain file, up to `cap` bytes, and hashes it.
 *
 * A NUL byte anywhere in the bytes up to the cap marks the file as binary,
 * like git's own heuristic. A binary file comes back with no content rather
 * than as an error, because the tree lists files the viewer cannot show.
 */
export function readFile(root: string, relPath: string, cap: number): FileRead {
  const path = resolved(root, relPath);
  let buffer: Buffer;
  let size: number;
  try {
    ({ buffer, size } = readCapped(path, Math.max(cap, HASH_BYTES)));
  } catch (err) {
    throw asFileError(err, relPath);
  }
  const hash = digest(buffer.subarray(0, HASH_BYTES + 1));
  const slice = buffer.subarray(0, cap);
  if (slice.includes(0)) {
    return { content: Buffer.alloc(0), truncated: false, binary: true, size, hash };
  }
  return { content: slice, truncated: buffer.length > cap, binary: false, size, hash };
}

/** What one capped read got, and how large the file it came from is. */
interface CappedRead {
  /** The bytes read: at most the cap plus one. */
  buffer: Buffer;
  /** The file's real size in bytes. */
  size: number;
}

/**
 * Reads at most `cap` bytes of a plain file, plus the one byte that tells a
 * file ending at the cap from one going past it.
 *
 * It reads through a descriptor, so bytes past the cap are never held in
 * memory. A workspace can hold a log of hundreds of megabytes.
 */
function readCapped(path: string, cap: number): CappedRead {
  const fd = openSync(path, 'r');
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new FileError(409, 'not a file');
    const buffer = Buffer.allocUnsafe(Math.min(stats.size, cap) + 1);
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, null);
      if (got === 0) break;
      read += got;
    }
    return { buffer: buffer.subarray(0, read), size: stats.size };
  } finally {
    closeSync(fd);
  }
}

/** The hash of some bytes, as {@link hashOf} reports it. */
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * Hashes a file's content, or returns '' when there is no plain file.
 *
 * Only the first {@link HASH_BYTES} bytes, plus one, are hashed.
 */
function hashOf(path: string): string {
  try {
    return digest(readCapped(path, HASH_BYTES).buffer);
  } catch {
    return '';
  }
}

/** One plain file opened for a stream of its whole content. */
export interface RawFile {
  /** The size in bytes at the open. */
  size: number;
  /** The content. */
  stream: ReadStream;
}

/** Opens one plain file to stream its whole content. */
export function openRaw(root: string, relPath: string): RawFile {
  const path = resolved(root, relPath);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    throw asFileError(err, relPath);
  }
  const stats = fstatSync(fd);
  if (!stats.isFile()) {
    closeSync(fd);
    throw new FileError(404, `not a file: ${relPath}`);
  }
  return { size: stats.size, stream: createReadStream('', { fd }) };
}

/**
 * What a write expects of the file it replaces: its hash, or that there is
 * no file yet.
 */
export type WriteCondition = { hash: string } | { absent: true };

/**
 * Replaces one file atomically with a stream of bytes, and returns the hash
 * of the new content.
 *
 * The bytes go to a temp file that is then renamed, so a reader never sees a
 * half-written file and a crash leaves the previous version. A file that
 * must be absent is linked into place, so a file that appeared in the
 * meantime is not replaced. A file whose hash does not match is not replaced
 * either. Both are a 412. An existing file keeps its permissions, so a saved
 * shell script stays executable.
 */
export async function writeFile(
  root: string,
  relPath: string,
  body: Readable,
  condition: WriteCondition,
): Promise<string> {
  const path = resolved(root, relPath, false);
  const existing = statOrNull(path);
  if (existing && !existing.isFile()) throw new FileError(409, `not a file: ${relPath}`);

  const tmp = await streamToTemp(path, body);
  try {
    const hash = hashOf(tmp);
    if ('absent' in condition) {
      try {
        linkSync(tmp, path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FileError(412, `exists: ${relPath}`);
        }
        throw asFileError(err, relPath);
      }
      unlinkSync(tmp);
      return hash;
    }
    if (hashOf(path) !== condition.hash) throw new FileError(412, `changed: ${relPath}`);
    renameSync(tmp, path);
    return hash;
  } catch (err) {
    removeQuietly(tmp);
    throw asFileError(err, relPath);
  }
}

/**
 * Writes a stream of bytes under the first free name in a directory: `name`,
 * `name-2`, `name-3`, and so on. Returns the name used.
 *
 * Each name is taken with a link, so two creates of the same name at once
 * land on two files, and no reader sees a half-written file.
 */
export async function createUnderFreeName(
  root: string,
  relDir: string,
  name: string,
  body: Readable,
): Promise<string> {
  if (!validRelativePath(name) || /[/\\]/.test(name)) {
    throw new FileError(400, `invalid name: ${name}`);
  }
  const dir = resolved(root, relDir);
  if (!statOrNull(dir)?.isDirectory()) throw new FileError(409, `not a directory: ${relDir}`);

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const tmp = await streamToTemp(join(dir, name), body, 0o644);
  try {
    for (let n = 1; n <= MAX_CREATE_COLLISIONS; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
      try {
        linkSync(tmp, join(dir, candidate));
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw asFileError(err, relDir);
      }
    }
    throw new FileError(409, `too many files named ${name}`);
  } finally {
    removeQuietly(tmp);
  }
}

/** Removes one file. A missing file is a 404. */
export function removeFile(root: string, relPath: string): void {
  const path = resolved(root, relPath);
  try {
    unlinkSync(path);
  } catch (err) {
    throw asFileError(err, relPath);
  }
}

/**
 * Creates one directory, or leaves one that is already there. Its parent must
 * exist. Anything else at the path is a 409.
 */
export function makeDir(root: string, relPath: string): void {
  const path = resolved(root, relPath, false);
  const existing = statOrNull(path);
  if (existing) {
    if (!existing.isDirectory()) throw new FileError(409, `not a directory: ${relPath}`);
    return;
  }
  try {
    mkdirSync(path, { mode: 0o755 });
  } catch (err) {
    throw asFileError(err, relPath);
  }
}

/**
 * Apparent size of everything under some directories, in bytes.
 *
 * It sums file sizes, like `du --apparent-size`, not allocated blocks.
 * Symlinks count as nothing and are not followed. A subdirectory that cannot
 * be read, for example because the agent deleted it during the walk, is
 * skipped. A root that cannot be read throws.
 */
export async function totalSize(roots: readonly string[]): Promise<number> {
  let total = 0;
  for (const root of roots) total += await directorySize(root);
  return total;
}

/** Apparent size of everything under one directory, in bytes. */
async function directorySize(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === root) throw err;
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        try {
          total += (await lstat(child)).size;
        } catch {
          // Deleted between the readdir and the stat. Nothing to add.
        }
      }
    }
  }
  return total;
}

/** What a path is, without following a final link, or null when nothing is there. */
function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Removes a temp file, if it is still there. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Counts the temp files this process has created, so each gets its own
 * name.
 */
let tmpFiles = 0;

/** How many times one temp file tries to get its name to itself. */
const TMP_ATTEMPTS = 5;

/**
 * Writes a stream into a new temp file next to `path`, and returns the temp
 * file's path.
 *
 * The mode is that of the file at `path`, or `mode` when there is none. The
 * open creates the file and follows no link. When the name is taken, by a
 * link or a leftover, the function removes it and tries again.
 */
async function streamToTemp(path: string, body: Readable, mode = 0o644): Promise<string> {
  const tmp = `${path}.${process.pid}.${tmpFiles++}.tmp`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let fd: number | null = null;
  for (let attempt = 0; attempt < TMP_ATTEMPTS && fd === null; attempt++) {
    try {
      fd = openSync(tmp, flags, 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ELOOP') throw asFileError(err, path);
      removeQuietly(tmp);
    }
  }
  if (fd === null) throw new Error(`could not get a clean temp file to write ${path}`);

  try {
    // Set through the descriptor, because the umask masks a mode given to open.
    fchmodSync(fd, (statOrNull(path)?.mode ?? mode) & 0o777);
  } catch (err) {
    closeSync(fd);
    removeQuietly(tmp);
    throw err;
  }
  try {
    await pipeline(body, createWriteStream('', { fd }));
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  return tmp;
}
