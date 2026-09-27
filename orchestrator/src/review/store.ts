/**
 * The REVIEW.md format: parsing, serialization, mutation and drift.
 *
 * The format matches the desktop review tool's byte for byte, so either tool
 * can continue a review the other started. This module does no I/O.
 */

/**
 * Source lines kept above and below an annotated line, so the code can be
 * recognised again after it moved.
 */
const CONTEXT_RADIUS = 3;

/**
 * The word in a context block's fence info string that tells the block apart
 * from a code sample in the comment above it.
 */
const CONTEXT_MARKER = 'context';

/** One review comment with the source context it was written against. */
export interface Annotation {
  /** The reviewer's comment, trimmed. */
  comment: string;
  /** Stored context lines, without their line-number prefix. */
  context: string[];
  /** First line number of the context block; 0 when none is stored. */
  contextFrom: number;
  /** True when the stored context no longer matches the source. */
  outdated: boolean;
}

/** Annotations by file path, then by line number. */
type ReviewData = Map<string, Map<number, Annotation>>;

/** A whole parsed REVIEW.md. */
export interface Review {
  /** The annotations, by file path and line number. */
  data: ReviewData;
  /** The date the review was started, or '' for a file that records none. */
  started: string;
}

/** A file section heading, which holds the path in backticks. */
const FILE_HEADER = /^## `(.+)`$/;
/** An annotation heading with its line number and an optional marker. */
const LINE_HEADER = /^#### Line (\d+)(.*)$/;
/** One numbered source line of a context block. */
const CONTEXT_LINE = /^(\d+):(?: (.*))?$/;
/** The line that records the date the review was started. */
const STARTED = /^_Started: (.+)_$/;
/** The run of backticks or tildes that opens a code fence. */
const FENCE = /^(`{3,}|~{3,})/;

/**
 * The most spaces a code fence may be indented. A line indented further is
 * content, not a fence.
 */
const MAX_FENCE_INDENT = 3;

// --- parsing ----------------------------------------------------------------

/**
 * Splits a document into lines without terminators, tolerating CRLF. A final
 * newline adds no empty last line.
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
 * a comment's code sample stays part of the comment. A horizontal rule
 * separates sections only when a file heading follows it.
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

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
    const fileHeader = FILE_HEADER.exec(line);
    if (fileHeader) {
      save();
      currentFile = fileHeader[1]!;
      if (!data.has(currentFile)) data.set(currentFile, new Map());
      continue;
    }
    if (line.trim() === '---' && opensFileSection(lines.slice(i + 1))) {
      save();
      continue;
    }

    if (!collecting) {
      if (started === '') {
        const match = STARTED.exec(line.trim());
        if (match) started = match[1]!;
      }
      continue;
    }
    body.push(unescapeStructure(line));
  }
  save();

  return { data, started };
}

/**
 * Separates an annotation's comment from the context block closing it. With
 * `marked` set, only a block whose fence carries the context marker counts as
 * one; otherwise a closing block of numbered source lines does.
 */
function splitBody(
  body: string[],
  marked: boolean,
): { comment: string; context: string[]; contextFrom: number } {
  let end = body.length;
  while (end > 0 && body[end - 1]!.trim() === '') end--;

  const whole = { comment: joinComment(body.slice(0, end)), context: [] as string[], contextFrom: 0 };

  const block = lastFencedBlock(body.slice(0, end));
  if (!block || block.close !== end - 1) return whole;
  if (marked && !isContextFence(body[block.open]!)) return whole;

  const parsed = parseContext(body.slice(block.open + 1, block.close));
  if (!parsed) return whole;
  return {
    comment: joinComment(body.slice(0, block.open)),
    context: parsed.context,
    contextFrom: parsed.from,
  };
}

/** Whether the document marks its context blocks. */
function usesContextMarker(lines: string[]): boolean {
  return lines.some((line) => fenceMarker(line) !== '' && isContextFence(line));
}

/** Whether a fence line opens a context block. */
function isContextFence(line: string): boolean {
  const { trimmed } = trimIndent(line);
  const info = trimmed.replace(/^[`~]+/, '');
  return info.split(/\s+/).includes(CONTEXT_MARKER);
}

/**
 * Assembles the comment body, without the blank lines that set it apart from
 * the headings around it.
 */
function joinComment(lines: string[]): string {
  return lines.join('\n').trim();
}

/**
 * Parses the numbered source lines of a context block, or returns null when
 * the lines are not one.
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

/** The lines opening and closing the last complete fenced block in `lines`. */
function lastFencedBlock(lines: string[]): { open: number; close: number } | null {
  let fence = '';
  let start = 0;
  let found: { open: number; close: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
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
 * Whether the next line with content starts a file section, which is what
 * makes a horizontal rule a separator rather than text.
 */
function opensFileSection(lines: string[]): boolean {
  for (const line of lines) {
    if (line.trim() === '') continue;
    return FILE_HEADER.test(line);
  }
  return false;
}

/**
 * The run of backticks or tildes opening a code fence on this line, or '' when
 * the line opens none.
 */
function fenceMarker(line: string): string {
  const { trimmed, indent } = trimIndent(line);
  if (indent > MAX_FENCE_INDENT) return '';
  return FENCE.exec(trimmed)?.[0] ?? '';
}

/** Whether the line closes a fence opened with `marker`. */
function closesFence(line: string, marker: string): boolean {
  const { trimmed, indent } = trimIndent(line);
  if (indent > MAX_FENCE_INDENT) return false;
  const body = trimmed.replace(/ +$/, '');
  if (body.length < marker.length) return false;
  // Only the fence character, repeated: "````" closes "```", "```go" does not.
  return body.split('').every((char) => char === marker[0]);
}

/** Strips leading spaces and reports how many there were. */
function trimIndent(line: string): { trimmed: string; indent: number } {
  const trimmed = line.replace(/^ +/, '');
  return { trimmed, indent: line.length - trimmed.length };
}

/**
 * Whether a line would be read back as one of the document's own headings
 * rather than as text.
 */
function looksStructural(line: string): boolean {
  return FILE_HEADER.test(line) || LINE_HEADER.test(line);
}

/**
 * Removes the backslash that `escapeComment` puts in front of a comment line
 * which would otherwise read as a heading.
 */
function unescapeStructure(line: string): string {
  if (line.startsWith('\\') && looksStructural(line.slice(1))) return line.slice(1);
  return line;
}

// --- serialization ----------------------------------------------------------

/**
 * Converts a review to its markdown form.
 *
 * Context blocks hold the context stored with each annotation: the code as it
 * was when the annotation last matched the source.
 */
export function serializeReview(review: Review): string {
  const out: string[] = ['# Code Review\n\n', `_Started: ${review.started}_\n`];

  for (const path of sortedPaths(review.data)) {
    const lines = review.data.get(path)!;
    out.push('\n---\n\n', `## \`${path}\`\n`);

    for (const lineNum of [...lines.keys()].sort((a, b) => a - b)) {
      const ann = lines.get(lineNum)!;
      out.push(ann.outdated ? `\n#### Line ${lineNum} (outdated)\n\n` : `\n#### Line ${lineNum}\n\n`);
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
 * The annotated file paths, in the order the document lists them.
 *
 * Paths are sorted by their UTF-8 bytes, as the desktop tool sorts them. The
 * default sort compares UTF-16 code units, which gives a different order for
 * characters outside the BMP.
 */
function sortedPaths(data: ReviewData): string[] {
  return [...data.entries()]
    .filter(([, lines]) => lines.size > 0)
    .map(([path]) => path)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

/**
 * Writes a comment as the reviewer wrote it, and reports the code fence it
 * left open, if any.
 *
 * A line that would read back as one of the document's own headings gets a
 * backslash in front, which markdown renders as the intended text. Lines inside
 * the comment's own code fences stay unchanged.
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
 * The info string of a context block's fence: the file's language, so the
 * block is highlighted wherever the review is rendered, followed by the marker
 * that tells it from a code sample in a comment. Renderers take the language
 * from the first word and ignore the rest.
 */
function contextFenceInfo(path: string): string {
  const lang = detectLang(path);
  return lang === '' ? CONTEXT_MARKER : `${lang} ${CONTEXT_MARKER}`;
}

/**
 * Renders stored context lines with their line numbers, the form they take
 * inside the fenced context block.
 */
function formatContext(lines: string[], from: number): string {
  return lines.map((line, i) => `${from + i}: ${line}\n`).join('');
}

/**
 * A language identifier for a context block's fence, by file name or
 * extension, or '' when none is known.
 *
 * The language only affects syntax colouring when the markdown is rendered.
 * Both tools find the `context` marker after it, so a review still reads back
 * in the other tool when the two pick different languages.
 */
export function detectLang(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName: Record<string, string> = {
    dockerfile: 'docker',
    makefile: 'makefile',
    'go.mod': 'go',
    'go.sum': 'text',
  };
  if (byName[name]) return byName[name]!;

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
 * Formats a date, today by default, as REVIEW.md records a start date:
 * YYYY-MM-DD in local time.
 */
export function todayStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// --- mutation ---------------------------------------------------------------

/**
 * The lines surrounding `lineNum` together with the line number the block
 * starts at. Line numbers are 1-based; an out-of-range line records nothing.
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
 * Adds or replaces the comment on one line of one file, recording the
 * surrounding source with it so the annotation can be followed when the code
 * later moves. `sourceLines` is null for a file that cannot be read, which
 * leaves the annotation without context rather than refusing it.
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

/** Removes the comment on one line, and the file entry once it holds none. */
export function deleteAnnotation(review: Review, file: string, line: number): void {
  const lines = review.data.get(file);
  if (!lines) return;
  lines.delete(line);
  if (lines.size === 0) review.data.delete(file);
}

/** Annotations for one file, by line number. Empty when the file has none. */
export function annotationsFor(review: Review, file: string): Map<number, Annotation> {
  return review.data.get(file) ?? new Map();
}

/** How many annotations each annotated file has. */
export function annotationCounts(review: Review): Map<string, number> {
  return new Map(
    [...review.data.entries()]
      .filter(([, lines]) => lines.size > 0)
      .map(([path, lines]) => [path, lines.size]),
  );
}

// --- drift ------------------------------------------------------------------

/**
 * Brings one file's annotations back in line with its source, and reports
 * whether that changed anything.
 *
 * An annotation whose context has moved is relocated. One whose context is
 * gone is marked outdated. One without stored context adopts the current
 * source as its reference. `sourceLines` is null for a file that no longer
 * exists, which makes every annotation on it outdated.
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
      // No stored context to compare against: adopt the current source.
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
  /** The line its context now points to. */
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
 * the rest hold. No annotation is lost and no two share a line. The map is
 * rebuilt in line order.
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
  for (const line of [...moved.keys()].sort((a, b) => a - b)) {
    annotations.set(line, moved.get(line)!);
  }
}

/** Whether the context lines match the file at a given 1-based position. */
function contextMatchesAt(fileLines: string[], context: string[], fromLine: number): boolean {
  if (fromLine < 1 || fromLine - 1 + context.length > fileLines.length) return false;
  return context.every((line, i) => fileLines[fromLine - 1 + i] === line);
}

/**
 * Searches the file for a block of lines matching `context` and returns its
 * 1-based line number, or 0 when there is none.
 *
 * The search runs outwards from `near`, so the match closest to where the
 * context was written wins. Code that repeats, such as closing braces or
 * boilerplate, then keeps its annotations on the right copy.
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
