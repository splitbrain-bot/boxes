import { AT_BOTTOM } from './scroll-away.ts';

/**
 * Decides whether a scroller follows its own output, from its positions and
 * the gestures on it.
 */

/**
 * How long after a gesture, in milliseconds, a scroll still counts as the
 * reader's.
 *
 * The browser animates a wheel notch or a flick over several frames. The
 * window covers that animation but not a later scroll the browser makes by
 * itself.
 */
const REACH = 400;

/**
 * How recently, in milliseconds, a scroller must have moved with its output
 * to count as following it.
 *
 * A thread at the bottom with no new output is being read, not followed.
 */
const ACTIVE = 1000;

/** Whether a scroller follows its output, and when it was last touched and moved. */
export interface FollowState {
  /** Whether the scroller is keeping itself against the bottom. */
  following: boolean;
  /** When a hand was last on the scroller. */
  gesture: number;
  /** When it last moved to stay with its output. */
  followed: number;
}

/**
 * The state of a thread that has just mounted: following, and not touched.
 *
 * Both clocks start at -Infinity, not 0. `performance.now()` counts from page
 * load, so a 0 would read as a recent gesture on a young page.
 */
export function followStart(): FollowState {
  return { following: true, gesture: -Infinity, followed: -Infinity };
}

/** The state after a gesture: a wheel, a touch or a press on the scrollbar. */
export function followTouched(state: FollowState, now: number): FollowState {
  return { ...state, gesture: now };
}

/**
 * The state after one scroll event.
 *
 * Following stops only for a scroll away from the bottom soon after a
 * gesture. The position alone cannot tell a reader scrolling up from the
 * browser adjusting for a block that collapsed above. A scroll to the bottom
 * always follows again.
 *
 * @param behind How many pixels of content are below the fold.
 */
export function followScrolled(
  state: FollowState,
  { behind, now }: { behind: number; now: number },
): FollowState {
  if (behind <= AT_BOTTOM) return { ...state, following: true };
  if (now - state.gesture < REACH) return { ...state, following: false };
  return state;
}

/**
 * The state after the thread grew, and whether to scroll to the bottom.
 *
 * @param reserving Whether the turn anchor's reserve under the answer still
 *   has height. While it has, the anchor owns the position. Once it is empty,
 *   the answer is taller than the screen and this takes over.
 */
export function followGrew(
  state: FollowState,
  { behind, reserving, now }: { behind: number; reserving: boolean; now: number },
): { state: FollowState; catchUp: boolean } {
  if (!state.following || behind <= AT_BOTTOM || reserving) return { state, catchUp: false };
  return { state: { ...state, followed: now }, catchUp: true };
}

/**
 * Whether the scroller follows its output right now: it keeps to the bottom,
 * and it moved to stay there within the last {@link ACTIVE} milliseconds.
 */
export function isFollowing(state: FollowState, now: number): boolean {
  return state.following && now - state.followed < ACTIVE;
}
