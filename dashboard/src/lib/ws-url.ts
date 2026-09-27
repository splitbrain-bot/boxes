/**
 * A thread's ACP endpoint on the current origin.
 *
 * The orchestrator serves both the dashboard and the gateway, so the page's
 * location has the right scheme and host.
 */
export function wsUrlFor(boxId: string, threadId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/boxes/${boxId}/threads/${threadId}/acp`;
}

/**
 * A box's terminal endpoint on the current origin. It names no thread, because
 * every terminal on a box attaches to the same shell.
 */
export function terminalUrlFor(boxId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/boxes/${boxId}/terminal`;
}
