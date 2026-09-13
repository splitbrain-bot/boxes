import assert from 'node:assert/strict';
import { test } from 'vitest';
import { anchorAt, scrollForAnchor, type RowOffset } from './anchor.ts';

/**
 * The reader's place, held across a relayout.
 *
 * The case each of these is really about is the mode switch: the same file,
 * laid out twice, with the comment cards between the lines the second time.
 */

/** Rows of equal height, with extra room after the lines named. */
function rows(count: number, height: number, cards: Record<number, number> = {}): RowOffset[] {
  const out: RowOffset[] = [];
  let top = 0;
  for (let line = 1; line <= count; line++) {
    out.push({ line, top });
    top += height + (cards[line] ?? 0);
  }
  return out;
}

test('the anchor is the topmost visible line and how far into it', () => {
  const commenting = rows(100, 20);
  assert.deepEqual(anchorAt(commenting, 0), { line: 1, offset: 0 });
  assert.deepEqual(anchorAt(commenting, 200), { line: 11, offset: 0 });
  // Part way through a row stays part way through it.
  assert.deepEqual(anchorAt(commenting, 205), { line: 11, offset: 5 });
});

test('a line keeps its place when the cards above it fold away', () => {
  // Three comments above the fold, each a card's worth of height.
  const commenting = rows(100, 20, { 3: 60, 7: 60, 12: 60 });
  const editing = rows(100, 20);

  const anchor = anchorAt(commenting, 580);
  assert.deepEqual(anchor, { line: 21, offset: 0 });
  // 580px into the commented layout and 400 into the edited one are the same
  // place to a reader, which is the whole point.
  assert.equal(scrollForAnchor(editing, anchor!), 400);
});

test('and coming back out of edit mode puts the cards back under the same line', () => {
  const editing = rows(100, 20);
  const commenting = rows(100, 20, { 3: 60, 7: 60, 12: 60 });

  const anchor = anchorAt(editing, 405);
  assert.deepEqual(anchor, { line: 21, offset: 5 });
  assert.equal(scrollForAnchor(commenting, anchor!), 585);
});

test('a pane at its very top stays at its very top', () => {
  const anchor = anchorAt(rows(100, 20, { 3: 60 }), 0);
  assert.equal(scrollForAnchor(rows(100, 20), anchor!), 0);
});

test('a line that is gone moves nobody anywhere', () => {
  // The file was replaced under the reader rather than re-laid out.
  assert.equal(scrollForAnchor(rows(10, 20), { line: 40, offset: 0 }), null);
});

test('an empty pane has no anchor to take', () => {
  assert.equal(anchorAt([], 0), null);
});

test('a scroller above its first row does not scroll past the top coming back', () => {
  // An overscroll on iOS reports a negative offset for a moment.
  const anchor = anchorAt(rows(10, 20), -30);
  assert.deepEqual(anchor, { line: 1, offset: -30 });
  assert.equal(scrollForAnchor(rows(10, 20), anchor!), 0);
});
