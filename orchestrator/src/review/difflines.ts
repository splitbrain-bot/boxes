import { DIFF_SAFETY_FLAGS, git, gitOut } from './git.ts';
import { baseRev, type Base } from './gitstatus.ts';

/**
 * Unified diff to the markers a file view draws.
 *
 * A port of the desktop tool's `internal/gitstatus/difflines.go`. `parseDiff`
 * is pure and is where all the behaviour is; `fileDiff` only decides which git
 * output to hand it.
 */

/** What happened to a line of the new file. */
export type LineChange = 'added' | 'modified';

/** Unchanged lines git includes around a change, shown in the hunk view. */
const DIFF_CONTEXT = 3;

/** Hunk headers: `@@ -old[,count] +new[,count] @@`. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * A block of lines deleted between two lines of the new file.
 *
 * How many were removed is not recorded: the hunk the marker points at shows
 * them.
 */
export interface DiffDeletion {
  /** The deletion sits after this line; 0 means the top of the file. */
  afterLine: number;
  /** Index into `hunks`, so tapping the marker can show the removed lines. */
  hunkIndex: number;
}

/** One diff hunk with the range of new-file lines it covers. */
export interface DiffHunk {
  /** First new-file line in the hunk. */
  startLine: number;
  /** Last new-file line in the hunk. */
  endLine: number;
  /** The hunk's raw diff lines, as git wrote them. */
  diff: string;
}

/** Everything a file view needs to mark up its gutter. */
export interface FileDiff {
  /** Changed new-file lines, by line number. */
  lines: Record<number, LineChange>;
  hunks: DiffHunk[];
  deletions: DiffDeletion[];
}

/** A file with no diff at all. */
export function emptyDiff(): FileDiff {
  return { lines: {}, hunks: [], deletions: [] };
}

/**
 * Splits diff output into lines without terminators, and without a trailing
 * empty one for output that ends in a newline — which git's does, and a
 * truncated read might not.
 */
function diffLines(out: string): string[] {
  if (out === '') return [];
  const lines = out.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Turns unified diff output for a single file into line markers, hunks and
 * deletion markers.
 *
 * Added and modified lines are told apart by looking at the diff body rather
 * than the hunk header: with context around a change, one hunk can hold both. A
 * run of removed lines that is not replaced by added ones becomes a deletion
 * marker sitting after the last line that survived.
 */
export function parseDiff(out: string): FileDiff {
  const info = emptyDiff();

  /** The hunk being read, and its raw text. */
  let current: DiffHunk | null = null;
  let body: string[] = [];
  /** Next line number in the new file. */
  let newLine = 0;
  /** Removed lines seen since the last unchanged line. */
  let removed = 0;
  /** Whether the run of added lines replaces removed ones. */
  let replacing = false;

  const keep = (line: string): void => {
    body.push(line, '\n');
  };

  /**
   * Closes a run of removed lines, recording a deletion marker for those that
   * nothing was put in place of.
   */
  const endRun = (): void => {
    if (removed > 0) {
      info.deletions.push({
        afterLine: Math.max(newLine - 1, 0),
        hunkIndex: info.hunks.length,
      });
      removed = 0;
    }
    replacing = false;
  };

  const endHunk = (): void => {
    if (!current) return;
    endRun();
    current.diff = body.join('');
    body = [];
    info.hunks.push(current);
    current = null;
  };

  for (const line of diffLines(out)) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      endHunk();
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      current = { startLine: newStart, endLine: newStart + newCount - 1, diff: '' };
      newLine = newStart;
      continue;
    }

    // Everything before the first hunk header is the file header.
    if (!current) continue;

    if (line === '') {
      // An unchanged empty line is written without its leading space.
      endRun();
      keep('');
      newLine++;
      continue;
    }

    switch (line[0]) {
      case ' ':
        endRun();
        keep(line);
        newLine++;
        break;
      case '-':
        // A new run of changes starts where added lines stopped.
        if (replacing) endRun();
        removed++;
        keep(line);
        break;
      case '+':
        if (removed > 0) {
          replacing = true;
          removed = 0; // replaced, not deleted
        }
        info.lines[newLine] = replacing ? 'modified' : 'added';
        keep(line);
        newLine++;
        break;
      case '\\':
        // "\ No newline at end of file"
        keep(line);
        break;
      default:
        endHunk();
    }
  }
  endHunk();

  return info;
}

/** Marks every line of a file as added, for a file git does not track yet. */
export function allLinesAdded(content: string): Record<number, LineChange> {
  let count = (content.match(/\n/g) ?? []).length;
  if (content.length > 0 && !content.endsWith('\n')) count++;
  const lines: Record<number, LineChange> = {};
  for (let i = 1; i <= count; i++) lines[i] = 'added';
  return lines;
}

/**
 * The diff markers for one file. With a base commit set, the file is diffed
 * against that commit rather than against HEAD; the file's own content is used
 * to mark up a file git does not track yet.
 *
 * The diff and the untracked check run together, because which of the two
 * answers is needed only shows once the diff is in.
 */
export async function fileDiff(
  root: string,
  base: Base,
  path: string,
  content: string,
): Promise<FileDiff> {
  const [diff, untracked] = await Promise.all([
    git(root, [
      'diff',
      baseRev(base),
      `--unified=${DIFF_CONTEXT}`,
      ...DIFF_SAFETY_FLAGS,
      '--',
      path,
    ]),
    gitOut(root, ['ls-files', '--others', '--exclude-standard', '--', path]),
  ]);

  if (diff.ok && diff.stdout.length > 0) return parseDiff(diff.stdout);
  // The file is new to git, so all of it is new.
  if (untracked.length > 0) return { ...emptyDiff(), lines: allLinesAdded(content) };
  return emptyDiff();
}
