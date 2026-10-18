import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { historyIndex } from '@/lib/history';

/**
 * Makes the back button close a modal surface and stay on the screen under
 * it. On a phone, back is the usual way to dismiss.
 *
 * Opening the surface pushes a marker, which is one history entry at the same
 * URL. Back pops the marker, and the hook closes the surface. Closing from
 * inside the surface also pops the marker, so no used entry stays in the
 * history.
 *
 * Use the hook only for surfaces that block what is behind them. A popover
 * closes on a tap anywhere, and a pop after that tap could undo a navigation
 * that the tap started.
 *
 * @param open True while the surface is open.
 * @param onClose Called when the back button popped the marker. It must close
 *   the surface, because the marker is already gone.
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

  /** The index of the entry that opening pushed, while the hook can still pop it. */
  const marker = useRef<number | null>(null);
  /** The URL the marker was pushed at. */
  const markerUrl = useRef('');
  /** True when the back button closed the surface, so the close does not pop twice. */
  const popped = useRef(false);
  /** The timer of a pop that the unmount scheduled. A remount cancels it. */
  const pending = useRef<number | null>(null);

  /*
   * A layout effect, so the marker exists before the surface is painted. A
   * back press in between would leave the screen underneath.
   */
  useLayoutEffect(() => {
    /*
     * A remount in place, as StrictMode does in development, cancels the pop
     * its unmount scheduled. Otherwise, the pop would come after the new marker
     * and look like a back press.
     */
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    if (!open || marker.current !== null) return;
    popped.current = false;
    // Keeps the state of the entry, because a view can read it, e.g., the
    // thread that opened a review.
    nav.current(url.current, {
      state: { ...(state.current as object | null), overlay: true },
      preventScrollReset: true,
    });
    marker.current = historyIndex();
    markerUrl.current = url.current;
  }, [open]);

  /*
   * Listens to the popstate event of the browser, because the router applies
   * a location change in a transition. A back press before the push reached the router leaves
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
 * Checks if the current entry is still the marker at index `idx` and URL `at`.
 *
 * The index alone is not enough, because a replace keeps it. Deleting a box
 * replaces the entry with the list while its dialog is still mounted, and a
 * pop would then go back to the deleted box.
 *
 * @param idx The history index of the marker.
 * @param at The URL of the marker.
 * @returns True when the current entry is the marker.
 */
function stillOnMarker(idx: number, at: string): boolean {
  const { pathname, search, hash } = window.location;
  return historyIndex() === idx && `${pathname}${search}${hash}` === at;
}

/**
 * Holds the open state of a Radix root, wired to the back button with
 * {@link useHistoryOverlay}.
 *
 * Works for a controlled root with an `open` prop and for an uncontrolled one.
 * The dialog, sheet and select primitives call it, so each of them gets the
 * behaviour.
 *
 * @param open The open state of a controlled root, or undefined for an uncontrolled root.
 * @param defaultOpen The first open state of an uncontrolled root.
 * @param onOpenChange Called with each new open state.
 * @returns The current open state and the function that changes it.
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
