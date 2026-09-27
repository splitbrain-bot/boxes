import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  followGrew,
  followScrolled,
  followStart,
  followTouched,
  isFollowing,
  type FollowState,
} from './follow-output.ts';

/** A turn arriving into a thread, a chunk at a time, on a clock stepped by hand. */
function turn(): {
  writes: (behind: number, opts?: { reserving?: boolean }) => boolean;
  reads: (behind: number) => void;
  touches: () => void;
  tick: (ms: number) => void;
  following: () => boolean;
} {
  let state: FollowState = followStart();
  let now = 0;

  return {
    /** A chunk lands, leaving `behind` pixels under the fold. True if it caught up. */
    writes: (behind, { reserving = false } = {}) => {
      now += 16;
      const grew = followGrew(state, { behind, reserving, now });
      state = grew.state;
      // Catching up puts the scroller against the bottom, which is a scroll.
      if (grew.catchUp) state = followScrolled(state, { behind: 0, now });
      return grew.catchUp;
    },
    /** The scroller moves to `behind` pixels from the end. */
    reads: (behind) => {
      now += 16;
      state = followScrolled(state, { behind, now });
    },
    /** A gesture: a wheel notch, a touch or a press on the scrollbar. */
    touches: () => {
      state = followTouched(state, now);
    },
    /** Time passing with nothing moving. */
    tick: (ms) => {
      now += ms;
    },
    /** Whether the thread follows its output now. */
    following: () => isFollowing(state, now),
  };
}

test('the anchor keeps the position while it still has room to give', () => {
  const thread = turn();
  assert.equal(thread.writes(600, { reserving: true }), false);
  assert.equal(thread.writes(400, { reserving: true }), false);
});

test('and this takes over the moment it runs out', () => {
  const thread = turn();
  thread.writes(600, { reserving: true });
  assert.equal(thread.writes(300), true);
  assert.equal(thread.writes(300), true);
  assert.equal(thread.writes(300), true);
});

test('a chunk that changed nothing is not chased', () => {
  const thread = turn();
  // Within the rounding an anchor leaves.
  assert.equal(thread.writes(0), false);
  assert.equal(thread.writes(4), false);
});

test('a reader who takes the scroller away is left where they put it', () => {
  const thread = turn();
  thread.writes(300);

  thread.touches();
  thread.reads(1200);
  assert.equal(thread.following(), false);
  assert.equal(thread.writes(1500), false);
  assert.equal(thread.writes(1800), false);
});

test('arriving back at the bottom rejoins the turn', () => {
  const thread = turn();
  thread.touches();
  thread.reads(1200);
  assert.equal(thread.writes(1500), false);

  thread.touches();
  thread.reads(0);
  assert.equal(thread.writes(300), true);
});

test('the browser moving the scroller on its own is not a reader leaving', () => {
  // Like a block collapsing above: a scroll away with no gesture.
  const thread = turn();
  thread.writes(300);
  thread.reads(900);
  assert.equal(thread.following(), true);
  assert.equal(thread.writes(900), true);
});

test('a hand that has let go stops being a hand', () => {
  const thread = turn();
  thread.touches();

  // Within the gesture window, the scroll is the reader's.
  thread.reads(900);
  assert.equal(thread.writes(900), false);

  // After the window, the same scroll is the browser's.
  const later = turn();
  later.touches();
  later.tick(600);
  later.reads(900);
  assert.equal(later.writes(900), true);
});

test('a thread parked at the bottom with nothing arriving is being read, not followed', () => {
  const thread = turn();
  assert.equal(thread.writes(300), true);
  assert.equal(thread.following(), true);

  thread.tick(1500);
  assert.equal(thread.following(), false);
});
