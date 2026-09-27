import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scrollAway, scrollAwayStart, type ScrollAwayState } from './scroll-away.ts';

/** One frame in milliseconds, which is what one scroll event is worth. */
const FRAME = 16;

/**
 * A scroller with a given content and viewport height, driven a frame at a
 * time on a clock stepped by hand.
 */
function reading(content: number, view = 900): {
  by: (dy: number, frames?: number) => void;
  to: (top: number) => void;
  grows: (by: number, slack?: number) => void;
  tick: (ms: number) => void;
  away: () => boolean;
  top: () => number;
} {
  let state: ScrollAwayState = scrollAwayStart();
  let height = content;
  let top = 0;
  let now = 0;

  /** One scroll event, from wherever the position has been put. */
  const event = (): void => {
    top = Math.max(0, Math.min(top, height - view));
    now += FRAME;
    state = scrollAway(state, { top, behind: height - view - top, now });
  };

  return {
    /** A gesture: `dy` pixels a frame, for `frames` frames. */
    by: (dy, frames = 1) => {
      for (let i = 0; i < frames; i += 1) {
        top += dy;
        event();
      }
    },
    /** One enormous step, which is how the views scroll themselves. */
    to: (next) => {
      top = next;
      event();
    },
    /**
     * Content arriving under a scroller already against its bottom.
     *
     * A few pixels short of the end rather than exactly on it, because that is
     * where a turn's anchor leaves the position: `slack` is the rounding
     * `AT_BOTTOM` exists to forgive.
     */
    grows: (by, slack = 4) => {
      height += by;
      top = height - view - slack;
      event();
    },
    /** Time passing with nothing moving. */
    tick: (ms) => {
      now += ms;
    },
    /** Whether the header is away. */
    away: () => state.away,
    /** The scroll position. */
    top: () => top,
  };
}

test('the header is there to begin with, and a view too short to scroll never loses it', () => {
  const page = reading(600, 900);
  assert.equal(page.away(), false);
  page.by(40, 4);
  assert.equal(page.away(), false);
});

test('reading down puts the header away, and a flick back up returns it', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  // Far from the top.
  page.by(-100, 2);
  assert.equal(page.away(), false);
  assert.ok(page.top() > 100);
});

test('the header comes back on its own near the top, however it got there', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  // Near the top, not at it.
  page.to(20);
  assert.equal(page.away(), false);
  assert.ok(page.top() > 0);

  page.to(0);
  assert.equal(page.away(), false);
});

test('a run has to be a run: jitter on the glass toggles nothing', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  for (let i = 0; i < 12; i += 1) page.by(i % 2 ? 6 : -6);
  assert.equal(page.away(), true);
});

test('the view scrolling itself is not reading', () => {
  // Restoring a position or centring a hunk. On a narrow screen, the header
  // holds the only way back to the file tree.
  const page = reading(20_000);
  page.to(4000);
  assert.equal(page.away(), false);

  // A jump down after the header moved away.
  page.by(100, 8);
  assert.equal(page.away(), true);
  page.to(12_000);
  assert.equal(page.away(), true);
});

test('a turn writing its own output moves nothing', () => {
  // Each chunk arrives as a downward step at the bottom.
  const page = reading(2000);
  for (let i = 0; i < 40; i += 1) page.grows(120);
  assert.equal(page.away(), false);

  page.by(-100, 3);
  page.by(100, 8);
  assert.equal(page.away(), true);
});

test('the nudge a collapsing row leaves behind is not a request', () => {
  // Chrome nudges scrollTop up a few pixels when the scroller grows.
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  for (let i = 0; i < 6; i += 1) page.by(-8);
  assert.equal(page.away(), true);
});

test('a real flick inside the settling window is still a flick', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);
  page.by(-100, 2);
  assert.equal(page.away(), false);
});

test('and once the window has passed, small steps are read again', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  page.tick(400);
  for (let i = 0; i < 6; i += 1) page.by(-8);
  assert.equal(page.away(), false);
});
