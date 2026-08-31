/**
 * A thread's ACP endpoint on the current origin.
 *
 * The dashboard and the gateway are both served by the orchestrator, so the
 * page's own location carries the right scheme and host. No deployment
 * setting can make it wrong, and the API carries no endpoint URL.
 *
 * Naming the thread is what lets two tabs watch two conversations of one box:
 * the connection is pinned to it for its whole life. Naming none asks for
 * whichever thread the session has current, which is what every link from
 * before this existed — and every external ACP client — still gets.
 */
export function wsUrlFor(sessionId: string, threadId?: string | null): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = threadId
    ? `/ws/sessions/${sessionId}/threads/${threadId}/acp`
    : `/ws/sessions/${sessionId}/acp`;
  return `${scheme}//${window.location.host}${path}`;
}
