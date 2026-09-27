/** Decides whether a header should move out of the way, from a scroller's positions. */

/** Within this many pixels of the top, the header always shows. */
const AT_TOP = 48;
/**
 * Within this many pixels of the bottom, a scroller counts as at the bottom.
 *
 * A thread that streams output stays at the bottom while the content grows.
 * Those steps look like reading down, but they are not. The position is a
 * better signal than the thread's `isRunning`, which clears while the last
 * chunks still arrive.
 */
export const AT_BOTTOM = 8;
/** How many pixels a downward run needs before the header moves away. */
const HIDE_AFTER = 32;
/**
 * How many pixels an upward run needs before the header returns.
 *
 * Smaller than {@link HIDE_AFTER}, so a request to bring it back is easy.
 * A scroller settling after a smooth scroll drifts by about a dozen pixels,
 * which stays below this.
 */
const SHOW_AFTER = 24;
/**
 * A single step of more pixels than this is a jump, not reading.
 *
 * The views scroll themselves in one large step: the review restores a
 * position or centres a hunk, and the thread anchors a new turn's message to
 * the top. A reader's gesture moves a frame's worth at a time.
 */
const JUMP = 320;
/**
 * How long, in milliseconds, small steps are ignored after a decision.
 *
 * Collapsing the header grows the scroller, and Chrome nudges `scrollTop` a
 * few pixels to hold anchored content still. The nudge looks like an upward
 * run and would bring the header back, which shrinks the scroller again.
 * Only steps below {@link NUDGE} are ignored, so a real flick still counts.
 */
const SETTLE_MS = 300;
/** The most pixels a settling scroller nudges itself by in one step. */
const NUDGE = 24;

/** One scroll event, as much of it as the decision uses. */
interface ScrollAwaySample {
  /** The scroll position now. */
  top: number;
  /** How many pixels of content are below the fold. */
  behind: number;
  /** The time, in milliseconds on the `performance.now()` clock. */
  now: number;
}

/** The decision so far, and the run it is measured on. */
export interface ScrollAwayState {
  /** True while the header should be out of the way. */
  away: boolean;
  /** Where the scroller was at the last event. */
  last: number;
  /** Where the current run began: the last time direction changed. */
  anchor: number;
  /** Whether the current run goes down. */
  descending: boolean;
  /** Until when a step small enough to be the collapse settling is ignored. */
  settledUntil: number;
}

/** The start state: the header shows, and the scroller has not moved. */
export function scrollAwayStart(): ScrollAwayState {
  return { away: false, last: 0, anchor: 0, descending: false, settledUntil: 0 };
}

/**
 * The state after one scroll event.
 *
 * The header moves away after a downward run of {@link HIDE_AFTER} pixels and
 * returns after an upward run of {@link SHOW_AFTER}. A run is measured from
 * the last change of direction, so finger jitter toggles nothing and a slow
 * drift still adds up.
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

  // A view too short to scroll never leaves the top.
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
