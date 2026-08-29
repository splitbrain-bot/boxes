import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { SessionDetail as SessionDetailType } from '../../../shared/types.ts';
import { connectToSession, wsUrlFor } from '../acpui.ts';
import { api } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { CopyField } from '../components/CopyField.tsx';
import { sessionBadges } from '../components/SessionCard.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { refresh } from '../store.ts';
import './SessionDetail.css';

export function SessionDetail() {
  const { params } = useRoute();
  const { route } = useLocation();
  const id = params['id'] ?? '';

  const [session, setSession] = useState<SessionDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [purge, setPurge] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);

  const load = async (): Promise<void> => {
    try {
      setSession(await api.getSession(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [id]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <div class="SessionDetail">
        <a class="SessionDetail-back" href="/">
          ← Sessions
        </a>
        {error ? <div class="SessionDetail-error">{error}</div> : <div>Loading…</div>}
      </div>
    );
  }

  const running = session.dockerState === 'running';

  return (
    <div class="SessionDetail">
      <a class="SessionDetail-back" href="/">
        ← Sessions
      </a>

      <div class="SessionDetail-head">
        <h1 class="SessionDetail-title">{session.name}</h1>
        <div class="SessionDetail-badges">
          {sessionBadges(session).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
        </div>
      </div>

      {error ? <div class="SessionDetail-error">{error}</div> : null}

      {running && !session.proxyAttached ? (
        <div class="SessionDetail-warning">
          The egress proxy is not attached to this session's network — the agent has no
          internet access until the reconcile loop reattaches it.
        </div>
      ) : null}

      <div class="SessionDetail-section">
        <button
          type="button"
          class="SessionDetail-connect"
          onClick={() => {
            if (!connectToSession(session)) setStorageBlocked(true);
          }}
        >
          Open in acp-ui
        </button>
        <span class="SessionDetail-connectHint">
          Configures acp-ui for this session and opens it. Nothing to type.
        </span>

        {storageBlocked ? (
          <span class="SessionDetail-error">
            This browser blocked local storage, so acp-ui cannot be configured
            automatically. Use the manual details below.
          </span>
        ) : null}

        {/* Safety net: acp-ui's stored config format is the one thing here
            that depends on its internals, so keep a manual path available. */}
        <details class="SessionDetail-manual">
          <summary class="SessionDetail-manualSummary">Connect manually instead</summary>
          <div class="SessionDetail-manualBody">
            <ol class="SessionDetail-steps">
              <li>In acp-ui, go to Settings → add agent.</li>
              <li>Choose transport “websocket”.</li>
              <li>Paste the URL below.</li>
              <li>
                Set header <code>Authorization: Bearer &lt;token&gt;</code> with the token
                below.
              </li>
            </ol>
            <CopyField label="WebSocket URL" value={wsUrlFor(session.id)} />
            <CopyField label="Bearer token" value={session.wsToken} masked />
          </div>
        </details>
      </div>

      <div class="SessionDetail-section">
        <div class="SessionDetail-sectionTitle">Details</div>
        <div class="SessionDetail-meta">
          <span class="SessionDetail-metaKey">Session</span>
          <span class="SessionDetail-metaValue">{session.id}</span>
          <span class="SessionDetail-metaKey">Repo</span>
          <span class="SessionDetail-metaValue">{session.repoUrl ?? '—'}</span>
          <span class="SessionDetail-metaKey">ACP thread</span>
          <span class="SessionDetail-metaValue">{session.acpSessionId ?? 'not started'}</span>
          <span class="SessionDetail-metaKey">Container</span>
          <span class="SessionDetail-metaValue">
            {session.containerId ? session.containerId.slice(0, 12) : '—'}
          </span>
          <span class="SessionDetail-metaKey">Network</span>
          <span class="SessionDetail-metaValue">
            {session.networkName} ({session.subnet})
          </span>
          <span class="SessionDetail-metaKey">Last active</span>
          <span class="SessionDetail-metaValue">
            {new Date(session.lastActiveAt).toLocaleString()}
          </span>
        </div>
      </div>

      <div class="SessionDetail-actions">
        {running ? (
          <button type="button" disabled={busy} onClick={() => void act(() => api.stopSession(id))}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => api.startSession(id))}
          >
            Start
          </button>
        )}
        <button
          type="button"
          class="SessionDetail-danger"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${session.name}?`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            void act(async () => {
              await api.deleteSession(id, purge);
              route('/');
            })
          }
        >
          <div class="ConfirmDialog-options">
            <span>
              The container and network are removed. Volumes are kept unless you purge them.
            </span>
            <label class="ConfirmDialog-check">
              <input
                type="checkbox"
                checked={purge}
                onChange={(e) => setPurge((e.target as HTMLInputElement).checked)}
              />
              Also delete volumes (workspace and thread history)
            </label>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
