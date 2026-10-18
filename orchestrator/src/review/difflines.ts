import { fileLines } from './fs.ts';
import { type GitTarget, git, gitOut } from './git.ts';
import { type Base, baseRev } from './gitstatus.ts';

/** The type of change of a line in the new file. */
export type LineChange = 'added' | 'modified';

/** The number of unchanged lines around a change in each hunk. */
const DIFF_CONTEXT = 3;

/** Matches a hunk header of the form `@@ -old[,count] +new[,count] @@`. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * A block of lines deleted between two lines of the new file. The hunk it
 * points at holds the removed lines.
 */
interface DiffDeletion {
  /** The deletion is after this line. 0 means the top of the file. */
  afterLine: number;
  /** The index into `hunks` of the hunk that holds the removed lines. */
  hunkIndex: number;
}

/** One diff hunk with the range of new-file lines it covers. */
interface DiffHunk {
  /** The first new-file line in the hunk. */
  startLine: number;
  /** The last new-file line in the hunk. */
  endLine: number;
  /** The hunk's raw diff lines, as git wrote them. */
  diff: string;
}

/** The diff markers of one file, for the gutter of the file view. */
export interface FileDiff {
  /** The changed new-file lines, by line number. */
  lines: Record<number, LineChange>;
  /** The hunks of the diff, in file order. */
  hunks: DiffHunk[];
  /** The places where lines were removed and no lines replaced them. */
  deletions: DiffDeletion[];
}

/**
 * Returns the diff of a file without changes.
 *
 * @returns A diff with no lines, hunks or deletions.
 */
export function emptyDiff(): FileDiff {
  return { lines: {}, hunks: [], deletions: [] };
}

/**
 * Splits diff output into lines without terminators. A final newline adds no
 * empty last line.
 *
 * @param out The output of git diff.
 * @returns The lines.
 */
function diffLines(out: string): string[] {
  if (out === '') return [];
  const lines = out.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Turns unified diff output for one file into line markers, hunks and
 * deletion markers.
 *
 * The function tells added lines from modified lines by the diff body, because one hunk
 * can hold both. A run of removed lines that no added lines replace becomes a
 * deletion marker after the last line that stayed.
 *
 * @param out The unified diff output of git for one file.
 * @returns The diff markers.
 */
export function parseDiff(out: string): FileDiff {
  const info = emptyDiff();

  /** The hunk being read. */
  let current: DiffHunk | null = null;
  let body: string[] = [];
  /** The next line number in the new file. */
  let newLine = 0;
  /** The number of removed lines since the last unchanged line. */
  let removed = 0;
  /** True when the run of added lines replaces removed lines. */
  let replacing = false;

  const keep = (line: string): void => {
    body.push(line, '\n');
  };

  /**
   * Ends a run of changes. Removed lines that nothing replaced become a
   * deletion marker.
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
      // An unchanged empty line whose leading space was stripped.
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

/**
 * Marks every line of a file as added, for a file that git does not track.
 *
 * @param content The content of the file.
 * @returns The value 'added' for each line number.
 */
export function allLinesAdded(content: string): Record<number, LineChange> {
  const lines: Record<number, LineChange> = {};
  for (let i = 1; i <= fileLines(content).length; i++) lines[i] = 'added';
  return lines;
}

/**
 * Computes the diff markers for one file, against the base commit or, without
 * one, against HEAD. For a file that git does not track, every line of `content` is
 * marked as added.
 *
 * The diff and the untracked check run in parallel, because only the diff
 * result shows which of the two answers is needed.
 *
 * @param target The repository to run git in.
 * @param base The base to compare against.
 * @param path The path of the file, relative to the repository.
 * @param content The current content of the file.
 * @returns The diff markers.
 */
export async function fileDiff(
  target: GitTarget,
  base: Base,
  path: string,
  content: string,
): Promise<FileDiff> {
  const [diff, untracked] = await Promise.all([
    git(target, ['diff', baseRev(base), `--unified=${DIFF_CONTEXT}`, '--', path]),
    gitOut(target, ['ls-files', '--others', '--exclude-standard', '--', path]),
  ]);

  if (diff.ok && diff.stdout.length > 0) return parseDiff(diff.stdout);
  if (untracked.length > 0) return { ...emptyDiff(), lines: allLinesAdded(content) };
  return emptyDiff();
}
