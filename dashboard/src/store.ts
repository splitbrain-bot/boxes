import { signal } from '@preact/signals';
import type { SessionSummary } from '../../shared/types.ts';
import { api } from './api.ts';

/**
 * The session list every view reads, kept fresh by polling.
 */

/** The sessions as of the last successful poll. */
export const sessions = signal<SessionSummary[]>([]);

/** The message from the last failed poll, or null. */
export const loadError = signal<string | null>(null);

/** True until the first poll has finished, however it went. */
export const loading = signal(true);

/** Time between polls, in milliseconds. */
const POLL_MS = 5000;

let timer: number | null = null;

/** Fetches the session list once. */
export async function refresh(): Promise<void> {
  try {
    sessions.value = await api.listSessions();
    loadError.value = null;
  } catch (err) {
    loadError.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

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
