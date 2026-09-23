import { useCallback, useEffect, useState } from 'react';
import type { BoxDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { pollWhileVisible } from '@/lib/poll';

/** How often a view watching one box re-reads it, while its tab is visible. */
const POLL_MS = 5000;

/** One box, as the view watching it holds it. */
export interface WatchedBox {
  /** The box as it was last read, or null before the first answer. */
  box: BoxDetail | null;
  /** What the last read failed with, or null when it answered. */
  error: Error | null;
  /** Reads the box again, for a view that has just changed it. */
  reload: () => Promise<void>;
}

/**
 * Reads one box and keeps it fresh while the tab is visible.
 *
 * A view showing a single box asks for that box: one row off the wire instead
 * of the whole list, and a render only when this box is the one that
 * moved. The box list has a poll of its own, which runs while that screen
 * is up.
 */
export function useBox(id: string): WatchedBox {
  const [box, setBox] = useState<BoxDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getBox(id);
      // The same answer as the last one keeps the same object, so a poll that
      // brings back what is already on screen renders nothing.
      setBox((current) => (current && same(current, next) ? current : next));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [id]);

  useEffect(() => {
    setBox(null);
    setError(null);
    void reload();
    return pollWhileVisible(() => void reload(), POLL_MS);
  }, [reload]);

  return { box, error, reload };
}

/** Whether two readings of a box say the same thing. */
function same(a: BoxDetail, b: BoxDetail): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
