/**
 * Builds the URL of a thread's ACP endpoint on the current origin.
 *
 * The orchestrator serves both the dashboard and the gateway, so the page's
 * location has the right scheme and host.
 *
 * @param boxId The id of the box.
 * @param threadId The id of the thread.
 * @returns The WebSocket URL.
 */
export function wsUrlFor(boxId: string, threadId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/boxes/${boxId}/threads/${threadId}/acp`;
}

/**
 * Builds the URL of a box's terminal endpoint on the current origin. It names
 * no thread, because every terminal on a box attaches to the same shell.
 *
 * @param boxId The id of the box.
 * @returns The WebSocket URL.
 */
export function terminalUrlFor(boxId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/boxes/${boxId}/terminal`;
}
