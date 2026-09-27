import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AcpClient } from './acp-client.ts';
import { INITIAL_SNAPSHOT, ThreadStore, type ThreadSnapshot } from './thread-store.ts';
import { wsUrlFor } from '@/lib/ws-url';

/**
 * Mounts one thread's ThreadStore for as long as the view is on screen.
 *
 * `threadId` is part of the connection URL, so a switch to another thread
 * replaces the store. Leaving the thread closes the WebSocket, and coming
 * back replays. The agent's turn continues either way, because the
 * orchestrator is the ACP client of record.
 */
export function useThread(
  boxId: string,
  threadId: string,
  token: string | null,
): { store: ThreadStore | null; state: ThreadSnapshot } {
  const [store, setStore] = useState<ThreadStore | null>(null);

  const url = useMemo(() => wsUrlFor(boxId, threadId), [boxId, threadId]);

  useEffect(() => {
    if (!token) return undefined;
    const created = new ThreadStore({
      boxId,
      threadId,
      createClient: (handlers) => new AcpClient(url, token, handlers),
    });
    setStore(created);
    created.start();
    return () => {
      created.dispose();
      setStore(null);
    };
  }, [boxId, threadId, url, token]);

  const state = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : getInitial,
    store ? store.getSnapshot : getInitial,
  );

  return { store, state };
}

/** A subscribe function for the time before the store exists. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** The state a view shows before the store exists: the store's first snapshot. */
const getInitial = (): ThreadSnapshot => INITIAL_SNAPSHOT;
