import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { StoredAttachment } from '../../shared/types.ts';
import { resolveInRoot } from './review/fs.ts';
import { chownToAgent } from './workspaces.ts';

/**
 * Files the user attaches to a prompt, stored in the box's own workspace.
 *
 * Everything an attachment could be — a screenshot, a PDF, a CSV, a heap
 * dump — is the same thing here: bytes written into the workspace under a
 * name the agent can type into a `Read` call. Nothing here decides the file's
 * type, and what a client says about what it uploaded is the client's own
 * business.
 *
 * The workspace is a plain directory this process owns, so an upload is a
 * file write rather than a copy into a container, and it works while the
 * box is stopped.
 */

/** Directory attachments live in, relative to the workspace root. */
export const ATTACHMENTS_DIR = '.boxes/attachments';

/**
 * What goes in `.boxes/.gitignore`.
 *
 * Attachments land inside a tree that is very often a git repository the
 * agent is working in, where they would show up as untracked files in every
 * `git status` the user reads and in every commit the agent is careless
 * with. A `*` here ignores the whole directory including this file itself,
 * which keeps the repository's own .gitignore — a file the user owns —
 * untouched.
 */
const GITIGNORE = '*\n';

/**
 * Content types a workspace file may be served back as itself.
 *
 * Images, SVG included, PDFs, audio and video — the formats a browser shows
 * rather than saves. An SVG can carry script, and these are files the agent
 * can write, served from the same origin as the dashboard, so both ways of
 * opening one are shut: through an `<img>`, which is how the thread shows it,
 * a browser runs nothing in an SVG and fetches nothing it references, and
 * opened as a document it gets `default-src 'none'; sandbox`, which leaves it
 * no script, no origin and no network.
 *
 * HTML is the deliberate omission: a page served as one runs as this origin,
 * and there is no way to show it that does not.
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
 * The content security policy every workspace file is served under.
 *
 * `sandbox` leaves a document no script, no origin and no network, which is
 * what makes serving an SVG as itself safe.
 */
const SANDBOXED_CSP = "default-src 'none'; sandbox";

/**
 * The policy for a file a browser shows with a player or viewer of its own,
 * rather than as a document the file's bytes could script.
 *
 * A PDF is rendered by the browser's own viewer, and a sandboxed document is
 * one a browser may refuse to hand to a viewer at all — which turns "open it
 * in a tab" back into a download, the one thing serving it as
 * `application/pdf` was for. Audio and video are played by a media element
 * the browser builds around the file, and a sandboxed document has no origin
 * that element could load the file from. `media-src 'self'` is what lets it
 * load the file, and `default-src 'none'` still refuses everything else.
 */
const VIEWER_CSP = "default-src 'none'; media-src 'self'";

/** Whether a content type is shown by a viewer or player; see VIEWER_CSP. */
function viewed(type: string): boolean {
  return type === 'application/pdf' || type.startsWith('audio/') || type.startsWith('video/');
}

/** How one workspace file is served: as itself, or as a download. */
export interface ServedType {
  contentType: string;
  /** False for anything not in SERVABLE_TYPES, which is then never rendered. */
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
 * A client's filename, reduced to something safe to be both a path component
 * and a line of a prompt.
 *
 * Two different worries, one answer. As a path it must not escape the
 * attachments directory, so separators and traversal have to go; as prompt
 * text it is quoted into the message the model reads, so a newline in it
 * could forge a line of that message and a bracket could break the format
 * the dashboard parses back out. Keeping letters, digits, dot, dash and
 * underscore and replacing every run of anything else with a single
 * underscore settles all of it at once, and leaves a name that survives
 * being typed into a shell.
 *
 * Unicode letters are kept, so `Größe.png` is not reduced to `Gr__e.png`. A
 * leading dot is dropped rather than replaced, so an upload cannot land on
 * `.gitignore` and turn the ignore rule above off.
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
 *
 * The open is exclusive and a taken name is tried again with the next
 * suffix, so two uploads of the same name at once land on two files rather
 * than one of them overwriting the other.
 *
 * The write itself is asynchronous: an attachment is as large as
 * MAX_ATTACHMENT_MB allows, and one process carries every box's stream,
 * so writing it in one blocking call stops all of them for as long as the
 * disk takes.
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
 * handed to the agent. Returns where it really is.
 *
 * The workspace is a tree the agent writes, so a level of the chain can be a
 * link when an upload arrives: creating through one would put the directory,
 * the bytes and the chown outside the workspace. Every level is resolved
 * under the workspace first, which refuses a link as the last component and a
 * link anywhere above it, and is then created on its own rather than
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
 * Writes one attachment into a workspace and hands back where it landed.
 *
 * The name is sanitised to a single path component before it is used, so
 * containment for it is by construction rather than by a check: there is no
 * path to resolve and compare, because the client never supplies one. The
 * directory it lands in is resolved under the workspace, because that part of
 * the path is a tree the agent can rearrange.
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
