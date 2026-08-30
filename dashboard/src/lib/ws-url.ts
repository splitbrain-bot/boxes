/**
 * This session's ACP endpoint on the current origin.
 *
 * The dashboard and the gateway are both served by the orchestrator, so the
 * page's own location carries the right scheme and host. No deployment
 * setting can make it wrong, and the API carries no endpoint URL.
 */
export function wsUrlFor(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/sessions/${sessionId}/acp`;
}
