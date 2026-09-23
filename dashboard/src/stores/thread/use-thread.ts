import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AcpClient } from './acp-client.ts';
import { INITIAL_SNAPSHOT, ThreadStore, type ThreadSnapshot } from './thread-store.ts';
import { wsUrlFor } from '@/lib/ws-url';

/**
 * Mounts one thread's ThreadStore for as long as the view is on screen.
 *
 * `threadId` names which of the box's conversations this is. It is part of
 * the URL the connection opens, so moving between two threads tears one store down
 * and builds the other — two tabs on two threads hold two of these, and
 * neither sees the other's stream.
 *
 * The store outlives no route: leaving the thread closes the WebSocket, and
 * coming back replays. The agent's turn is unaffected either way — the
 * orchestrator, not this browser, is the ACP client of record.
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

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * The state a view shows before the store exists.
 *
 * The store's own first snapshot: no store yet is the same to a reader as a
 * store with nothing read into it — something is on its way and this is not
 * it.
 */
const getInitial = (): ThreadSnapshot => INITIAL_SNAPSHOT;
