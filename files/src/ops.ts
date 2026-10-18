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

  /**
   * Creates the error.
   *
   * @param status The HTTP status of the reply.
   * @param message The message of the error.
   */
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolves a path from a client under the root, or throws the refusal.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @param mustExist False for a path that a write can create.
 * @returns The resolved path.
 * @throws {FileError} A 400 for a malformed path, a 404 for a missing path, and a 403 for a path that leaves the root
 *   or ends in a link.
 */
function resolved(root: string, relPath: string, mustExist = true): string {
  const r = resolveInRoot(root, relPath, mustExist);
  if (r.ok) return r.path;
  if (r.reason === 'invalid') throw new FileError(400, `invalid path: ${relPath}`);
  if (r.reason === 'missing') throw new FileError(404, `not found: ${relPath}`);
  throw new FileError(403, `refused (${r.reason}): ${relPath}`);
}

/**
 * Converts the error of a failed filesystem call into a FileError with the status for its error code. A FileError
 * stays as it is.
 *
 * @param err The error of the call.
 * @param relPath The path of the call, for the message.
 * @returns The FileError.
 * @throws The error itself when its code has no status.
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
 * Lists the plain files and directories in one directory, up to {@link MAX_DIR_ENTRIES}.
 *
 * Symlinks are left out, because their target can change after the listing.
 *
 * @param root The root directory.
 * @param relDir The directory, relative to the root.
 * @returns The entries, and a flag for a truncated list.
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
 * Finds the directories under the root that hold a `.git` file or directory, breadth first.
 *
 * The walk skips the pruned names and does not follow links. It stops at the first limit that it reaches. The walk is
 * breadth first, so a limit leaves the deepest directories unread, where dependency trees usually are.
 *
 * @param root The root directory.
 * @param limits The limits of the walk and the pruned names.
 * @returns The paths of the directories, relative to the root.
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
        continue; // The walk skips a directory that it cannot read.
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

/**
 * Gives the type and the size of one path.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @returns The type and the size.
 */
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

/** The result of one capped read. */
export interface FileRead {
  /** The bytes up to the cap. Empty for a binary file. */
  content: Buffer;
  /** True when the file is longer than the cap. */
  truncated: boolean;
  /** True when the bytes up to the cap hold a NUL byte. */
  binary: boolean;
  /** The size of the file in bytes. */
  size: number;
  /** The hash of the file, as {@link hashOf} gives it. */
  hash: string;
}

/**
 * Reads one plain file, up to `cap` bytes, and hashes it.
 *
 * A NUL byte in the bytes up to the cap marks the file as binary. A binary file comes back without content and
 * without an error, because the tree lists files that the viewer cannot show.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @param cap The maximum number of bytes of content.
 * @returns The content and the facts about the file.
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

/** The bytes of one capped read, and the size of the file. */
interface CappedRead {
  /** The bytes read, at most the cap plus one. */
  buffer: Buffer;
  /** The size of the file in bytes. */
  size: number;
}

/**
 * Reads at most `cap` bytes of a plain file, plus one byte that shows if the file continues after the cap.
 *
 * The bytes after the cap do not go into memory, because a workspace can hold a log of hundreds of megabytes.
 *
 * @param path The absolute path.
 * @param cap The maximum number of bytes, without the extra byte.
 * @returns The bytes and the size of the file.
 * @throws {FileError} A 409 when the path is not a plain file.
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

/**
 * Hashes some bytes with SHA-256.
 *
 * @param bytes The bytes.
 * @returns The first 32 hex digits of the hash.
 */
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * Hashes the content of a file. The hash covers the first {@link HASH_BYTES} bytes plus one.
 *
 * @param path The absolute path.
 * @returns The hash, or '' when the file is missing, cannot be read or is not a plain file.
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
  /** The size in bytes when the file was opened. */
  size: number;
  /** The stream of the content. */
  stream: ReadStream;
}

/**
 * Opens one plain file to stream its whole content.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @returns The size and the stream.
 * @throws {FileError} A 404 when the path is not a plain file.
 */
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

/** The condition of a write: the expected hash of the file, or no file at the path. */
export type WriteCondition = { hash: string } | { absent: true };

/**
 * Writes a stream of bytes to one file atomically.
 *
 * The function writes the bytes to a temp file first, so a reader never sees a half-written file, and a crash leaves
 * the previous version. For a file that must be absent, the function links the temp file into place, so a file that
 * appeared in the meantime stays. A file with a different hash also stays, and so does a file that changes while the
 * function reads it for the hash. A change after that read and before the rename is not detected, because there is no
 * conditional rename. An existing file keeps its permissions, so a saved shell script stays executable.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @param body The new content.
 * @param condition The condition that the current file must meet.
 * @returns The hash of the new content.
 * @throws {FileError} A 409 when the path is not a plain file, and a 412 when the file does not meet the condition.
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
    const before = statOrNull(path);
    if (hashOf(path) !== condition.hash) throw new FileError(412, `changed: ${relPath}`);
    if (!sameVersion(before, statOrNull(path))) throw new FileError(412, `changed: ${relPath}`);
    renameSync(tmp, path);
    return hash;
  } catch (err) {
    removeQuietly(tmp);
    throw asFileError(err, relPath);
  }
}

/**
 * Writes a stream of bytes under the first free name in a directory. The names are `name`, then the stem of `name`
 * with -2, -3 and so on before the extension, up to {@link MAX_CREATE_COLLISIONS} names.
 *
 * A link takes each name, so two creates of the same name at the same time make two files, and no reader sees a
 * half-written file.
 *
 * @param root The root directory.
 * @param relDir The directory, relative to the root.
 * @param name The requested file name, without a separator.
 * @param body The content.
 * @returns The name used.
 * @throws {FileError} A 400 for an invalid name, and a 409 when `relDir` is not a directory or all names are taken.
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

/**
 * Removes one file.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @throws {FileError} A 404 when the file is missing.
 */
export function removeFile(root: string, relPath: string): void {
  const path = resolved(root, relPath);
  try {
    unlinkSync(path);
  } catch (err) {
    throw asFileError(err, relPath);
  }
}

/**
 * Creates one directory, or keeps a directory that is already there.
 *
 * @param root The root directory.
 * @param relPath The path, relative to the root.
 * @throws {FileError} A 404 when the parent is missing, and a 409 when something other than a directory is at the path.
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
 * Adds up the apparent size of all files under some directories.
 *
 * The sum uses the file sizes, not the allocated blocks. Symlinks add nothing, and the walk does not follow them. The
 * walk skips a subdirectory that it cannot read, for example because the agent deleted it during the walk.
 *
 * @param roots The absolute paths of the directories.
 * @returns The total size in bytes.
 * @throws The error of the read when a root cannot be read.
 */
export async function totalSize(roots: readonly string[]): Promise<number> {
  let total = 0;
  for (const root of roots) total += await directorySize(root);
  return total;
}

/**
 * Adds up the apparent size of all files under one directory.
 *
 * @param root The absolute path of the directory.
 * @returns The total size in bytes.
 * @throws The error of the read when the root cannot be read.
 */
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
          // The file was deleted between the readdir and the lstat.
        }
      }
    }
  }
  return total;
}

/**
 * Gives the stats of a path without following a final link.
 *
 * @param path The absolute path.
 * @returns The stats, or null when the lstat fails.
 */
function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Tells if two stats show the same version of a file.
 *
 * @param a The first stats, or null for a missing file.
 * @param b The second stats, or null for a missing file.
 * @returns True when both files exist and have the same inode, size and modification time.
 */
function sameVersion(a: Stats | null, b: Stats | null): boolean {
  return (
    a !== null && b !== null && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
  );
}

/**
 * Removes a temp file, if it is still there.
 *
 * @param path The absolute path.
 */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The file is already gone.
  }
}

/** The number of temp file names that this process has used. The count makes each temp file name unique. */
let tmpFiles = 0;

/** The maximum number of attempts to open one temp file. */
const TMP_ATTEMPTS = 5;

/**
 * Writes a stream into a new temp file next to a path.
 *
 * The open creates a new file and does not follow a link. When a link or an old file has the temp name, the function
 * removes it and tries again.
 *
 * @param path The absolute path of the file that the temp file is for.
 * @param body The content.
 * @param mode The mode of the temp file when there is no file at `path`. Otherwise the temp file gets the mode of that
 *   file.
 * @returns The path of the temp file.
 * @throws {Error} When no attempt opens a new temp file.
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
    // The mode goes through the descriptor, because the umask masks a mode given to open.
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
