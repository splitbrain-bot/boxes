import { useCallback, useEffect, useState } from 'react';
import type { SessionDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { pollWhileVisible } from '@/lib/poll';

/** How often a view watching one session re-reads it, while its tab is visible. */
const POLL_MS = 5000;

/** One session, as the view watching it holds it. */
export interface WatchedSession {
  /** The session as it was last read, or null before the first answer. */
  session: SessionDetail | null;
  /** What the last read failed with, or null when it answered. */
  error: Error | null;
  /** Reads the session again, for a view that has just changed it. */
  reload: () => Promise<void>;
}

/**
 * Reads one session and keeps it fresh while the tab is visible.
 *
 * A view showing a single box asks for that box: one row off the wire instead
 * of the whole list, and a render only when this session is the one that
 * moved. The session list has a poll of its own, which runs while that screen
 * is up.
 */
export function useSession(id: string): WatchedSession {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getSession(id);
      // The same answer as the last one keeps the same object, so a poll that
      // brings back what is already on screen renders nothing.
      setSession((current) => (current && same(current, next) ? current : next));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [id]);

  useEffect(() => {
    setSession(null);
    setError(null);
    void reload();
    return pollWhileVisible(() => void reload(), POLL_MS);
  }, [reload]);

  return { session, error, reload };
}

/** Whether two readings of a session say the same thing. */
function same(a: SessionDetail, b: SessionDetail): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
