/**
 * Helpers for the attachment envelope, the block of prompt text that lists the
 * files that the user attached.
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
  /** The path relative to the workspace, with slashes, in the form that a tool call takes. */
  path: string;
  /** The file's name, which is the last segment of the path. */
  name: string;
  /** The file's MIME type. */
  mimeType: string;
  /** The size, formatted for display. */
  size: string;
}

/**
 * Formats a byte count in B, KB or MB, with one decimal above bytes.
 *
 * @param bytes The byte count.
 * @returns The formatted size, e.g., "2.0 KB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Builds the envelope for a set of attachments, as one block of prompt text.
 *
 * @param entries The attachments.
 * @returns The envelope.
 */
export function buildEnvelope(entries: readonly AttachmentEntry[]): string {
  const lines = entries.map((e) => `- ${e.path} (${e.mimeType}, ${e.size})`);
  return [OPEN, PREAMBLE, ...lines, CLOSE].join('\n');
}

/**
 * One line of the list: path, MIME type and size.
 *
 * The upload replaces spaces and brackets in names, so a pattern can match
 * the line.
 */
const LINE = /^- (\S+) \(([^,()]+), ([^,()]+?)\)$/;

/** The entries of an envelope and the text around it. */
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
 * The caller then shows the text unchanged, so no attachment is lost.
 *
 * @param text The message text.
 * @returns The entries and the text around the envelope, or null.
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
    const [, path, mimeType, size] = LINE.exec(trimmed) ?? [];
    if (!path || !mimeType || !size) return null;
    entries.push({
      path,
      name: path.split('/').pop() ?? path,
      mimeType,
      size,
    });
  }
  if (entries.length === 0) return null;

  return {
    before: text.slice(0, open).trimEnd(),
    entries,
    after: text.slice(close + CLOSE.length).trimStart(),
  };
}

/**
 * Image types that the attachment endpoint serves inline, so an `<img>` can
 * show them.
 *
 * An `<img>` on a file that the endpoint serves as a download shows a broken
 * picture.
 */
const THUMBNAIL_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml',
]);

/**
 * Checks if the dashboard can show an attachment of this type as a picture instead of a name.
 *
 * @param mimeType The MIME type of the attachment, in any case.
 * @returns True for an image type that the endpoint serves inline.
 */
export function isThumbnailable(mimeType: string): boolean {
  return THUMBNAIL_TYPES.has(mimeType.toLowerCase());
}

/**
 * The URL of one stored attachment.
 *
 * @param boxId The id of the box.
 * @param path The workspace-relative path from the envelope. Only its last
 *   segment goes into the URL.
 * @returns The URL path of the attachment.
 */
export function attachmentUrl(boxId: string, path: string): string {
  const name = path.split('/').pop() ?? path;
  return `/api/boxes/${encodeURIComponent(boxId)}/attachments/${encodeURIComponent(name)}`;
}
