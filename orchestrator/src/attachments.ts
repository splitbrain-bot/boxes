/**
 * Attachments of prompts, stored in the workspace of the box, and the content
 * types for sending workspace files.
 */

import { extname } from 'node:path';
import type { StoredAttachment } from '../../shared/types.ts';
import { type FileService, FileServiceError } from './files.ts';

/** The directory of the attachments, relative to the workspace root. */
export const ATTACHMENTS_DIR = '.boxes/attachments';

/**
 * The content of `.boxes/.gitignore`.
 *
 * The workspace is often a git repository. There, attachments would show as
 * untracked files and could get into a commit. A `*` ignores the whole
 * directory and this file, so the .gitignore of the repository stays the same.
 */
const GITIGNORE = '*\n';

/**
 * The content types of the workspace files that the browser shows inline. The
 * list holds images, PDFs, audio and video.
 *
 * HTML is not in the list, because a page served as HTML runs as this origin.
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
 * The content types of the workspace files that the browser downloads.
 *
 * The formats are for apps on the device. A download with a known type can go
 * to the matching app, and a download of unknown type cannot. A file in
 * neither list is a download of unknown type.
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
 * The content security policy of a workspace file, except for a file that a
 * viewer or a player shows.
 *
 * With `sandbox`, a document has no script, no origin and no network access,
 * so an SVG that the agent wrote is safe to show as a document.
 */
const SANDBOXED_CSP = "default-src 'none'; sandbox";

/**
 * The policy for a PDF, audio or video file, which the browser shows with its
 * own viewer or player.
 *
 * A browser can refuse to give a sandboxed PDF to its viewer and offer a
 * download. A media element cannot load a file from a sandboxed document,
 * because a sandboxed document has no origin. `media-src 'self'` lets the
 * player load the file, and `default-src 'none'` refuses all other requests.
 */
const VIEWER_CSP = "default-src 'none'; media-src 'self'";

/**
 * Checks if the browser shows a content type with its own viewer or player.
 *
 * @param type The content type.
 * @returns True for a PDF, audio or video type.
 */
function viewed(type: string): boolean {
  return type === 'application/pdf' || type.startsWith('audio/') || type.startsWith('video/');
}

/** The way to send one workspace file, inline or as a download. */
export interface ServedType {
  /** The Content-Type header of the response. */
  contentType: string;
  /** True when the browser shows the file inline, false for a download. */
  inline: boolean;
  /** The content security policy of the response. */
  csp: string;
}

/**
 * Gives the way to send a workspace file, from its name only.
 *
 * @param name The name of the file.
 * @returns The content type, the disposition and the policy.
 */
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

/** The maximum length of a stored name, with the extension. */
const MAX_NAME = 100;

/**
 * Reduces a filename from a client to a name that is safe as a path component
 * and as a line of a prompt.
 *
 * Each run of characters other than letters, digits, dot, dash and underscore
 * becomes one underscore. So the name has no separators and cannot leave the
 * attachments directory. The name also has no newlines and no brackets, which
 * could forge a line of the prompt or break the format that the dashboard parses.
 *
 * Unicode letters stay, so `Größe.png` does not change. Leading dots are
 * removed, so a stored name is not hidden, and `.` and `..` become
 * `attachment`. Leading underscores are removed for a cleaner name.
 *
 * @param name The filename from the client.
 * @returns The safe name, at most {@link MAX_NAME} characters long.
 */
export function safeAttachmentName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '');
  if (!cleaned) return 'attachment';
  if (cleaned.length <= MAX_NAME) return cleaned;
  // The cut is in the stem, because the extension tells the agent and the browser
  // the type of the file.
  const ext = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

/**
 * Writes one attachment into the workspace of a box.
 *
 * The file service creates each directory of the path and refuses a link at
 * each level. It writes the file under the first free name, for example
 * `shot.png`, then `shot-2.png`, then `shot-3.png`.
 *
 * @param files The file service of the box.
 * @param name The filename from the client.
 * @param bytes The content of the file.
 * @returns The stored name, the path relative to the workspace, and the size in bytes.
 */
export async function storeAttachment(
  files: FileService,
  name: string,
  bytes: Buffer,
): Promise<StoredAttachment> {
  await files.mkdir('.boxes');
  await files.mkdir(ATTACHMENTS_DIR);

  // The write needs an absent file, so an existing file stays the same.
  try {
    await files.write('.boxes/.gitignore', GITIGNORE, { absent: true });
  } catch (err) {
    if (!(err instanceof FileServiceError && err.status === 412)) throw err;
  }

  const stored = await files.create(ATTACHMENTS_DIR, safeAttachmentName(name), bytes);
  return {
    name: stored,
    path: `${ATTACHMENTS_DIR}/${stored}`,
    size: bytes.byteLength,
  };
}
