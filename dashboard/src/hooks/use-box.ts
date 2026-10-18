import { useCallback, useEffect, useState } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import type { BoxDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';

/** The poll interval in milliseconds for a view that watches one box, while its tab is visible. */
const POLL_MS = 5000;

/** The state of one box in the view that watches it. */
export interface WatchedBox {
  /** The box as it was last read, or null before the first answer. */
  box: BoxDetail | null;
  /** The error of the last read, or null when the read succeeded. */
  error: Error | null;
  /** Reads the box again, for a view that has just changed it. */
  reload: () => Promise<void>;
}

/**
 * Reads one box and polls it while the tab is visible.
 *
 * A view renders again only when the box changed.
 *
 * @param id The id of the box.
 * @returns The box, the error of the last read and a function to read the box again.
 */
export function useBox(id: string): WatchedBox {
  const [box, setBox] = useState<BoxDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getBox(id);
      // Keeps the old object for an unchanged answer, so React does not render again.
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

/**
 * Checks if two reads of a box have the same content.
 *
 * @param a The first read.
 * @param b The second read.
 * @returns True when both reads have the same content.
 */
function same(a: BoxDetail, b: BoxDetail): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
