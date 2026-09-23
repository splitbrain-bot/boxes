/**
 * A thread's ACP endpoint on the current origin.
 *
 * The dashboard and the gateway are both served by the orchestrator, so the
 * page's own location carries the right scheme and host. No deployment
 * setting can make it wrong, and the API carries no endpoint URL.
 *
 * Naming the thread is what lets two tabs watch two conversations of one box:
 * the connection is pinned to it for its whole life.
 */
export function wsUrlFor(boxId: string, threadId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/boxes/${boxId}/threads/${threadId}/acp`;
}

/**
 * A box's terminal endpoint on the current origin.
 *
 * Names a box and never a thread: a terminal is the box seen directly, and
 * every one opened on it attaches to the same shell.
 */
export function terminalUrlFor(boxId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/boxes/${boxId}/terminal`;
}
