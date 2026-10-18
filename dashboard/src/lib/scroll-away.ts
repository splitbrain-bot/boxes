/** State functions that decide whether a header moves out of the way, from the positions of a scroller. */

/** Within this many pixels of the top, the header always shows. */
const AT_TOP = 48;
/**
 * Within this many pixels of the bottom, a scroller counts as at the bottom.
 *
 * A thread that streams output stays at the bottom while the content grows.
 * Each step looks like a scroll down by the reader. The position is a
 * better signal than the thread's `isRunning`, which clears while the last
 * chunks still arrive.
 */
export const AT_BOTTOM = 8;
/** The number of pixels that a downward run needs before the header moves away. */
const HIDE_AFTER = 32;
/**
 * The number of pixels that an upward run needs before the header returns.
 *
 * Smaller than {@link HIDE_AFTER}, so the reader can bring the header back
 * easily. A scroller that settles after a smooth scroll drifts by about 12
 * pixels, which is less than this value.
 */
const SHOW_AFTER = 24;
/**
 * The step size in pixels above which a step is a jump and not reading.
 *
 * The views scroll themselves in one large step. The review restores a
 * position or centres a hunk, and the thread anchors the message of a new turn
 * to the top. A gesture of the reader moves one frame at a time.
 */
const JUMP = 320;
/**
 * The time, in milliseconds, in which the decision ignores small steps after a change.
 *
 * Collapsing the header grows the scroller, and Chrome nudges `scrollTop` a
 * few pixels to hold anchored content still. The nudge looks like an upward
 * run and would bring the header back, which shrinks the scroller again.
 * Only steps below {@link NUDGE} are ignored, so a real flick still counts.
 */
const SETTLE_MS = 300;
/** The maximum step in pixels of a settling scroller. */
const NUDGE = 24;

/** The data of one scroll event that the decision uses. */
interface ScrollAwaySample {
  /** The scroll position now. */
  top: number;
  /** The number of pixels of content below the fold. */
  behind: number;
  /** The time, in milliseconds on the `performance.now()` clock. */
  now: number;
}

/** The current decision, and the run that it measures. */
export interface ScrollAwayState {
  /** True while the header should be out of the way. */
  away: boolean;
  /** The scroll position at the last event. */
  last: number;
  /** The scroll position where the current run began, at the last change of direction. */
  anchor: number;
  /** True when the current run goes down. */
  descending: boolean;
  /** The time until which the decision ignores a small step from the settling scroller. */
  settledUntil: number;
}

/**
 * Gives the start state, in which the header shows and the scroller has not moved.
 *
 * @returns The start state.
 */
export function scrollAwayStart(): ScrollAwayState {
  return { away: false, last: 0, anchor: 0, descending: false, settledUntil: 0 };
}

/**
 * Computes the state after one scroll event.
 *
 * The header moves away after a downward run of {@link HIDE_AFTER} pixels and
 * returns after an upward run of {@link SHOW_AFTER}. A run is measured from
 * the last change of direction, so finger jitter toggles nothing and a slow
 * drift still adds up.
 *
 * @param state The current state.
 * @param sample The data of the scroll event.
 * @returns The new state.
 */
export function scrollAway(state: ScrollAwayState, sample: ScrollAwaySample): ScrollAwayState {
  const { top, behind, now } = sample;
  const step = top - state.last;
  if (step === 0) return state;

  const moved = { ...state, last: top };

  /** Applies a decision. Only a change starts the settling window. */
  const decide = (next: boolean, over: Partial<ScrollAwayState> = {}): ScrollAwayState =>
    next === state.away
      ? { ...moved, ...over }
      : { ...moved, ...over, away: next, settledUntil: now + SETTLE_MS };

  // Near the top, the header always shows. A view too short to scroll stays here.
  if (top <= AT_TOP) return decide(false, { anchor: top, descending: false });

  // At the bottom, a step is content arriving, or the clamp after the header
  // collapsed. Neither decides anything. The next run starts here.
  if (behind <= AT_BOTTOM) return { ...moved, anchor: top };

  const jumped = Math.abs(step) > JUMP;
  const nudged = Math.abs(step) < NUDGE && now < state.settledUntil;
  if (jumped || nudged) return { ...moved, anchor: top };

  const down = step > 0;
  const turned = down !== state.descending;
  const anchor = turned ? top - step : state.anchor;
  const run = top - anchor;
  const crossed = down ? run > HIDE_AFTER : -run > SHOW_AFTER;

  return crossed
    ? decide(down, { anchor, descending: down })
    : { ...moved, anchor, descending: down };
}
