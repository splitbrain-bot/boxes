/**
 * Keeps the reader's place in the code pane across a change of layout, such as
 * the switch between commenting and editing.
 *
 * The switch adds or removes the comment cards between lines, so the place is
 * kept as a line and an offset into it rather than as a pixel offset.
 */

/** One rendered line and where its row starts in the scroller. */
export interface RowOffset {
  /** The line number. */
  line: number;
  /** Distance from the top of the scrolled content to the top of the row. */
  top: number;
}

/** Where a pane is, said as a line and how far into it. */
export interface ScrollAnchor {
  /** The line number. */
  line: number;
  /**
   * How far past the top of that line's row the pane is scrolled. Negative
   * for a pane scrolled above its first row, which padding allows.
   */
  offset: number;
}

/**
 * The topmost visible line of a scroller, and how far into it the scroller
 * is. Null when there are no rows.
 *
 * On a phone the screen holds few lines, so the topmost one is the best guess
 * for the reader's place. A caller that knows which line was tapped should use
 * that line instead.
 *
 * @param rows The rows in the order they are rendered.
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
 * The scroll position that puts an anchor back, never above 0. Null when the
 * line is gone, which means the file was replaced, and the scroller should
 * stay where it is.
 */
export function scrollForAnchor(rows: RowOffset[], anchor: ScrollAnchor): number | null {
  const row = rows.find((r) => r.line === anchor.line);
  if (!row) return null;
  return Math.max(0, row.top + anchor.offset);
}

/**
 * The rows of a scroller, read from its `[data-line]` elements.
 *
 * Uses `offsetTop` because it is measured against the scrolled content and
 * does not change when the scroller scrolls.
 */
export function rowOffsets(scroller: HTMLElement): RowOffset[] {
  const rows: RowOffset[] = [];
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(element.dataset.line);
    if (Number.isInteger(line)) rows.push({ line, top: element.offsetTop });
  }
  return rows;
}
