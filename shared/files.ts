/**
 * The protocol between the orchestrator and the file service in a box,
 * `boxes-files`.
 *
 * The two use HTTP/2 over the standard input and output of the file
 * service. Each operation is one request. The method and the path name the
 * operation, the query names the file, and the body carries the bytes. Every
 * path is relative to the workspace, with '' for the workspace itself.
 */

/**
 * The version of this protocol. The file service sends it with every
 * response, and the orchestrator refuses a response with another version.
 */
export const FILES_PROTOCOL_VERSION = 1;

/** The response header that carries {@link FILES_PROTOCOL_VERSION}. */
export const VERSION_HEADER = 'boxes-files-version';

/** The command in the box image that starts the file service. */
export const FILES_COMMAND = 'boxes-files';

/** The request paths of the operations. */
export const FILE_ROUTES = {
  /** GET: the plain files and directories in one directory, as a {@link ListReply}. */
  list: '/list',
  /** POST: the directories that hold a `.git`, from a {@link FindReposRequest}, as a {@link FindReposReply}. */
  findRepos: '/find-repos',
  /** GET: the type and the size of one path, as a {@link StatReply}. */
  stat: '/stat',
  /**
   * GET: the start of one file, up to the `cap` in the query. The body is the
   * bytes. The `etag` header carries the hash. Other headers carry the real size and the flags.
   */
  read: '/read',
  /** GET: the whole content of one file, as a stream. */
  raw: '/raw',
  /**
   * PUT: replaces one file atomically with the body. DELETE: removes one file.
   * A PUT needs `If-Match` with the expected hash, or `If-None-Match: *` for a
   * file that must not exist yet.
   */
  file: '/file',
  /** POST: creates one directory. Its parent must exist. */
  mkdir: '/mkdir',
  /** POST: writes the body under the first free name in a directory, as a {@link CreateReply}. */
  create: '/create',
  /** GET: the apparent size of the workspace, the home and the Nix store, as a {@link SizeReply}. */
  size: '/size',
  /**
   * POST: writes the setup files of the home from a tar stream of files relative to the home. The file service
   * accepts only the CA certificate of the egress proxy and the git configuration.
   */
  setupFiles: '/setup-files',
  /**
   * POST: installs the agent set in the body, a tar stream of files relative to the home, and removes the files of
   * the last install. The file service accepts only the instructions files and the skill directories of the harness
   * layouts. Then it copies each skill of the image that the set does not replace.
   */
  agentSet: '/agent-set',
} as const;

/** The response header with the real size of a file that was read. */
export const SIZE_HEADER = 'boxes-files-size';

/** The response header that is '1' when a read stopped at its cap. */
export const TRUNCATED_HEADER = 'boxes-files-truncated';

/** The response header that is '1' when a read found a NUL byte. */
export const BINARY_HEADER = 'boxes-files-binary';

/**
 * The hash of a file covers this number of bytes plus one. A change after
 * these bytes does not change the hash.
 */
export const HASH_BYTES = 8 * 1024 * 1024;

/** The maximum number of entries in one directory listing. */
export const MAX_DIR_ENTRIES = 2000;

/** The maximum number of names that a create tries, the requested name included, before it fails. */
export const MAX_CREATE_COLLISIONS = 100;

/** One child of a directory. */
export interface DirChild {
  /** The name in the directory. */
  name: string;
  /** True for a directory, false for a plain file. */
  isDir: boolean;
}

/** The reply of {@link FILE_ROUTES.list}. */
export interface ListReply {
  /** The children, at most {@link MAX_DIR_ENTRIES}. Symlinks and special files are left out. */
  entries: DirChild[];
  /** True when the directory held more children than were returned. */
  truncated: boolean;
}

/** The body of {@link FILE_ROUTES.findRepos}: the limits of the walk. */
export interface FindReposRequest {
  /** The maximum depth of a directory under the workspace that the walk reads. The workspace has depth 0. */
  maxDepth: number;
  /** The maximum number of directories that the walk reads. */
  maxScanned: number;
  /** The number of directories with a `.git` after which the walk stops. */
  maxRepos: number;
  /** Directory names the walk does not enter. */
  pruned: string[];
}

/** The reply of {@link FILE_ROUTES.findRepos}. */
export interface FindReposReply {
  /** The directories that hold a `.git` file or directory, breadth first. */
  paths: string[];
}

/** The reply of {@link FILE_ROUTES.stat}. */
export interface StatReply {
  /** The kind of the path. */
  type: 'file' | 'dir' | 'other';
  /** The size in bytes. */
  size: number;
}

/** The reply of {@link FILE_ROUTES.create}. */
export interface CreateReply {
  /** The name the file got in its directory. */
  name: string;
}

/** The reply of {@link FILE_ROUTES.size}. */
export interface SizeReply {
  /** The apparent size in bytes. */
  bytes: number;
}

/**
 * Checks that a relative path from a client is well-formed, before any access to the filesystem.
 *
 * Refuses an empty or overlong path, a NUL byte, an absolute path, a leading
 * backslash, a drive letter, an empty segment and any `..` segment. Slashes and
 * backslashes both separate segments. The check works on whole segments, so a
 * name like `[...slug].astro` stays valid.
 *
 * @param path The path relative to the workspace.
 * @returns True when the path is well-formed.
 */
export function validRelativePath(path: string): boolean {
  if (path === '' || path.length > 4096) return false;
  if (path.includes('\0')) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split(/[/\\]/);
  return !segments.some((s) => s === '..' || s === '');
}
