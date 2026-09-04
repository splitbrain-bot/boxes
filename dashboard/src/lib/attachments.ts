/**
 * What an attachment becomes on its way into a prompt, and how it is read
 * back out of one.
 *
 * Every attachment is uploaded into the session's workspace, whatever it is,
 * and the prompt then says so in one block of text — the envelope below.
 * Nothing travels inside the message: the agent opens what it was given the
 * path to, with the tools it already has.
 *
 * The envelope is plain text on purpose. ACP has `resource_link`, which is
 * the protocol's own way to name a file, but an adapter renders it as a bare
 * markdown link with nothing around it, and — the part that decides it —
 * what comes back on replay is that rendering rather than the block, so a
 * reconnected thread would not look like the one that was sent. Text
 * round-trips through any adapter's transcript exactly as written, which
 * makes the envelope both what the model reads and what this dashboard reads
 * back to draw the attachment chips.
 */

/** Marks the envelope, and is what `parseEnvelope` looks for. */
const OPEN = '<attachments>';
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
  mimeType: string;
  /** For display, already formatted — the exact byte count is nobody's question. */
  size: string;
}

/** A byte count as something to read, in the units a person would say. */
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
 * One line of the list, back into an entry.
 *
 * Names are sanitised at upload — no spaces, no brackets — which is what
 * lets this be a pattern rather than a parser.
 */
const LINE = /^- (\S+) \(([^,()]+), ([^,()]+?)\)$/;

/** What was around an envelope, and what was in it. */
export interface ParsedEnvelope {
  /** Text before the envelope, kept so nothing said around it is lost. */
  before: string;
  entries: AttachmentEntry[];
  after: string;
}

/**
 * Reads an envelope out of a block of message text, or returns null when
 * there is none.
 *
 * Tolerant by design: an envelope this build cannot parse is left alone as
 * text, because showing the model's own instructions is a much better
 * failure than dropping something the user attached.
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
    // A list with a line in it this build does not know is not a list this
    // build should be summarising.
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
 * Types the orchestrator serves as themselves, and so the only ones a
 * thumbnail can be drawn from.
 *
 * The same list the endpoint keeps. Anything else is served as a download of
 * unknown type, so an `<img>` pointed at it would show a broken picture
 * rather than the file — which is why this list and that one have to agree.
 */
const THUMBNAIL_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

/** Whether an attachment of this type can be shown rather than named. */
export function isThumbnailable(mimeType: string): boolean {
  return THUMBNAIL_TYPES.has(mimeType.toLowerCase());
}

/**
 * Where the browser can fetch one stored attachment.
 *
 * The path in the envelope is workspace-relative, which is what the agent
 * needs; what a browser needs is the endpoint that reads it back, and the
 * name is the only part of the path that varies.
 */
export function attachmentUrl(sessionId: string, path: string): string {
  const name = path.split('/').pop() ?? path;
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(name)}`;
}
