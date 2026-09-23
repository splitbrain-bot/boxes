import { useEffect, useSyncExternalStore } from 'react';
import type { HarnessInfo, ThreadDialogDefaults } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { refetchOnVisible } from '../lib/poll.ts';

/**
 * What the dialogs that start a thread are built from: every harness the
 * deployment can run, and what the last dialog chose for each.
 *
 * A store rather than per-dialog state, because two of them ask the same
 * question — the new-thread dialog and the new-box form — and because the
 * answer is deployment-wide: the last choice is stored on the orchestrator so
 * it is the same on every device, and a phone that has just been used to set
 * one should not have to be the device that opens the next dialog.
 *
 * Refetched on arrival rather than polled on a timer, which is the other half
 * of `lib/poll.ts`. Nothing here moves on its own: the catalogue changes when
 * an adapter runs, the credential when somebody visits the settings page, and
 * a dialog is a surface that is opened, answered and gone. Mounting one reads
 * the current answer, and coming back to a tab that has been away reads it
 * again; in between there is nothing to poll for. The box list's own
 * five-second poll already carries each harness's health for the warning
 * banner, which is the part that has to be noticed without being asked for.
 */

/** What a dialog reads. */
export interface HarnessesState {
  /**
   * Every harness, in the registry's order. Null until the first answer, so a
   * dialog can tell "still loading" from "this deployment runs nothing" — one
   * waits and the other is a deployment with no agents at all.
   */
  harnesses: HarnessInfo[] | null;
  /** The last dialog choice per harness id, empty until anything has chosen. */
  dialogs: Record<string, ThreadDialogDefaults>;
  /** The message from the last failed load, or null. */
  error: string | null;
}

let state: HarnessesState = { harnesses: null, dialogs: {}, error: null };
const listeners = new Set<() => void>();

function set(next: Partial<HarnessesState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reads the list and the stored choices once.
 *
 * Settled apart the way the box store settles its two calls: a failed
 * settings read says nothing about the harnesses, and a dialog with the
 * harnesses and no remembered choice is a dialog on the registry defaults,
 * which is a working dialog.
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
 * Stores what a dialog chose for one harness, so the next one opens on it.
 *
 * The patch names the one harness rather than the whole map: the orchestrator
 * merges the dialogs entry by entry, so two browsers configuring two agents
 * do not overwrite each other. Failure is silent on purpose — the thread has
 * been created by the time this runs, and a dialog default that did not stick
 * is not something to interrupt anybody about.
 */
export async function rememberDialog(
  harnessId: string,
  defaults: ThreadDialogDefaults,
): Promise<void> {
  // Written locally first, so a dialog reopened before the answer comes back
  // shows what was just chosen rather than what was chosen before it.
  set({ dialogs: { ...state.dialogs, [harnessId]: defaults } });
  try {
    const saved = await api.patchSettings({ dialogs: { [harnessId]: defaults } });
    set({ dialogs: saved.dialogs });
  } catch {
    // Kept as chosen locally; the next load reads whatever the orchestrator
    // actually holds.
  }
}

/**
 * Reads the harness list, loading it on mount and again whenever the tab
 * comes back.
 *
 * Called from the surfaces that offer the choice rather than from the app
 * shell, so a deployment whose dialogs are never opened never asks.
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
