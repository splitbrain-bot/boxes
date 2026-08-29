import { signal } from '@preact/signals';
import type { SessionSummary } from '../../shared/types.ts';
import { api } from './api.ts';

/**
 * Signals store. Polls GET /api/sessions every 5s while the tab is visible
 * and pauses on visibilitychange — SSE is an M7 upgrade, not v1 (plan §8.5).
 */

export const sessions = signal<SessionSummary[]>([]);
export const loadError = signal<string | null>(null);
export const loading = signal(true);

const POLL_MS = 5000;
let timer: number | null = null;

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

function schedule(): void {
  if (timer !== null) return;
  timer = window.setInterval(() => void refresh(), POLL_MS);
}

function pause(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

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
