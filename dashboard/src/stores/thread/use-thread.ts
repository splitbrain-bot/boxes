import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AcpClient } from './acp-client.ts';
import { ThreadStore, type ThreadSnapshot } from './thread-store.ts';
import { wsUrlFor } from '@/lib/ws-url';

/**
 * Mounts one session's ThreadStore for as long as the view is on screen.
 *
 * The store outlives no route: leaving the thread closes the WebSocket, and
 * coming back replays. The agent's turn is unaffected either way — the
 * orchestrator, not this browser, is the ACP client of record.
 */
export function useThread(
  sessionId: string,
  token: string | null,
): { store: ThreadStore | null; state: ThreadSnapshot } {
  const [store, setStore] = useState<ThreadStore | null>(null);

  const url = useMemo(() => wsUrlFor(sessionId), [sessionId]);

  useEffect(() => {
    if (!token) return undefined;
    const created = new ThreadStore({
      sessionId,
      createClient: (handlers) => new AcpClient(url, token, handlers),
    });
    setStore(created);
    created.start();
    return () => {
      created.dispose();
      setStore(null);
    };
  }, [sessionId, url, token]);

  const state = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : getInitial,
    store ? store.getSnapshot : getInitial,
  );

  return { store, state };
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** The state a view shows before the store exists. */
const INITIAL: ThreadSnapshot = {
  messages: [],
  isRunning: false,
  connection: 'connecting',
  modes: null,
  plan: null,
  commands: [],
  error: null,
};

const getInitial = (): ThreadSnapshot => INITIAL;
