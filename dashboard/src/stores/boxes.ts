import { useSyncExternalStore } from 'react';
import type {
  DeploymentImages,
  HarnessHealth,
  BoxSummary,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { pollWhileVisible } from '../lib/poll.ts';

/**
 * The box list, together with the deployment facts a view has to warn
 * about.
 *
 * The list screen polls the whole of it while it is up. A view watching one
 * box reads that box for itself and takes only the deployment facts
 * from here.
 *
 * A plain module-level store with a subscriber set: React reads it through
 * useSyncExternalStore, and nothing outside this file needs a hook to change
 * it.
 */

/** What the views render. */
export interface BoxesState {
  boxes: BoxSummary[];
  /**
   * Every harness the deployment can run, and whether each has a credential
   * that works.
   *
   * Empty until a probe has answered, so a slow first answer warns about
   * nothing: a harness nobody has heard of yet is not a harness that cannot
   * run.
   */
  harnesses: HarnessHealth[];
  /**
   * Which build of each of the deployment's images is running, all three null
   * until a probe has said otherwise.
   */
  images: DeploymentImages;
  /** The message from the last failed poll, or null. */
  error: string | null;
  /** True until the first poll has finished, however it went. */
  loading: boolean;
}

let state: BoxesState = {
  boxes: [],
  harnesses: [],
  images: { orchestrator: null, proxy: null, box: null },
  error: null,
  loading: true,
};
const listeners = new Set<() => void>();

/** Replaces the state and wakes every subscriber. */
function set(next: Partial<BoxesState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

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
 * What a failed list says, in the terms of the thing that went wrong.
 *
 * A request that never reached the server rejects with the browser's own
 * "Failed to fetch", which names neither what failed nor what happens next.
 * An answer the server did send is already a sentence, and is passed through.
 */
function reachable(error: Error): string {
  return error instanceof TypeError
    ? 'Could not reach Boxes. Still trying.'
    : error.message;
}

/**
 * Fetches the box list and the health probe once.
 *
 * The two are settled apart: a failed probe says nothing about the boxes,
 * and neither does a failed list say anything about the credentials, so one
 * failure never discards the other's answer.
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
 * Fetches the health probe alone.
 *
 * For a view that watches one box rather than the list: which harnesses
 * can run is a fact about the deployment, so it is asked for once on arrival
 * instead of riding along with a list that view never reads. A probe that did
 * not answer leaves what is held, because a failed probe says nothing about a
 * credential.
 */
export async function refreshHealth(): Promise<void> {
  try {
    const health = await api.health();
    set({ harnesses: health.harnesses, images: health.images });
  } catch {
    // Nothing to say, so nothing is said.
  }
}

/** Time between polls, in milliseconds. */
const POLL_MS = 5000;

/**
 * Polls for as long as the tab is visible, and returns the teardown.
 *
 * Started by the screen that shows the list, so a browser reading one
 * conversation is not asking for every box in the deployment every few
 * seconds.
 */
export function startPolling(): () => void {
  void refresh();
  return pollWhileVisible(() => void refresh(), POLL_MS);
}
