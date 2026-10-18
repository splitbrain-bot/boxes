/**
 * The REVIEW.md format and the operations on a parsed review.
 *
 * The format is the format of the desktop review tool, so each tool can continue a review that the other
 * started. This module does no I/O.
 */

/**
 * The number of source lines kept above and below an annotated line, so the drift check can
 * find the code again after it moved.
 */
const CONTEXT_RADIUS = 3;

/**
 * The word in the fence info string of a context block that tells the block apart
 * from a code sample in the comment above it.
 */
const CONTEXT_MARKER = 'context';

/** One review comment with the source context it was written against. */
export interface Annotation {
  /** The comment of the reviewer, trimmed. */
  comment: string;
  /** The stored context lines, without their line-number prefix. */
  context: string[];
  /** The first line number of the context block, or 0 when none is stored. */
  contextFrom: number;
  /** True when the stored context does not match the source. */
  outdated: boolean;
}

/** The annotations by file path, then by line number. */
type ReviewData = Map<string, Map<number, Annotation>>;

/** A whole parsed REVIEW.md. */
export interface Review {
  /** The annotations, by file path and line number. */
  data: ReviewData;
  /** The date the review was started, or '' for a file that records none. */
  started: string;
}

/** Matches a file section heading, which holds the path in backticks. */
const FILE_HEADER = /^## `(.+)`$/;
/** Matches an annotation heading with its line number and an optional marker. */
const LINE_HEADER = /^#### Line (\d+)(.*)$/;
/** Matches one numbered source line of a context block. */
const CONTEXT_LINE = /^(\d+):(?: (.*))?$/;
/** Matches the line that records the date the review was started. */
const STARTED = /^_Started: (.+)_$/;
/** Matches the run of backticks or tildes that opens a code fence. */
const FENCE = /^(`{3,}|~{3,})/;

/**
 * The maximum indent of a code fence, in spaces. A line with more indent is
 * content.
 */
const MAX_FENCE_INDENT = 3;

/**
 * Splits a document into lines without terminators, tolerating CRLF. A final
 * newline adds no empty last line.
 *
 * @param text The document.
 * @returns The lines.
 */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Reads a REVIEW.md into its annotations and the date the review was started.
 *
 * Headings count as structure only outside fenced code blocks, so a heading in
 * a code sample of a comment stays part of the comment. A horizontal rule
 * separates sections only when a file heading follows it.
 *
 * @param text The content of REVIEW.md.
 * @returns The parsed review.
 */
export function parseReview(text: string): Review {
  const lines = toLines(text);
  const data: ReviewData = new Map();

  // A document that marks its context blocks is read strictly, so a code
  // sample closing a comment is not taken for context. In a document without
  // markers, numbered source lines identify a context block.
  const marked = usesContextMarker(lines);

  let started = '';
  let currentFile = '';
  let currentLine = 0;
  let outdated = false;
  let body: string[] = [];
  let collecting = false;
  let fence = '';

  /** Turns the lines collected since the last heading into an annotation. */
  const save = (): void => {
    if (!collecting) return;
    const { comment, context, contextFrom } = splitBody(body, marked);
    if (comment !== '' && currentFile !== '') {
      const forFile = data.get(currentFile);
      if (forFile) forFile.set(currentLine, { comment, context, contextFrom, outdated });
    }
    body = [];
    collecting = false;
  };

  for (const [i, line] of lines.entries()) {
    // Nothing inside a code fence is structure.
    if (fence !== '') {
      if (closesFence(line, fence)) fence = '';
      if (collecting) body.push(line);
      continue;
    }
    const opening = fenceMarker(line);
    if (opening !== '') {
      fence = opening;
      if (collecting) body.push(line);
      continue;
    }

    const lineHeader = LINE_HEADER.exec(line);
    if (lineHeader && currentFile !== '') {
      save();
      currentLine = Number(lineHeader[1]);
      outdated = (lineHeader[2] ?? '').includes('outdated');
      collecting = true;
      continue;
    }
    const fileHeader = FILE_HEADER.exec(line)?.[1];
    if (fileHeader !== undefined) {
      save();
      currentFile = fileHeader;
      if (!data.has(currentFile)) data.set(currentFile, new Map());
      continue;
    }
    if (line.trim() === '---' && opensFileSection(lines.slice(i + 1))) {
      save();
      continue;
    }

    if (!collecting) {
      if (started === '') started = STARTED.exec(line.trim())?.[1] ?? '';
      continue;
    }
    body.push(unescapeStructure(line));
  }
  save();

  return { data, started };
}

/**
 * Separates the comment of an annotation from the context block at its end.
 * With `marked` set, only a block whose fence has the context marker is a
 * context block. Without it, a last block of numbered source lines is one.
 *
 * @param body The lines of the annotation after its heading.
 * @param marked True when the document marks its context blocks.
 * @returns The comment, the context lines, and the first line number of the context, or 0 without context.
 */
function splitBody(
  body: string[],
  marked: boolean,
): { comment: string; context: string[]; contextFrom: number } {
  let end = body.length;
  while (end > 0 && body[end - 1]?.trim() === '') end--;

  const whole = {
    comment: joinComment(body.slice(0, end)),
    context: [] as string[],
    contextFrom: 0,
  };

  const block = lastFencedBlock(body.slice(0, end));
  if (!block || block.close !== end - 1) return whole;
  if (marked && !isContextFence(body[block.open] ?? '')) return whole;

  const parsed = parseContext(body.slice(block.open + 1, block.close));
  if (!parsed) return whole;
  return {
    comment: joinComment(body.slice(0, block.open)),
    context: parsed.context,
    contextFrom: parsed.from,
  };
}

/**
 * Checks if the document marks its context blocks.
 *
 * @param lines The lines of the document.
 * @returns True when a fence line has the context marker.
 */
function usesContextMarker(lines: string[]): boolean {
  return lines.some((line) => fenceMarker(line) !== '' && isContextFence(line));
}

/**
 * Checks if a fence line opens a context block.
 *
 * @param line The fence line.
 * @returns True when the info string holds {@link CONTEXT_MARKER}.
 */
function isContextFence(line: string): boolean {
  const { trimmed } = trimIndent(line);
  const info = trimmed.replace(/^[`~]+/, '');
  return info.split(/\s+/).includes(CONTEXT_MARKER);
}

/**
 * Joins the comment lines and removes the blank lines that set the comment apart from
 * the headings around it.
 *
 * @param lines The comment lines.
 * @returns The comment, trimmed.
 */
function joinComment(lines: string[]): string {
  return lines.join('\n').trim();
}

/**
 * Parses the numbered source lines of a context block.
 *
 * @param lines The lines between the fences.
 * @returns The context lines and the first line number, or null when a line is not a numbered source line.
 */
function parseContext(lines: string[]): { context: string[]; from: number } | null {
  if (lines.length === 0) return null;
  const context: string[] = [];
  let from = 0;
  for (const line of lines) {
    const match = CONTEXT_LINE.exec(line);
    if (!match) return null;
    if (from === 0) from = Number(match[1]);
    context.push(match[2] ?? '');
  }
  return { context, from };
}

/**
 * Finds the last complete fenced block.
 *
 * @param lines The lines to search.
 * @returns The indexes of the opening and the closing fence line, or null when there is no complete block.
 */
function lastFencedBlock(lines: string[]): { open: number; close: number } | null {
  let fence = '';
  let start = 0;
  let found: { open: number; close: number } | null = null;
  for (const [i, line] of lines.entries()) {
    if (fence === '') {
      const marker = fenceMarker(line);
      if (marker !== '') {
        fence = marker;
        start = i;
      }
      continue;
    }
    if (closesFence(line, fence)) {
      found = { open: start, close: i };
      fence = '';
    }
  }
  return found;
}

/**
 * Checks if the next line that is not blank is a file heading.
 *
 * @param lines The lines after the current line.
 * @returns True when the first line that is not blank is a file heading.
 */
function opensFileSection(lines: string[]): boolean {
  for (const line of lines) {
    if (line.trim() === '') continue;
    return FILE_HEADER.test(line);
  }
  return false;
}

/**
 * Gives the run of backticks or tildes that opens a code fence on a line.
 *
 * @param line The line.
 * @returns The run, or '' when the line opens no fence.
 */
function fenceMarker(line: string): string {
  const { trimmed, indent } = trimIndent(line);
  if (indent > MAX_FENCE_INDENT) return '';
  return FENCE.exec(trimmed)?.[0] ?? '';
}

/**
 * Checks if a line closes a fence that `marker` opened.
 *
 * @param line The line.
 * @param marker The run of backticks or tildes that opened the fence.
 * @returns True when the line closes the fence.
 */
function closesFence(line: string, marker: string): boolean {
  const { trimmed, indent } = trimIndent(line);
  if (indent > MAX_FENCE_INDENT) return false;
  const body = trimmed.replace(/ +$/, '');
  if (body.length < marker.length) return false;
  // Only the fence character, repeated: "````" closes "```", "```go" does not.
  return body.split('').every((char) => char === marker[0]);
}

/**
 * Strips the leading spaces of a line.
 *
 * @param line The line.
 * @returns The line without leading spaces, and the number of spaces removed.
 */
function trimIndent(line: string): { trimmed: string; indent: number } {
  const trimmed = line.replace(/^ +/, '');
  return { trimmed, indent: line.length - trimmed.length };
}

/**
 * Checks if the parser reads a line as a heading of the document.
 *
 * @param line The line.
 * @returns True when the line is a file heading or an annotation heading.
 */
function looksStructural(line: string): boolean {
  return FILE_HEADER.test(line) || LINE_HEADER.test(line);
}

/**
 * Removes the backslash that {@link escapeComment} puts in front of a comment line
 * that looks like a heading.
 *
 * @param line The line from the document.
 * @returns The line as the reviewer wrote it.
 */
function unescapeStructure(line: string): string {
  if (line.startsWith('\\') && looksStructural(line.slice(1))) return line.slice(1);
  return line;
}

/**
 * Converts a review to its markdown form.
 *
 * Each context block holds the stored context of its annotation, which is the
 * code at the last time the annotation matched the source.
 *
 * @param review The review.
 * @returns The content of REVIEW.md.
 */
export function serializeReview(review: Review): string {
  const out: string[] = ['# Code Review\n\n', `_Started: ${review.started}_\n`];

  for (const [path, lines] of sortedEntries(review.data)) {
    out.push('\n---\n\n', `## \`${path}\`\n`);

    for (const [lineNum, ann] of [...lines].sort((a, b) => a[0] - b[0])) {
      out.push(
        ann.outdated ? `\n#### Line ${lineNum} (outdated)\n\n` : `\n#### Line ${lineNum}\n\n`,
      );
      const { text, openFence } = escapeComment(ann.comment);
      out.push(text);
      if (ann.context.length > 0) {
        // Close a fence the comment left open, or the context block would read
        // back as part of the comment.
        if (openFence !== '') out.push(openFence, '\n');
        out.push(`\n\`\`\`${contextFenceInfo(path)}\n`);
        out.push(formatContext(ann.context, ann.contextFrom));
        out.push('```\n');
      }
    }
  }

  return out.join('');
}

/**
 * Sorts the annotated files in the order that the document lists them.
 *
 * The function sorts the paths by their UTF-8 bytes, as the desktop tool sorts them. The
 * default sort compares UTF-16 code units, which gives a different order for
 * characters outside the BMP.
 *
 * @param data The annotations of the review.
 * @returns The files that hold annotations, with their annotations.
 */
function sortedEntries(data: ReviewData): [string, Map<number, Annotation>][] {
  return [...data.entries()]
    .filter(([, lines]) => lines.size > 0)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

/**
 * Prepares the text of a comment for the document.
 *
 * A line that looks like a heading of the document gets a backslash in front,
 * and markdown renders the line as text. Lines inside the code fences of the
 * comment stay unchanged.
 *
 * @param comment The comment.
 * @returns The text with a newline after each line, and the fence that the comment left open, or ''.
 */
function escapeComment(comment: string): { text: string; openFence: string } {
  const out: string[] = [];
  let fence = '';
  for (const line of comment.split('\n')) {
    if (fence !== '') {
      if (closesFence(line, fence)) fence = '';
    } else {
      const marker = fenceMarker(line);
      if (marker !== '') fence = marker;
      else if (looksStructural(line)) out.push('\\');
    }
    out.push(line, '\n');
  }
  return { text: out.join(''), openFence: fence };
}

/**
 * Gives the info string of the fence of a context block. It holds the language of the
 * file for highlighting, and then the marker that tells the block apart from a
 * code sample in a comment. Renderers take the language from the first word.
 *
 * @param path The path of the annotated file.
 * @returns The info string.
 */
function contextFenceInfo(path: string): string {
  const lang = detectLang(path);
  return lang === '' ? CONTEXT_MARKER : `${lang} ${CONTEXT_MARKER}`;
}

/**
 * Writes stored context lines with their line numbers, as the fenced context block holds them.
 *
 * @param lines The context lines.
 * @param from The line number of the first line.
 * @returns The numbered lines, each with a newline.
 */
function formatContext(lines: string[], from: number): string {
  return lines.map((line, i) => `${from + i}: ${line}\n`).join('');
}

/**
 * Gives a language identifier for a file, by file name or extension.
 *
 * The language only affects syntax colouring when the markdown is rendered.
 * Both tools find the `context` marker after it, so the other tool can read a review
 * when the two pick different languages.
 *
 * @param path The path of the file.
 * @returns The language identifier, or '' when none is known.
 */
export function detectLang(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName: Record<string, string> = {
    dockerfile: 'docker',
    makefile: 'makefile',
    'go.mod': 'go',
    'go.sum': 'text',
  };
  const known = byName[name];
  if (known) return known;

  const dot = name.lastIndexOf('.');
  const ext = dot <= 0 ? '' : name.slice(dot + 1);
  const byExt: Record<string, string> = {
    go: 'go',
    py: 'python',
    pyi: 'python',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescript',
    java: 'java',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    rs: 'rust',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    lua: 'lua',
    pl: 'perl',
    r: 'r',
    scala: 'scala',
    dart: 'dart',
    vue: 'vue',
    svelte: 'svelte',
    xml: 'xml',
    ini: 'ini',
    diff: 'diff',
    patch: 'diff',
    txt: 'text',
  };
  return byExt[ext] ?? '';
}

/**
 * Formats a date as REVIEW.md records a start date.
 *
 * @param now The date. Today when absent.
 * @returns The date as YYYY-MM-DD in local time.
 */
export function todayStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Gives the lines around a line.
 *
 * @param lines The lines of the file.
 * @param lineNum The line number, starting at 1.
 * @param radius The number of lines above and below.
 * @returns The lines and the line number of the first line. A line out of range gives no lines and 0.
 */
export function contextAround(
  lines: string[],
  lineNum: number,
  radius: number = CONTEXT_RADIUS,
): { context: string[]; from: number } {
  if (lineNum < 1 || lineNum > lines.length) return { context: [], from: 0 };
  const start = Math.max(lineNum - radius, 1);
  const end = Math.min(lineNum + radius, lines.length);
  return { context: lines.slice(start - 1, end), from: start };
}

/**
 * Adds or replaces the comment on one line of one file. The annotation stores
 * the source lines around the line, so the drift check can follow the code
 * when it moves.
 *
 * @param review The review to change.
 * @param file The workspace-relative path of the file.
 * @param line The line number, starting at 1.
 * @param comment The comment.
 * @param sourceLines The current lines of the file, or null for an annotation without context.
 */
export function setAnnotation(
  review: Review,
  file: string,
  line: number,
  comment: string,
  sourceLines: string[] | null,
): void {
  let lines = review.data.get(file);
  if (!lines) {
    lines = new Map();
    review.data.set(file, lines);
  }
  const ann: Annotation = {
    comment: comment.trim(),
    context: [],
    contextFrom: 0,
    outdated: false,
  };
  if (sourceLines) {
    const { context, from } = contextAround(sourceLines, line, CONTEXT_RADIUS);
    ann.context = context;
    ann.contextFrom = from;
  }
  lines.set(line, ann);
}

/**
 * Removes the comment on one line, and the file entry when it holds no more comments.
 *
 * @param review The review to change.
 * @param file The workspace-relative path of the file.
 * @param line The line number.
 */
export function deleteAnnotation(review: Review, file: string, line: number): void {
  const lines = review.data.get(file);
  if (!lines) return;
  lines.delete(line);
  if (lines.size === 0) review.data.delete(file);
}

/**
 * Gives the annotations of one file.
 *
 * @param review The review.
 * @param file The workspace-relative path of the file.
 * @returns The annotations by line number. The map is empty when the file has none.
 */
export function annotationsFor(review: Review, file: string): Map<number, Annotation> {
  return review.data.get(file) ?? new Map();
}

/**
 * Counts the annotations of each annotated file.
 *
 * @param review The review.
 * @returns The number of annotations, by file path.
 */
export function annotationCounts(review: Review): Map<string, number> {
  return new Map(
    [...review.data.entries()]
      .filter(([, lines]) => lines.size > 0)
      .map(([path, lines]) => [path, lines.size]),
  );
}

/**
 * Updates the annotations of one file for its current source.
 *
 * An annotation whose context has moved goes to the new line. An annotation
 * whose context is gone is marked outdated. An annotation without stored
 * context takes the context of the current source.
 *
 * @param annotations The annotations of the file, by line number. The function changes them in place.
 * @param sourceLines The current lines of the file, or null for a file that is gone or cannot be read. Null
 *   marks every annotation outdated.
 * @returns True when an annotation changed.
 */
export function checkDrift(
  annotations: Map<number, Annotation>,
  sourceLines: string[] | null,
): boolean {
  if (annotations.size === 0) return false;

  if (sourceLines === null) {
    let changed = false;
    for (const ann of annotations.values()) {
      if (!ann.outdated) {
        ann.outdated = true;
        changed = true;
      }
    }
    return changed;
  }

  let changed = false;
  const relocations: Relocation[] = [];

  for (const [lineNum, ann] of annotations) {
    if (ann.context.length === 0) {
      // Without stored context, the annotation takes the context of the current source.
      const { context, from } = contextAround(sourceLines, lineNum, CONTEXT_RADIUS);
      if (context.length > 0) {
        ann.context = context;
        ann.contextFrom = from;
        changed = true;
      }
      continue;
    }

    if (contextMatchesAt(sourceLines, ann.context, ann.contextFrom)) {
      if (ann.outdated) {
        ann.outdated = false;
        changed = true;
      }
      continue;
    }

    const newFrom = findContext(sourceLines, ann.context, ann.contextFrom);
    if (newFrom > 0) {
      const newLine = lineNum + (newFrom - ann.contextFrom);
      if (newLine >= 1) {
        ann.contextFrom = newFrom;
        ann.outdated = false;
        if (newLine !== lineNum) relocations.push({ oldLine: lineNum, newLine, ann });
        changed = true;
      }
    } else if (!ann.outdated) {
      ann.outdated = true;
      changed = true;
    }
  }

  if (relocations.length > 0) relocate(annotations, relocations);

  return changed;
}

/** An annotation that moved, with the lines it moved from and to. */
interface Relocation {
  /** The line the annotation is on. */
  oldLine: number;
  /** The line that its context points to after the move. */
  newLine: number;
  /** The annotation that moves. */
  ann: Annotation;
}

/**
 * Moves relocated annotations onto their new lines, in place.
 *
 * A move goes ahead only when no staying annotation holds its target line and
 * no earlier move claims it. A refused move leaves its annotation in place,
 * which can block another move, so the loop refuses one move at a time until
 * the rest hold. No annotation is lost and no two share a line. The function
 * rebuilds the map in line order.
 *
 * @param annotations The annotations of the file, by line number.
 * @param relocations The annotations whose context moved.
 */
function relocate(annotations: Map<number, Annotation>, relocations: Relocation[]): void {
  const moves = new Map(relocations.map((r) => [r.oldLine, r]));
  for (;;) {
    const held = new Set([...annotations.keys()].filter((line) => !moves.has(line)));
    const claimed = new Set<number>();
    const refused = [...moves.values()].find((r) => {
      if (held.has(r.newLine) || claimed.has(r.newLine)) return true;
      claimed.add(r.newLine);
      return false;
    });
    if (!refused) break;
    moves.delete(refused.oldLine);
  }

  const moved = new Map(annotations);
  for (const r of moves.values()) moved.delete(r.oldLine);
  for (const r of moves.values()) moved.set(r.newLine, r.ann);

  annotations.clear();
  for (const [line, ann] of [...moved].sort((a, b) => a[0] - b[0])) annotations.set(line, ann);
}

/**
 * Checks if the context lines match the file at a line number.
 *
 * @param fileLines The lines of the file.
 * @param context The context lines.
 * @param fromLine The line number of the first context line, starting at 1.
 * @returns True when all context lines match.
 */
function contextMatchesAt(fileLines: string[], context: string[], fromLine: number): boolean {
  if (fromLine < 1 || fromLine - 1 + context.length > fileLines.length) return false;
  return context.every((line, i) => fileLines[fromLine - 1 + i] === line);
}

/**
 * Searches the file for a block of lines that matches `context`.
 *
 * The search starts at `near` and goes outwards, so the closest match wins.
 * Thus an annotation on code that repeats, for example closing braces, stays
 * on the nearest copy.
 *
 * @param fileLines The lines of the file.
 * @param context The context lines.
 * @param near The line number to start at.
 * @returns The line number of the match, starting at 1, or 0 when there is none.
 */
function findContext(fileLines: string[], context: string[], near: number): number {
  const limit = fileLines.length - context.length + 1;
  if (context.length === 0 || limit < 1) return 0;
  const from = near < 1 ? 1 : near;

  const reach = Math.max(from - 1, limit - from);
  for (let d = 0; d <= reach; d++) {
    const before = from - d;
    if (before >= 1 && contextMatchesAt(fileLines, context, before)) return before;
    if (d === 0) continue;
    const after = from + d;
    if (after <= limit && contextMatchesAt(fileLines, context, after)) return after;
  }
  return 0;
}
