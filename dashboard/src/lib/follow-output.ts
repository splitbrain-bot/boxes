/**
 * State functions that decide whether a scroller follows its own output, from
 * its positions and the gestures on it.
 */

import { AT_BOTTOM } from './scroll-away.ts';

/**
 * The time after a gesture, in milliseconds, in which a scroll still counts as
 * the reader's.
 *
 * The browser animates a wheel notch or a flick over several frames. The
 * window covers that animation but not a later scroll the browser makes by
 * itself.
 */
const REACH = 400;

/**
 * The time, in milliseconds, within which a scroller must have moved with its
 * output to count as following it.
 *
 * A thread at the bottom with no new output is being read, not followed.
 */
const ACTIVE = 1000;

/** The follow state of a scroller, with the times of the last gesture and the last follow move. */
export interface FollowState {
  /** True while the scroller keeps itself against the bottom. */
  following: boolean;
  /** The time of the last gesture on the scroller. */
  gesture: number;
  /** The time when the scroller last moved to stay with its output. */
  followed: number;
}

/**
 * The state of a thread that has just mounted: following, and not touched.
 *
 * Both clocks start at -Infinity, not 0. `performance.now()` counts from page
 * load, so a 0 would look like a recent gesture on a page that has just loaded.
 *
 * @returns The start state.
 */
export function followStart(): FollowState {
  return { following: true, gesture: -Infinity, followed: -Infinity };
}

/**
 * Computes the state after a gesture, e.g., a wheel, a touch or a press on the scrollbar.
 *
 * @param state The current state.
 * @param now The time of the gesture.
 * @returns The new state.
 */
export function followTouched(state: FollowState, now: number): FollowState {
  return { ...state, gesture: now };
}

/**
 * Computes the state after one scroll event.
 *
 * Following stops only for a scroll away from the bottom soon after a
 * gesture. The position alone cannot tell a reader scrolling up from the
 * browser adjusting for a block that collapsed above. A scroll to the bottom
 * always follows again.
 *
 * @param state The current state.
 * @param behind The number of pixels of content below the fold.
 * @param now The time of the scroll event.
 * @returns The new state.
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
 * Computes the state after the thread grew, and whether to scroll to the bottom.
 *
 * @param state The current state.
 * @param behind The number of pixels of content below the fold.
 * @param reserving True while the reserve of the turn anchor under the
 *   answer still has height. While it has height, the anchor controls the scroll
 *   position. When the reserve is empty, the answer is taller than the screen,
 *   and this function controls the position.
 * @param now The time of the change.
 * @returns The new state, and true in `catchUp` when the scroller must move to the bottom.
 */
export function followGrew(
  state: FollowState,
  { behind, reserving, now }: { behind: number; reserving: boolean; now: number },
): { state: FollowState; catchUp: boolean } {
  if (!state.following || behind <= AT_BOTTOM || reserving) return { state, catchUp: false };
  return { state: { ...state, followed: now }, catchUp: true };
}

/**
 * Checks if the scroller follows its output now. The scroller must keep to the
 * bottom, and it must have moved to stay there within the last {@link ACTIVE}
 * milliseconds.
 *
 * @param state The current state.
 * @param now The current time.
 * @returns True while the scroller follows its output.
 */
export function isFollowing(state: FollowState, now: number): boolean {
  return state.following && now - state.followed < ACTIVE;
}
