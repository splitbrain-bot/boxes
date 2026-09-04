import { useCallback, type RefObject } from 'react';
import { useScrollLock } from '@assistant-ui/react';
import { isFollowingOutput } from '@/hooks/use-follow-output';

/**
 * The registry's scroll lock, minus the fight with a thread following its own
 * output.
 *
 * `useScrollLock` holds the viewport still for the length of a disclosure's
 * animation, so a reasoning block collapsing or a tool call opening does not
 * take the line the reader was on with it. It holds it by putting `scrollTop`
 * back on every scroll event of the next two hundred milliseconds — and a
 * thread following its own output scrolls constantly, so that reset lands on
 * the follow's own scroll and is indistinguishable from a reader flicking
 * upward. Following switches off there and does not come back, and the rest
 * of the turn is written below the fold: a working turn is mostly disclosures
 * opening and closing, so the odds of surviving one are poor.
 *
 * A thread following its own output has nothing to hold still — the position
 * is the bottom, wherever that has got to — so it is not held.
 *
 * @param element The disclosure that animates.
 * @param duration How long it animates for, in milliseconds.
 * @returns The lock, to call before the disclosure changes.
 */
export function useDisclosureLock(
  element: RefObject<HTMLElement | null>,
  duration: number,
): () => void {
  const lock = useScrollLock(element, duration);

  return useCallback(() => {
    if (isFollowingOutput(element.current)) return;
    lock();
  }, [lock, element]);
}
