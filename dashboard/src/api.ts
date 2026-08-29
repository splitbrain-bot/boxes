import type {
  AcpLogPage,
  CreateSessionBody,
  HealthResponse,
  SessionDetail,
  SessionSummary,
} from '../../shared/types.ts';

/**
 * Typed fetch client for the orchestrator's REST API.
 */

/**
 * Sends one JSON request and returns the parsed body. Throws with the API's
 * own error message when the response is not a success.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Every REST call the dashboard makes. */
export const api = {
  listSessions: () => request<SessionSummary[]>('/api/sessions'),
  getSession: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  createSession: (body: CreateSessionBody) =>
    request<SessionDetail>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startSession: (id: string) =>
    request<SessionDetail>(`/api/sessions/${id}/start`, { method: 'POST' }),
  stopSession: (id: string) =>
    request<SessionDetail>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  deleteSession: (id: string, purge: boolean) =>
    request<void>(`/api/sessions/${id}?purge=${purge}`, { method: 'DELETE' }),
  getLog: (id: string, after = 0) =>
    request<AcpLogPage>(`/api/sessions/${id}/log?after=${after}&limit=200`),
  health: () => request<HealthResponse>('/healthz'),
};
