import { useEffect, useSyncExternalStore } from 'react';
import type { HarnessInfo, ThreadDialogDefaults } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { refetchOnVisible } from '../lib/poll.ts';

/**
 * Store for the harness list and the last dialog choice per harness.
 *
 * The new-thread dialog and the new-box form share it.
 */

/** What a dialog reads. */
export interface HarnessesState {
  /**
   * Every harness, in the registry's order. Null until the first answer, so a
   * dialog can tell loading apart from a deployment with no harnesses.
   */
  harnesses: HarnessInfo[] | null;
  /**
   * The last dialog choice per harness id. The orchestrator stores it, so
   * every device sees the same choice. Empty until a dialog has chosen.
   */
  dialogs: Record<string, ThreadDialogDefaults>;
  /** The message from the last failed load, or null. */
  error: string | null;
}

/** The current state. */
let state: HarnessesState = { harnesses: null, dialogs: {}, error: null };
/** The callbacks to run on every state change. */
const listeners = new Set<() => void>();

/** Merges `next` into the state and notifies every subscriber. */
function set(next: Partial<HarnessesState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Adds a subscriber and returns the function that removes it. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reads the list and the stored choices once.
 *
 * Each result is applied on its own. A failed settings read keeps the
 * harnesses, and the dialog falls back to the registry defaults.
 */
export async function loadHarnesses(): Promise<void> {
  const [list, settings] = await Promise.allSettled([api.harnesses(), api.getSettings()]);
  set({
    ...(list.status === 'fulfilled'
      ? { harnesses: list.value, error: null }
      : { error: (list.reason as Error).message }),
    ...(settings.status === 'fulfilled' ? { dialogs: settings.value.dialogs } : {}),
  });
}

/**
 * Stores what a dialog chose for one harness, so the next dialog opens on it.
 *
 * The patch names only this harness. The orchestrator merges the dialogs
 * entry by entry, so two browsers that set two harnesses keep both choices.
 * A failure stays silent, because the thread already exists by then.
 */
export async function rememberDialog(
  harnessId: string,
  defaults: ThreadDialogDefaults,
): Promise<void> {
  // Set locally first, so a dialog reopened before the answer shows the new
  // choice.
  set({ dialogs: { ...state.dialogs, [harnessId]: defaults } });
  try {
    const saved = await api.patchSettings({ dialogs: { [harnessId]: defaults } });
    set({ dialogs: saved.dialogs });
  } catch {
    // Keeps the local choice. The next load reads what the orchestrator holds.
  }
}

/**
 * Reads the harness list, loading it on mount and again whenever the tab
 * becomes visible.
 *
 * Nothing here changes on its own, so there is no timer. The surfaces that
 * offer the choice call it, so the list loads only when a dialog opens.
 */
export function useHarnesses(): HarnessesState {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  useEffect(() => {
    void loadHarnesses();
    return refetchOnVisible(() => void loadHarnesses());
  }, []);
  return current;
}
