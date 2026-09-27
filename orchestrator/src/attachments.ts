import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { StoredAttachment } from '../../shared/types.ts';
import { resolveInRoot } from './review/fs.ts';
import { chownToAgent } from './workspaces.ts';

/**
 * Files the user attaches to a prompt, stored in the box's own workspace,
 * and the types workspace files are served back as.
 */

/** Directory attachments live in, relative to the workspace root. */
export const ATTACHMENTS_DIR = '.boxes/attachments';

/**
 * What goes in `.boxes/.gitignore`.
 *
 * The workspace is often a git repository, where attachments would show up
 * as untracked files and could end up in a commit. A `*` ignores the whole
 * directory, this file included, so the repository's own .gitignore stays
 * untouched.
 */
const GITIGNORE = '*\n';

/**
 * Content types a workspace file may be served back as itself: the images,
 * PDFs, audio and video a browser shows rather than saves.
 *
 * HTML is left out on purpose, because a page served as HTML runs as this
 * origin.
 */
const SERVABLE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/**
 * Content types a workspace file is downloaded as.
 *
 * Formats a browser does not show but an app on the device may: a download
 * that says what it is can be handed to that app, where one of unknown type
 * cannot. Everything on neither list is a download of unknown type.
 */
const DOWNLOAD_TYPES: Record<string, string> = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
};

/**
 * The content security policy a workspace file is served under, unless a
 * viewer or player shows it.
 *
 * `sandbox` leaves a document no script, no origin and no network. That makes
 * it safe to serve an SVG the agent wrote as itself. Shown through an
 * `<img>`, an SVG runs nothing and fetches nothing.
 */
const SANDBOXED_CSP = "default-src 'none'; sandbox";

/**
 * The policy for a PDF, audio or video file, which the browser shows with its
 * own viewer or player.
 *
 * A browser may refuse to hand a sandboxed PDF to its viewer and offer a
 * download instead. A media element cannot load a file from a sandboxed
 * document, because that document has no origin. `media-src 'self'` lets the
 * player load the file, and `default-src 'none'` refuses everything else.
 */
const VIEWER_CSP = "default-src 'none'; media-src 'self'";

/** Whether a content type is shown by the browser's own viewer or player. */
function viewed(type: string): boolean {
  return type === 'application/pdf' || type.startsWith('audio/') || type.startsWith('video/');
}

/** How one workspace file is served: as itself, or as a download. */
export interface ServedType {
  /** The Content-Type header the file is sent with. */
  contentType: string;
  /** Whether the file is shown inline. False means it is sent as a download. */
  inline: boolean;
  /** The content security policy it is served under. */
  csp: string;
}

/** What to serve a workspace file as, from its name alone. */
export function servedTypeFor(name: string): ServedType {
  const ext = extname(name).toLowerCase();
  const type = SERVABLE_TYPES[ext];
  if (type) {
    return { contentType: type, inline: true, csp: viewed(type) ? VIEWER_CSP : SANDBOXED_CSP };
  }
  return {
    contentType: DOWNLOAD_TYPES[ext] ?? 'application/octet-stream',
    inline: false,
    csp: SANDBOXED_CSP,
  };
}

/** Longest a stored name may be, extension included. */
const MAX_NAME = 100;

/** How many times a colliding name is suffixed before the upload is refused. */
const MAX_COLLISIONS = 100;

/**
 * A client's filename, reduced to a name that is safe as a path component and
 * as a line of a prompt.
 *
 * Every run of characters other than letters, digits, dot, dash and
 * underscore becomes one underscore. That removes separators, so the name
 * cannot leave the attachments directory. It also removes newlines and
 * brackets, which could forge a line of the prompt or break the format the
 * dashboard parses back out.
 *
 * Unicode letters are kept, so `Größe.png` stays as it is. Leading dots are
 * dropped, so an upload cannot land on `.gitignore` and turn the ignore rule
 * off.
 */
export function safeAttachmentName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '');
  if (!cleaned) return 'attachment';
  if (cleaned.length <= MAX_NAME) return cleaned;
  // Truncate the stem rather than the name, so the extension — which is what
  // tells the agent and the browser what the file is — always survives.
  const ext = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

/**
 * Writes `bytes` under the first free name: `name`, `name-2`, `name-3`…
 * Returns the name used and the full path.
 *
 * The open is exclusive, so two uploads of the same name at once land on two
 * files. The write is asynchronous, because one process carries every box's
 * stream and a blocking write of a large attachment would stall them all.
 */
async function writeUnderFreeName(
  dir: string,
  name: string,
  bytes: Buffer,
): Promise<{ name: string; path: string }> {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n <= MAX_COLLISIONS; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const path = join(dir, candidate);
    try {
      await writeFile(path, bytes, { mode: 0o644, flag: 'wx' });
      return { name: candidate, path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`too many attachments named ${name}`);
}

/**
 * One directory of the attachments chain, created if it is not there yet and
 * handed to the agent. Returns its resolved path.
 *
 * The agent writes the workspace, so any level of the chain can be a link.
 * Creating through a link would put the directory, the bytes and the chown
 * outside the workspace. So each level is resolved under the workspace, which
 * refuses a link at any level, and is created on its own rather than
 * recursively.
 */
function containedDir(workspace: string, relative: string): string {
  const resolved = resolveInRoot(workspace, relative, false);
  if (!resolved.ok) {
    throw new Error(
      `cannot store an attachment: ${relative} is not a usable directory (${resolved.reason})`,
    );
  }
  if (!existsSync(resolved.path)) {
    mkdirSync(resolved.path, { mode: 0o755 });
    chownToAgent(resolved.path);
  }
  return resolved.path;
}

/**
 * Writes one attachment into a workspace and returns where it landed.
 *
 * The name is reduced to a single path component, so it cannot leave the
 * directory. The directories above it are resolved under the workspace,
 * because the agent can rearrange them.
 */
export async function storeAttachment(
  workspace: string,
  name: string,
  bytes: Buffer,
): Promise<StoredAttachment> {
  const boxes = containedDir(workspace, '.boxes');
  const dir = containedDir(workspace, ATTACHMENTS_DIR);

  const ignore = join(boxes, '.gitignore');
  // Exclusive, so a link planted under this name is refused rather than
  // followed, and a file already there is left as it is.
  try {
    writeFileSync(ignore, GITIGNORE, { mode: 0o644, flag: 'wx' });
    chownToAgent(ignore);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const target = await writeUnderFreeName(dir, safeAttachmentName(name), bytes);
  // The agent reads these, and in the normal deployment it is a different uid
  // from the one that just wrote them.
  chownToAgent(target.path);

  return {
    name: target.name,
    path: `${ATTACHMENTS_DIR}/${target.name}`,
    size: bytes.byteLength,
  };
}
