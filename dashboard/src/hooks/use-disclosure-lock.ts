import { useCallback, type RefObject } from 'react';
import { useScrollLock } from '@assistant-ui/react';
import { isFollowingOutput } from '@/hooks/use-follow-output';

/**
 * The assistant-ui scroll lock, skipped while the thread follows its output.
 *
 * `useScrollLock` holds the viewport still while a disclosure animates. It
 * resets `scrollTop` on every scroll event for `duration` milliseconds. In a
 * thread that follows its output, that reset looks like the reader scrolling
 * up, and following would stop for the rest of the turn.
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
