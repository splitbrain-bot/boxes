/**
 * Runs `tick` every `everyMs` while the tab is visible, and returns the
 * teardown.
 *
 * The timer pauses while the tab is hidden, so a background tab sends no
 * requests. Showing the tab again ticks at once.
 *
 * The caller makes the first tick, because a view usually loads its data on
 * mount, and a tick here would race with that load.
 */
export function pollWhileVisible(tick: () => void, everyMs: number): () => void {
  let timer: number | null = null;

  const schedule = (): void => {
    if (timer === null) timer = window.setInterval(tick, everyMs);
  };
  const pause = (): void => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const onVisibility = (): void => {
    if (document.hidden) {
      pause();
      return;
    }
    tick();
    schedule();
  };

  if (!document.hidden) schedule();
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    pause();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Runs `tick` every time the tab becomes visible again, and returns the
 * teardown.
 *
 * For a view that only needs fresh data when the reader comes back to it. On
 * a phone, that is mostly a return from another app. The caller makes the
 * first tick, because a view loads its data on mount.
 */
export function refetchOnVisible(tick: () => void): () => void {
  const onVisibility = (): void => {
    if (!document.hidden) tick();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
