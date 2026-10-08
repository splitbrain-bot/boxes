import type {
  AgentBundlePreview,
  AgentItemBody,
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
 * A request the API refused, with the HTTP status and the API's message.
 *
 * A caller shows the message. The status lets a caller act on a refusal, such
 * as a save the file's hash turned down.
 */
export class ApiError extends Error {
  /**
   * @param status The HTTP status of the response.
   * @param message The API's error message, or the status line.
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Sends one JSON request and returns the parsed body, or undefined for a 204.
 * Throws an {@link ApiError} when the response is not a success.
 *
 * Sets the JSON content type only when the call has a body, because the API
 * rejects an empty body that claims to be JSON.
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

/** Typed client for the orchestrator's REST API. */
export const api = {
  /** Lists every box. */
  listBoxes: () => request<BoxSummary[]>('/api/boxes'),
  /** Reads one box. */
  getBox: (id: string) => request<BoxDetail>(`/api/boxes/${id}`),
  /** Creates a box. */
  createBox: (body: CreateBoxBody) =>
    request<BoxDetail>('/api/boxes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Starts a box's container. */
  startBox: (id: string) =>
    request<BoxDetail>(`/api/boxes/${id}/start`, { method: 'POST' }),
  /** Stops a box's container. */
  stopBox: (id: string) =>
    request<BoxDetail>(`/api/boxes/${id}/stop`, { method: 'POST' }),
  /** Deletes a box. */
  deleteBox: (id: string) => request<void>(`/api/boxes/${id}`, { method: 'DELETE' }),
  /** Lists a box's threads. */
  listThreads: (id: string) => request<ThreadSummary[]>(`/api/boxes/${id}/threads`),
  /** Adds a thread to a box, empty or with the context of the thread named by `from`. */
  createThread: (id: string, body: CreateThreadBody = {}) =>
    request<ThreadSummary>(`/api/boxes/${id}/threads`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Marks a thread done, or removes the mark, and returns the thread.
   *
   * The mark only changes how the thread is drawn.
   */
  setThreadDone: (id: string, threadId: string, done: boolean) =>
    request<ThreadSummary>(`/api/boxes/${id}/threads/${threadId}/done`, {
      method: 'POST',
      body: JSON.stringify({ done }),
    }),
  /**
   * Stops one task a thread left running, or every task it has, and returns
   * how many the adapter stopped.
   *
   * A cancel does not reach a background command, because the command
   * outlives the turn that started it.
   *
   * @param processId The adapter's id for the task. Without it, every task
   *   of the thread stops.
   */
  stopBackgroundWork: (id: string, threadId: string, processId?: string) =>
    request<{ stopped: number }>(`/api/boxes/${id}/threads/${threadId}/background/stop`, {
      method: 'POST',
      body: JSON.stringify({ processId }),
    }),
  /**
   * Kills every process in a box that Boxes did not start itself, and returns
   * how many processes got the signal.
   *
   * After an adapter restart, no adapter knows the tasks the old process left
   * running. The orchestrator reads the box's process table instead.
   */
  stopBoxWork: (id: string) =>
    request<{ stopped: number }>(`/api/boxes/${id}/background/stop`, { method: 'POST' }),
  /**
   * Uploads one attached file into the box's workspace and returns where it
   * was stored.
   *
   * The body is the raw bytes. The file name travels in the query.
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
  /** Reads the orchestrator's health probe. */
  health: () => request<HealthResponse>('/healthz'),
  /** Reads the public key a browser subscribes to push with. */
  pushKey: () => request<PushKeyResponse>('/api/push/key'),
  /** Registers a browser's push subscription. */
  subscribePush: (body: PushSubscribeBody) =>
    request<void>('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Removes the push subscription with this endpoint. */
  unsubscribePush: (endpoint: string) =>
    request<void>('/api/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),

  // --- code review over the box's workspace ---------------------------

  /**
   * Reads one directory of the review, with everything the side panel needs
   * around it.
   *
   * @param path Workspace-relative, and empty for the workspace root.
   * @param fresh True when the browser has just arrived rather than opened a
   *   folder. It makes the orchestrator ask git again.
   */
  reviewDir: (id: string, path: string, fresh: boolean) =>
    request<ReviewDirResponse>(
      `/api/boxes/${id}/review/dir?path=${encodeURIComponent(path)}${fresh ? '&fresh=1' : ''}`,
    ),
  /** Reads one file of the review, with everything the file view needs. */
  reviewFile: (id: string, path: string) =>
    request<ReviewFileResponse>(
      `/api/boxes/${id}/review/file?path=${encodeURIComponent(path)}`,
    ),
  /** Saves an edited file and returns it as read back. */
  saveReviewFile: (id: string, body: ReviewFileBody) =>
    request<ReviewFileResponse>(`/api/boxes/${id}/review/file`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Adds or replaces the comment on one line. */
  setAnnotation: (id: string, body: ReviewAnnotationBody) =>
    request<ReviewAnnotationsResponse>(`/api/boxes/${id}/review/annotations`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Removes the comment on one line. */
  deleteAnnotation: (id: string, path: string, line: number) =>
    request<ReviewAnnotationsResponse>(
      `/api/boxes/${id}/review/annotations?path=${encodeURIComponent(path)}&line=${line}`,
      { method: 'DELETE' },
    ),
  /** Sets the revision the review compares against, or null for HEAD. */
  setReviewBase: (id: string, rev: string | null) =>
    request<ReviewBaseResponse>(`/api/boxes/${id}/review/base`, {
      method: 'PUT',
      body: JSON.stringify({ rev }),
    }),
  /** Deletes the box's REVIEW.md, which holds the review. */
  deleteReview: (id: string) =>
    request<void>(`/api/boxes/${id}/review`, { method: 'DELETE' }),

  // --- agent configuration -------------------------------------------------
  // Every change returns the whole set.

  /** Lists every agent set. */
  listAgentSets: () => request<AgentSetSummary[]>('/api/agent-sets'),
  /** Reads one agent set. */
  getAgentSet: (setId: string) => request<AgentSetDetail>(`/api/agent-sets/${setId}`),
  /** Creates an empty agent set. */
  createAgentSet: (name: string) =>
    request<AgentSetDetail>('/api/agent-sets', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  /** Renames a set or replaces its AGENTS.md. */
  updateAgentSet: (setId: string, body: { name?: string; agentsMd?: string }) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** Deletes an agent set. */
  deleteAgentSet: (setId: string) =>
    request<void>(`/api/agent-sets/${setId}`, { method: 'DELETE' }),
  /** Adds or replaces one skill of a set. */
  putAgentItem: (setId: string, body: AgentItemBody) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/items`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Removes one skill of a set. */
  deleteAgentItem: (setId: string, name: string) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/items?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  /** Reads what a box that selects this set receives, global set included. */
  agentSetPreview: (setId: string) =>
    request<AgentBundlePreview>(`/api/agent-sets/${setId}/preview`),

  // --- harnesses ------------------------------------------------------------

  /**
   * Lists every harness this deployment can run, with the registry's
   * defaults, what each adapter last advertised, and the state of its
   * credential.
   *
   * The health probe carries the same harnesses without the catalogues.
   */
  harnesses: () => request<HarnessInfo[]>('/api/harnesses'),

  // --- credentials and settings ---------------------------------------------
  // The API never returns a secret, only its account and status.

  /** Lists every stored credential. */
  listCredentials: () => request<CredentialSummary[]>('/api/credentials'),
  /** Stores a pasted secret for a credential. */
  putCredential: (id: CredentialId, method: CredentialMethod, secret: string) =>
    request<CredentialSummary>(`/api/credentials/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ method, secret }),
    }),
  /** Removes a stored credential. */
  deleteCredential: (id: CredentialId) =>
    request<void>(`/api/credentials/${id}`, { method: 'DELETE' }),

  // --- logging in to an account ---------------------------------------------
  // The orchestrator runs the harness's own CLI in a throwaway container.

  /** Starts a login and returns the id the other login calls take. */
  startLogin: (id: CredentialId) =>
    request<StartLoginResponse>(`/api/credentials/${id}/login`, { method: 'POST' }),
  /** Reads the state of a login. The page polls it. */
  loginState: (id: CredentialId, loginId: string) =>
    request<LoginState>(`/api/credentials/${id}/login/${loginId}`),
  /**
   * Hands the CLI the code the login page showed the user.
   *
   * Only Claude's CLI asks for a code. The login state reports what happens
   * next.
   */
  submitLoginCode: (id: CredentialId, loginId: string, code: string) =>
    request<void>(`/api/credentials/${id}/login/${loginId}/code`, {
      method: 'POST',
      body: JSON.stringify({ code } satisfies LoginCodeBody),
    }),
  /** Cancels a login and removes its container. */
  cancelLogin: (id: CredentialId, loginId: string) =>
    request<void>(`/api/credentials/${id}/login/${loginId}`, { method: 'DELETE' }),
  /** Reads the deployment settings. */
  getSettings: () => request<Settings>('/api/settings'),
  /** Writes the settings the body names and returns all of them. */
  patchSettings: (body: Partial<Settings>) =>
    request<Settings>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};
