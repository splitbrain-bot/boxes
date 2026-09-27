/**
 * The attachment envelope: the block of prompt text that lists the files the
 * user attached.
 *
 * The files are uploaded into the box's workspace, and the agent reads them
 * from there. The envelope is plain text, because text comes back from any
 * adapter's transcript exactly as sent. The dashboard parses it back to draw
 * the attachment chips.
 */

/** The line that opens the envelope. */
const OPEN = '<attachments>';
/** The line that closes the envelope. */
const CLOSE = '</attachments>';

/** The line above the list, addressed to the model. */
const PREAMBLE =
  'The user attached these files to this message. They are saved in the ' +
  'workspace at the paths below; read them if they are relevant.';

/** One attachment, as the envelope carries it. */
export interface AttachmentEntry {
  /** Workspace-relative and slash-separated: what a tool call is given. */
  path: string;
  /** The file's name, which is the last segment of the path. */
  name: string;
  /** The file's MIME type. */
  mimeType: string;
  /** The size, formatted for display. */
  size: string;
}

/** A byte count in B, KB or MB, with one decimal above bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The envelope for a set of attachments, as one block of prompt text. */
export function buildEnvelope(entries: readonly AttachmentEntry[]): string {
  const lines = entries.map((e) => `- ${e.path} (${e.mimeType}, ${e.size})`);
  return [OPEN, PREAMBLE, ...lines, CLOSE].join('\n');
}

/**
 * One line of the list: path, MIME type and size.
 *
 * The upload removes spaces and brackets from names, so a pattern can match
 * the line.
 */
const LINE = /^- (\S+) \(([^,()]+), ([^,()]+?)\)$/;

/** What was around an envelope, and what was in it. */
export interface ParsedEnvelope {
  /** Text before the envelope. */
  before: string;
  /** The attachments the envelope lists. */
  entries: AttachmentEntry[];
  /** Text after the envelope. */
  after: string;
}

/**
 * Reads an envelope out of a block of message text. Returns null when there
 * is none, when it lists no files, or when a line of it does not parse.
 *
 * The caller then shows the text as it is, which is better than dropping an
 * attachment.
 */
export function parseEnvelope(text: string): ParsedEnvelope | null {
  const open = text.indexOf(OPEN);
  if (open === -1) return null;
  const close = text.indexOf(CLOSE, open);
  if (close === -1) return null;

  const body = text.slice(open + OPEN.length, close);
  const entries: AttachmentEntry[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === PREAMBLE) continue;
    const match = LINE.exec(trimmed);
    if (!match) return null;
    const [, path, mimeType, size] = match;
    entries.push({
      path: path!,
      name: path!.split('/').pop() ?? path!,
      mimeType: mimeType!,
      size: size!,
    });
  }
  if (entries.length === 0) return null;

  return {
    before: text.slice(0, open).trimEnd(),
    entries,
    after: text.slice(close + CLOSE.length).trimStart(),
  };
}

// --- showing one back -------------------------------------------------------

/**
 * Image types the attachment endpoint serves inline, so an `<img>` can show
 * them.
 *
 * Every type here has to be one the endpoint serves inline. An `<img>` on a
 * file served as a download shows a broken picture.
 */
const THUMBNAIL_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
]);

/** Whether an attachment of this type can be shown rather than named. */
export function isThumbnailable(mimeType: string): boolean {
  return THUMBNAIL_TYPES.has(mimeType.toLowerCase());
}

/**
 * The URL the browser fetches one stored attachment from.
 *
 * @param path The workspace-relative path from the envelope. Only its last
 *   segment goes into the URL.
 */
export function attachmentUrl(boxId: string, path: string): string {
  const name = path.split('/').pop() ?? path;
  return `/api/boxes/${encodeURIComponent(boxId)}/attachments/${encodeURIComponent(name)}`;
}
