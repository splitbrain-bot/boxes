import { useSyncExternalStore } from 'react';
import type { SessionSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';

/**
 * The session list every view reads, kept fresh by polling.
 *
 * A plain module-level store with a subscriber set: React reads it through
 * useSyncExternalStore, and nothing outside this file needs a hook to change
 * it.
 */

/** What the views render. */
export interface SessionsState {
  sessions: SessionSummary[];
  /** The message from the last failed poll, or null. */
  error: string | null;
  /** True until the first poll has finished, however it went. */
  loading: boolean;
}

let state: SessionsState = { sessions: [], error: null, loading: true };
const listeners = new Set<() => void>();

/** Replaces the state and wakes every subscriber. */
function set(next: Partial<SessionsState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the polled session list, re-rendering on every change. */
export function useSessions(): SessionsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Fetches the session list once. */
export async function refresh(): Promise<void> {
  try {
    set({ sessions: await api.listSessions(), error: null, loading: false });
  } catch (err) {
    set({ error: (err as Error).message, loading: false });
  }
}

/** Time between polls, in milliseconds. */
const POLL_MS = 5000;

let timer: number | null = null;

/** Starts the poll timer, unless it already runs. */
function schedule(): void {
  if (timer !== null) return;
  timer = window.setInterval(() => void refresh(), POLL_MS);
}

/** Stops the poll timer. */
function pause(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

/** Polls for as long as the tab is visible, resuming on the way back. */
export function startPolling(): void {
  void refresh();
  schedule();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pause();
    } else {
      void refresh();
      schedule();
    }
  });
}
