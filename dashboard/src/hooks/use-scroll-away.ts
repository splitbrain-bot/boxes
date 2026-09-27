import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';
import { scrollAway, scrollAwayStart, type ScrollAwayState } from '@/lib/scroll-away.ts';

/**
 * Whether a header should move out of the way, for a scroller inside the
 * returned container. Only on a narrow screen.
 *
 * Listens in the capture phase on the container, because a scroll event does
 * not bubble. A ref on the scroller would mean editing a vendored component,
 * which `npx assistant-ui add` overwrites.
 *
 * @param scroller Selector for the scroller that counts. Other scrollers in
 *   the view, such as a wide table or the file tree, do not count.
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
   * The decision's state. It changes on every scroll event, and `away`
   * changes only when the decision does.
   */
  const state = useRef<ScrollAwayState>(scrollAwayStart());

  /**
   * Brings the header back and forgets the run so far.
   *
   * For a view that closes its scroller or opens another. A header left away
   * there would have no scroll to bring it back.
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
