import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';
import { scrollAway, scrollAwayStart, type ScrollAwayState } from '@/lib/scroll-away.ts';

/**
 * Whether a header should stand aside, for a scroller somewhere inside the
 * returned container.
 *
 * The deciding is in `lib/scroll-away.ts`, where it can be held to a run of
 * positions rather than to a browser: everything here is the listening.
 *
 * Listened for in the capture phase on the container, because a scroll event
 * does not bubble: React's own `onScroll` would never see the viewport's, and
 * reaching into a vendored component for a ref would be undone by the next
 * `npx assistant-ui add`.
 *
 * Nothing about either view is in here — a thread and a code pane are the
 * same shape of thing, and both call it the same way.
 *
 * Only a narrow screen puts the header away. A phone needs every row it has
 * for the content; a wide screen has room for both, and a header that moves
 * there is only in the way.
 *
 * @param scroller Selector for the one scroller that counts. A view has
 *   others — a wide table or a code block inside a message, the file tree
 *   beside a pane — and scrolling those is not reading the thing the header
 *   names.
 */
export function useScrollAway(scroller: string): {
  /** True while the header should be out of the way. */
  away: boolean;
  /** Put on the element the scroller lives inside. */
  container: React.RefObject<HTMLDivElement | null>;
  /** Forget the reading so far, and bring the header back. */
  reset: () => void;
} {
  const container = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const narrow = useMediaQuery('(max-width: 767px)');

  /**
   * The decision's own state, which is a render ahead of `away`: the listener
   * decides on every event of a run, not only the one that crosses the line.
   */
  const state = useRef<ScrollAwayState>(scrollAwayStart());

  /**
   * Puts the header back and forgets the run that sent it away.
   *
   * A decision belongs to the scroller it was read from. When a view closes
   * that scroller, or opens another in its place, the reader is at the top of
   * something new and there is nothing left to flick back up — so a header
   * left away would stay away, with no control anywhere asking for it.
   */
  const reset = useCallback(() => {
    state.current = scrollAwayStart();
    setAway(false);
  }, []);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    const onScroll = (event: Event): void => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !el.matches(scroller)) return;

      const top = el.scrollTop;
      const next = scrollAway(state.current, {
        top,
        behind: el.scrollHeight - el.clientHeight - top,
        now: performance.now(),
      });
      const moved = next.away !== state.current.away;
      state.current = next;
      if (moved) setAway(next.away);
    };

    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, [scroller]);

  return { away: away && narrow, container, reset };
}
