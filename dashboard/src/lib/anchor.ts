/**
 * Scroll anchors that keep the reader's place in the code pane when the layout
 * changes, e.g., on the switch between commenting and editing.
 *
 * The switch adds or removes the comment cards between lines, so an anchor is
 * a line and an offset into that line, and not a pixel offset.
 */

/** One rendered line and where its row starts in the scroller. */
export interface RowOffset {
  /** The line number. */
  line: number;
  /** Distance from the top of the scrolled content to the top of the row. */
  top: number;
}

/** The scroll position of a pane, as a line and an offset into that line. */
export interface ScrollAnchor {
  /** The line number. */
  line: number;
  /**
   * The distance from the top of the row of the line to the top of the pane.
   * Negative for a pane scrolled above its first row, which padding allows.
   */
  offset: number;
}

/**
 * Finds the topmost visible line of a scroller, and the offset of the scroller
 * into that line.
 *
 * On a phone the screen holds few lines, so the topmost one is the best guess
 * for the reader's place. A caller that knows which line was tapped should use
 * that line instead.
 *
 * @param rows The rows in the order they are rendered.
 * @param scrollTop The scroll position of the scroller.
 * @returns The anchor, or null when there are no rows.
 */
export function anchorAt(rows: RowOffset[], scrollTop: number): ScrollAnchor | null {
  const first = rows[0];
  if (!first) return null;
  let standing = first;
  for (const row of rows) {
    if (row.top > scrollTop) break;
    standing = row;
  }
  return { line: standing.line, offset: scrollTop - standing.top };
}

/**
 * Computes the scroll position that restores an anchor, never above 0.
 *
 * When the line is gone, the file was replaced, and the scroller should stay
 * where it is.
 *
 * @param rows The rows of the new layout.
 * @param anchor The anchor to restore.
 * @returns The scroll position, or null when the line is gone.
 */
export function scrollForAnchor(rows: RowOffset[], anchor: ScrollAnchor): number | null {
  const row = rows.find((r) => r.line === anchor.line);
  if (!row) return null;
  return Math.max(0, row.top + anchor.offset);
}

/**
 * Reads the rows of a scroller from its `[data-line]` elements.
 *
 * Uses `offsetTop` because it is measured against the scrolled content and
 * does not change when the scroller scrolls.
 *
 * @param scroller The scroller of the code pane.
 * @returns The rows in the order they are rendered.
 */
export function rowOffsets(scroller: HTMLElement): RowOffset[] {
  const rows: RowOffset[] = [];
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(element.dataset.line);
    if (Number.isInteger(line)) rows.push({ line, top: element.offsetTop });
  }
  return rows;
}
