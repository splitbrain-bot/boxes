import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '@/hooks/use-media-query';
import { type ScrollAwayState, scrollAway, scrollAwayStart } from '@/lib/scroll-away.ts';

/**
 * Decides if a header moves out of the way, for a scroller inside the
 * returned container. The header moves away only on a narrow screen.
 *
 * Listens in the capture phase on the container, because a scroll event does
 * not bubble. A ref on the scroller would mean editing a vendored component,
 * which `npx assistant-ui add` overwrites.
 *
 * @param scroller The selector of the scroller that the hook watches. The hook
 *   ignores other scrollers in the view, e.g., a wide table or the file tree.
 * @returns The decision, the ref for the container and a reset.
 */
export function useScrollAway(scroller: string): {
  /** True while the header should be out of the way. */
  away: boolean;
  /** The ref for the element that contains the scroller. */
  container: React.RefObject<HTMLDivElement | null>;
  /** Clears the run so far and brings the header back. */
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
   * Use it in a view that closes its scroller or opens another scroller.
   * Without a scroll, nothing would bring the header back.
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
