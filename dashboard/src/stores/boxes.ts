import { useSyncExternalStore } from 'react';
import type {
  DeploymentImages,
  HarnessHealth,
  BoxSummary,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { pollWhileVisible } from '../lib/poll.ts';

/** Store for the box list and the deployment health facts. */

/** What the views render. */
export interface BoxesState {
  boxes: BoxSummary[];
  /**
   * Every harness the deployment can run, and whether each has a credential
   * that works.
   *
   * Empty until the first probe answers, so no warning shows before then.
   */
  harnesses: HarnessHealth[];
  /**
   * The running build of each deployment image. All three are null until a
   * probe answers.
   */
  images: DeploymentImages;
  /** The message from the last failed poll, or null. */
  error: string | null;
  /** True until the first poll has finished, however it went. */
  loading: boolean;
}

/** The current state. */
let state: BoxesState = {
  boxes: [],
  harnesses: [],
  images: { orchestrator: null, proxy: null, box: null },
  error: null,
  loading: true,
};
/** The callbacks to run on every state change. */
const listeners = new Set<() => void>();

/** Merges `next` into the state and notifies every subscriber. */
function set(next: Partial<BoxesState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Adds a subscriber and returns the function that removes it. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the polled box list, re-rendering on every change. */
export function useBoxes(): BoxesState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * Turns a failed list request into the message for the user.
 *
 * A request that never reached the server rejects with a TypeError. Its
 * browser message does not say what failed or what happens next. An error
 * message from the server passes through unchanged.
 */
function reachable(error: Error): string {
  return error instanceof TypeError
    ? 'Could not reach Boxes. Still trying.'
    : error.message;
}

/**
 * Fetches the box list and the health probe once.
 *
 * Each result is applied on its own, so one failure keeps the other answer.
 */
export async function refresh(): Promise<void> {
  const [list, health] = await Promise.allSettled([api.listBoxes(), api.health()]);
  set({
    ...(list.status === 'fulfilled'
      ? { boxes: list.value, error: null }
      : { error: reachable(list.reason as Error) }),
    ...(health.status === 'fulfilled'
      ? {
          harnesses: health.value.harnesses,
          images: health.value.images,
        }
      : {}),
    loading: false,
  });
}

/**
 * Fetches the health probe alone, for a view that shows one box and does not
 * read the list.
 */
export async function refreshHealth(): Promise<void> {
  try {
    const health = await api.health();
    set({ harnesses: health.harnesses, images: health.images });
  } catch {
    // A failed probe keeps the held values.
  }
}

/** Time between polls, in milliseconds. */
const POLL_MS = 5000;

/**
 * Refreshes now, polls while the tab is visible, and returns the teardown.
 *
 * The list screen starts it, so a browser that shows one thread does not
 * fetch every box every few seconds.
 */
export function startPolling(): () => void {
  void refresh();
  return pollWhileVisible(() => void refresh(), POLL_MS);
}
