import { useCallback, useRef, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { historyIndex } from '@/lib/history';

/** What a back control needs. */
export interface Up {
  /** The parent route, so the control can be a real link. */
  href: string;
  /** Handles a plain click by stepping out. A modified click follows the link. */
  onClick: (event: MouseEvent<HTMLElement>) => void;
  /** Steps out, for a control that is not a link, such as Cancel. */
  go: () => void;
  /**
   * The stack index the view was entered at.
   *
   * A view that pushes entries of its own, such as the review on a phone,
   * compares it with the current index.
   */
  entry: number;
}

/**
 * Leaves a view by going back past its own entry and every entry it pushed,
 * in one step, instead of pushing the parent. A pushed parent would make the
 * device's back button return into the view.
 *
 * When the view is the first entry of the app, as after a pasted link or a
 * push notification, the parent replaces the current entry instead.
 *
 * Call it in the view that owns the route, because it records the index at
 * its first render.
 *
 * @param parent The parent route, for the link and for the fallback.
 */
export function useUp(parent: string): Up {
  const navigate = useNavigate();
  /**
   * The stack index this view was entered at, set on the first render.
   * Re-entering the view remounts it and sets it again.
   */
  const entry = useRef<number | null>(null);
  entry.current ??= historyIndex();

  const go = useCallback(() => {
    const from = entry.current ?? historyIndex();
    // Every entry this view added, plus the entry the view itself is.
    const delta = historyIndex() - from + 1;
    if (from > 0 && delta > 0) navigate(-delta);
    // No app entry below: replace instead of push, so back still leaves the app.
    else void navigate(parent, { replace: true });
  }, [navigate, parent]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      // A modified click opens a tab, a window or a download through href.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      go();
    },
    [go],
  );

  return { href: parent, onClick, go, entry: entry.current };
}
