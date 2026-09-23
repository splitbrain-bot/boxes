import type {
  AgentBundlePreview,
  AgentItemBody,
  AgentItemKind,
  AgentSetDetail,
  AgentSetSummary,
  CreateBoxBody,
  CreateThreadBody,
  CredentialId,
  CredentialMethod,
  CredentialSummary,
  HarnessInfo,
  HealthResponse,
  LoginCodeBody,
  LoginState,
  PushKeyResponse,
  PushSubscribeBody,
  ReviewAnnotationBody,
  ReviewAnnotationsResponse,
  ReviewBaseResponse,
  ReviewDirResponse,
  ReviewFileBody,
  ReviewFileResponse,
  BoxDetail,
  BoxSummary,
  Settings,
  StartLoginResponse,
  StoredAttachment,
  ThreadSummary,
} from '../../shared/types.ts';

/**
 * Typed fetch client for the orchestrator's REST API.
 */

/**
 * A request the API refused, carrying the status alongside the message.
 *
 * The message is what a caller shows; the status is for the few refusals a
 * caller can act on rather than merely report — a save the file's own hash
 * turned down, above all.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Sends one JSON request and returns the parsed body. Throws with the API's
 * own error message when the response is not a success.
 *
 * The content type is declared only for a call that carries a body: the API
 * rejects an empty body that claims to be JSON, and start, stop and delete
 * send none.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Every REST call the dashboard makes. */
export const api = {
  listBoxes: () => request<BoxSummary[]>('/api/boxes'),
  getBox: (id: string) => request<BoxDetail>(`/api/boxes/${id}`),
  createBox: (body: CreateBoxBody) =>
    request<BoxDetail>('/api/boxes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startBox: (id: string) =>
    request<BoxDetail>(`/api/boxes/${id}/start`, { method: 'POST' }),
  stopBox: (id: string) =>
    request<BoxDetail>(`/api/boxes/${id}/stop`, { method: 'POST' }),
  deleteBox: (id: string) => request<void>(`/api/boxes/${id}`, { method: 'DELETE' }),
  listThreads: (id: string) => request<ThreadSummary[]>(`/api/boxes/${id}/threads`),
  createThread: (id: string, body: CreateThreadBody = {}) =>
    request<ThreadSummary>(`/api/boxes/${id}/threads`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Marks a conversation done, or takes the mark off again.
   *
   * The reader's own note about being finished with a thread. It changes how
   * the thread is drawn and nothing else, so nothing here waits on it beyond
   * reading the row back.
   */
  setThreadDone: (id: string, threadId: string, done: boolean) =>
    request<ThreadSummary>(`/api/boxes/${id}/threads/${threadId}/done`, {
      method: 'POST',
      body: JSON.stringify({ done }),
    }),
  /**
   * Kills what a conversation left running in its box: one process, or all of
   * them.
   *
   * Not `session/cancel`, which is what the composer's stop sends. That
   * interrupts the conversation and reaches the subagents a turn is being
   * held open for; it does nothing to a command still running, which is a
   * child of the agent's own process and outlives the turn by design.
   */
  stopBackgroundWork: (id: string, threadId: string, processId?: string) =>
    request<{ stopped: number }>(`/api/boxes/${id}/threads/${threadId}/background/stop`, {
      method: 'POST',
      body: JSON.stringify({ processId }),
    }),
  /**
   * Kills everything running in a box, whichever conversation started it, and
   * answers with how many processes were signalled.
   *
   * The one above names a task an adapter announced; this one names nothing.
   * It is the floor under the bars: after a respawn no adapter knows about
   * the shells the one before it left running, so the orchestrator reads the
   * box's own process table and signals what it finds there. The card offers
   * it only for that case — work running with no conversation claiming it.
   */
  stopBoxWork: (id: string) =>
    request<{ stopped: number }>(`/api/boxes/${id}/background/stop`, { method: 'POST' }),
  /**
   * Stores one file the user attached, and answers with where it landed.
   *
   * The bytes go up as themselves rather than as a form or as base64: this
   * is the one call in the client that carries a file, and the endpoint
   * wants nothing else from it but the name, which travels in the query.
   */
  uploadAttachment: (id: string, file: File) =>
    request<StoredAttachment>(
      `/api/boxes/${id}/attachments?name=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      },
    ),
  health: () => request<HealthResponse>('/healthz'),
  pushKey: () => request<PushKeyResponse>('/api/push/key'),
  subscribePush: (body: PushSubscribeBody) =>
    request<void>('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  unsubscribePush: (endpoint: string) =>
    request<void>('/api/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),

  // --- code review over the box's workspace ---------------------------
  //
  // Batched to match the endpoints: the directory call carries a folder and
  // everything the left panel needs around it, and the file call the whole
  // file view, so a phone on a slow link makes one request per screen.

  /**
   * One directory of the review. `path` is empty for the workspace root, and
   * `fresh` says the browser has arrived rather than opened a folder — which
   * is what asks the orchestrator for git's answer again.
   */
  reviewDir: (id: string, path: string, fresh: boolean) =>
    request<ReviewDirResponse>(
      `/api/boxes/${id}/review/dir?path=${encodeURIComponent(path)}${fresh ? '&fresh=1' : ''}`,
    ),
  reviewFile: (id: string, path: string) =>
    request<ReviewFileResponse>(
      `/api/boxes/${id}/review/file?path=${encodeURIComponent(path)}`,
    ),
  saveReviewFile: (id: string, body: ReviewFileBody) =>
    request<ReviewFileResponse>(`/api/boxes/${id}/review/file`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  setAnnotation: (id: string, body: ReviewAnnotationBody) =>
    request<ReviewAnnotationsResponse>(`/api/boxes/${id}/review/annotations`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAnnotation: (id: string, path: string, line: number) =>
    request<ReviewAnnotationsResponse>(
      `/api/boxes/${id}/review/annotations?path=${encodeURIComponent(path)}&line=${line}`,
      { method: 'DELETE' },
    ),
  setReviewBase: (id: string, rev: string | null) =>
    request<ReviewBaseResponse>(`/api/boxes/${id}/review/base`, {
      method: 'PUT',
      body: JSON.stringify({ rev }),
    }),
  deleteReview: (id: string) =>
    request<void>(`/api/boxes/${id}/review`, { method: 'DELETE' }),

  // --- agent configuration -------------------------------------------------
  //
  // Every mutation answers with the whole set, so the editor never has to
  // stitch a patch into what it already holds.

  listAgentSets: () => request<AgentSetSummary[]>('/api/agent-sets'),
  getAgentSet: (setId: string) => request<AgentSetDetail>(`/api/agent-sets/${setId}`),
  createAgentSet: (name: string) =>
    request<AgentSetDetail>('/api/agent-sets', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateAgentSet: (setId: string, body: { name?: string; agentsMd?: string }) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteAgentSet: (setId: string) =>
    request<void>(`/api/agent-sets/${setId}`, { method: 'DELETE' }),
  putAgentItem: (setId: string, body: AgentItemBody) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/items`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAgentItem: (setId: string, kind: AgentItemKind, name: string) =>
    request<AgentSetDetail>(
      `/api/agent-sets/${setId}/items?kind=${kind}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  agentSetPreview: (setId: string) =>
    request<AgentBundlePreview>(`/api/agent-sets/${setId}/preview`),

  // --- harnesses ------------------------------------------------------------
  //
  // What agents this deployment can run. One call, because a dialog needs the
  // registry's defaults, the catalogue and the credential's state together
  // and has nothing to do with any of them apart.

  /**
   * Every harness this deployment can run: the registry's defaults, whatever
   * each adapter last advertised, and whether each has a credential that
   * works.
   *
   * What the dialogs are built from. The health probe carries the same
   * harnesses without their catalogues, which is all a warning needs; this is
   * the call for the view that has to offer the choice.
   */
  harnesses: () => request<HarnessInfo[]>('/api/harnesses'),

  // --- credentials and settings ---------------------------------------------
  //
  // Secrets go one way. A credential is written by pasting it and comes back
  // as an account and a status, never as the value, so nothing here can show
  // one and nothing here has to be careful not to.

  listCredentials: () => request<CredentialSummary[]>('/api/credentials'),
  putCredential: (id: CredentialId, method: CredentialMethod, secret: string) =>
    request<CredentialSummary>(`/api/credentials/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ method, secret }),
    }),
  deleteCredential: (id: CredentialId) =>
    request<void>(`/api/credentials/${id}`, { method: 'DELETE' }),

  // --- logging in to an account ---------------------------------------------
  //
  // The other way a credential arrives, for the ones that have no static form
  // to paste. The orchestrator runs the harness's own CLI in a throwaway
  // container and this is the window onto it: start it, ask where it has got
  // to until it is somewhere, hand back a code where the CLI wants one, and
  // give up by saying so rather than by closing the tab.

  /** Starts a login and answers with the id every call below names. */
  startLogin: (id: CredentialId) =>
    request<StartLoginResponse>(`/api/credentials/${id}/login`, { method: 'POST' }),
  /** Where that login has got to, as the page polls it. */
  loginState: (id: CredentialId, loginId: string) =>
    request<LoginState>(`/api/credentials/${id}/login/${loginId}`),
  /**
   * Hands the CLI the code the login page gave the person.
   *
   * Only Claude's flow asks for one: its CLI prints a URL and then blocks on
   * a prompt. Codex prints the code instead and polls for itself, and there
   * is nothing to send back. The answer is not read — where the login goes
   * next is what the poll above says.
   */
  submitLoginCode: (id: CredentialId, loginId: string, code: string) =>
    request<void>(`/api/credentials/${id}/login/${loginId}/code`, {
      method: 'POST',
      body: JSON.stringify({ code } satisfies LoginCodeBody),
    }),
  /** Gives up on a login, and takes the container it was running in with it. */
  cancelLogin: (id: CredentialId, loginId: string) =>
    request<void>(`/api/credentials/${id}/login/${loginId}`, { method: 'DELETE' }),
  getSettings: () => request<Settings>('/api/settings'),
  patchSettings: (body: Partial<Settings>) =>
    request<Settings>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};
