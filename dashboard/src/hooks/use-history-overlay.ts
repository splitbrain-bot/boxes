import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { historyIndex } from '@/lib/history';

/**
 * Makes the back button close a modal surface instead of leaving the screen
 * under it. On a phone, back is the usual way to dismiss.
 *
 * Opening pushes a marker: one history entry at the same URL. Back pops it,
 * and the hook closes the surface. Closing from inside the surface pops the
 * marker too, so no spent entry is left behind.
 *
 * Only for surfaces that block what is behind them. A popover closes on a tap
 * anywhere, and a pop after that tap could undo a navigation the tap started.
 *
 * @param open Whether the surface is showing.
 * @param onClose Called when back closed the surface. It has to close the
 *   surface, because the marker is already gone.
 */
export function useHistoryOverlay(open: boolean, onClose: () => void): void {
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * The effects read everything from refs. `navigate` changes on every
   * location change, and an effect that depended on it would pop on every
   * navigation. The URL and state are needed as they are when the surface
   * opens.
   */
  const nav = useRef(navigate);
  nav.current = navigate;
  const close = useRef(onClose);
  close.current = onClose;
  const url = useRef('');
  url.current = `${location.pathname}${location.search}${location.hash}`;
  const state = useRef<unknown>(null);
  state.current = location.state;

  /** The index of the entry opening pushed, while it is still ours to pop. */
  const marker = useRef<number | null>(null);
  /** The URL the marker was pushed at. */
  const markerUrl = useRef('');
  /** Set when back is what closed this, so closing does not pop twice. */
  const popped = useRef(false);
  /** A pop the unmount scheduled, which a remount cancels. */
  const pending = useRef<number | null>(null);

  /*
   * A layout effect, so the marker exists before the surface is painted. A
   * back press in between would leave the screen underneath.
   */
  useLayoutEffect(() => {
    /*
     * A remount in place, as StrictMode does in development, cancels the pop
     * its unmount scheduled. That pop would land after the new marker and
     * read as a back press.
     */
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    if (!open || marker.current !== null) return;
    popped.current = false;
    // Keeps the entry's state, which a view may read, such as the thread a
    // review was opened from.
    nav.current(url.current, {
      state: { ...(state.current as object | null), overlay: true },
      preventScrollReset: true,
    });
    marker.current = historyIndex();
    markerUrl.current = url.current;
  }, [open]);

  /*
   * The browser's own event, because the router applies a location change
   * in a transition. A back press before the push reached the router leaves
   * the router's location as it was, so an effect on it would not run.
   */
  useEffect(() => {
    if (!open) return;
    const onPop = (): void => {
      if (marker.current === null) return;
      // Still on the marker, or on an entry pushed over it.
      if (historyIndex() >= marker.current) return;
      // Below the marker: back popped it.
      marker.current = null;
      popped.current = true;
      close.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);

  useEffect(() => {
    if (open) return;
    const idx = marker.current;
    marker.current = null;
    if (idx === null) return;
    if (popped.current) {
      popped.current = false;
      return;
    }
    // Closed from inside the surface.
    if (stillOnMarker(idx, markerUrl.current)) nav.current(-1);
  }, [open]);

  useEffect(
    () => () => {
      const idx = marker.current;
      if (idx === null || popped.current) return;
      // Unmounted while open, as a confirmation does when its action starts.
      // Deferred by a task, so a remount in place can cancel it.
      const at = markerUrl.current;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        marker.current = null;
        if (stillOnMarker(idx, at)) nav.current(-1);
      });
    },
    [],
  );
}

/**
 * Whether the current entry is still the marker at index `idx` and URL `at`.
 *
 * The index alone is not enough, because a replace keeps it. Deleting a box
 * replaces the entry with the list while its dialog is still mounted, and a
 * pop would then go back to the deleted box.
 */
function stillOnMarker(idx: number, at: string): boolean {
  const { pathname, search, hash } = window.location;
  return historyIndex() === idx && `${pathname}${search}${hash}` === at;
}

/**
 * The open state of a Radix root, wired to the back button with
 * {@link useHistoryOverlay}.
 *
 * Works for a controlled root with an `open` prop and for an uncontrolled one.
 * The dialog, sheet and select primitives call it, so each of them gets the
 * behaviour.
 */
export function useOverlayState({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}): { open: boolean; setOpen: (next: boolean) => void } {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolled;

  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useHistoryOverlay(
    isOpen,
    useCallback(() => setOpen(false), [setOpen]),
  );

  return { open: isOpen, setOpen };
}
