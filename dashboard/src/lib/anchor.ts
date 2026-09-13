/**
 * Holding a reader's place across a change that moves the content under them.
 *
 * Switching the code pane between commenting and editing folds away the
 * comment cards, the composer and the deletion markers, because a textarea is
 * one run of text and cannot have rows between its lines. Everything below the
 * first of those then moves, and a pane that jumped half a file on the way
 * into edit mode would be unusable for the thing edit mode is for: fixing the
 * line you are looking at.
 *
 * So the position is remembered as a line rather than as a pixel offset. A
 * pixel offset means nothing once the rows above it have changed height; a
 * line is the same line either side of the switch.
 *
 * Pure, and separate from the pane that reads the offsets out of the DOM,
 * because this is the whole of the behaviour and none of it needs a browser.
 */

/** One rendered line and where its row starts in the scroller. */
export interface RowOffset {
  line: number;
  /** Distance from the top of the scrolled content to the top of the row. */
  top: number;
}

/** Where a pane is, said as a line and how far into it. */
export interface ScrollAnchor {
  line: number;
  /**
   * How far past the top of that line's row the pane is scrolled. Negative
   * for a pane scrolled above its first row, which padding allows.
   */
  offset: number;
}

/**
 * The line a scroller is standing on, and how far into it.
 *
 * The topmost visible line, which is the one the reader is looking at on a
 * phone — the screen holds few enough lines that anything else is a guess.
 * Where a line was tapped to start editing, the caller has a better answer and
 * should use it instead.
 *
 * `rows` must be in the order they are rendered.
 */
export function anchorAt(rows: RowOffset[], scrollTop: number): ScrollAnchor | null {
  if (rows.length === 0) return null;
  let standing = rows[0]!;
  for (const row of rows) {
    if (row.top > scrollTop) break;
    standing = row;
  }
  return { line: standing.line, offset: scrollTop - standing.top };
}

/**
 * Where to scroll to put an anchor back, or null when its line is gone.
 *
 * Null means leave the scroller alone: the file was replaced under the reader
 * rather than re-laid out, and guessing a position for a line that no longer
 * exists would move them somewhere they never were.
 */
export function scrollForAnchor(rows: RowOffset[], anchor: ScrollAnchor): number | null {
  const row = rows.find((r) => r.line === anchor.line);
  if (!row) return null;
  return Math.max(0, row.top + anchor.offset);
}

/**
 * The rows of a scroller, read out of the DOM.
 *
 * `offsetTop` is measured against the scrolled content rather than the
 * viewport, so it survives the scrolling that is about to happen — which
 * `getBoundingClientRect` would not.
 */
export function rowOffsets(scroller: HTMLElement): RowOffset[] {
  const rows: RowOffset[] = [];
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(element.dataset.line);
    if (Number.isInteger(line)) rows.push({ line, top: element.offsetTop });
  }
  return rows;
}
