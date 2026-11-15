/**
 * Scroll anchors that keep the reader's place in the code pane when the layout
 * changes, e.g., on the switch between commenting and editing.
 *
 * The switch adds or removes the comment cards between lines, so an anchor is
 * a line and an offset into that line, and not a pixel offset.
 */

/** One rendered line and where its row starts in the scroller. */
export interface RowOffset {
  /** The line number. For a block of lines, its first line. */
  line: number;
  /** Distance from the top of the scrolled content to the top of the row. */
  top: number;
  /** The last line of a block of lines, or undefined for a row of one line. */
  end?: number;
}

/** The scroll position of a pane, as a line and an offset into that line. */
export interface ScrollAnchor {
  /** The line number, or 0 for a pane without rows, where the offset is the scroll position. */
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
 * @returns The anchor. Without rows, it is line 0 with the scroll position as the offset.
 */
export function anchorAt(rows: RowOffset[], scrollTop: number): ScrollAnchor {
  const first = rows[0];
  if (!first) return { line: 0, offset: scrollTop };
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
  if (anchor.line === 0) return Math.max(0, anchor.offset);
  const row = rows.find((r) => r.line === anchor.line);
  if (!row) return null;
  return Math.max(0, row.top + anchor.offset);
}

/**
 * Computes the scroll position that brings an anchor into view in a pane of blocks.
 *
 * A line of the anchor that is no row lands at the top of the block that holds
 * it, or of the first block after it.
 *
 * @param rows The blocks of the pane, with their last lines.
 * @param anchor The anchor to restore.
 * @returns The scroll position, or null when no block is at or after the line.
 */
export function scrollNearAnchor(rows: RowOffset[], anchor: ScrollAnchor): number | null {
  const exact = scrollForAnchor(rows, anchor);
  if (exact !== null) return exact;
  const holder = rows.find((r) => r.line <= anchor.line && anchor.line <= (r.end ?? r.line));
  const row = holder ?? rows.find((r) => r.line > anchor.line);
  return row ? row.top : null;
}

/**
 * Reads the rows of a scroller from its `[data-line]` elements.
 *
 * The top of a row is measured from the top of the scrolled content, whatever
 * the row is nested in, and rounded to whole pixels like a scroll position.
 *
 * @param scroller The scroller of the pane.
 * @returns The rows in the order they are rendered.
 */
export function rowOffsets(scroller: HTMLElement): RowOffset[] {
  const rows: RowOffset[] = [];
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(element.dataset.line);
    const end = Number(element.dataset.lineEnd);
    if (!Number.isInteger(line)) continue;
    const top = Math.round(element.getBoundingClientRect().top - origin);
    rows.push(end > line ? { line, top, end } : { line, top });
  }
  return rows;
}
