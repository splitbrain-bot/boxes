import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { SessionDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CopyField } from '@/components/CopyField';
import { sessionBadges } from '@/components/SessionCard';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { wsUrlFor } from '@/lib/ws-url';
import { refresh } from '../stores/sessions.ts';

/** One field of the details grid. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs">{value}</dd>
    </>
  );
}

/**
 * What a session is made of and what can be done to it. The conversation
 * lives at /sessions/:id; this route is the ops side of the same session.
 *
 * Back goes where the visitor came from: the list when the list sent them,
 * and otherwise the exact thread they were reading, which a header link says
 * — a session has several, and landing on whichever is current is not the
 * same as going back. A reload or a pasted URL carries no such state and
 * falls back to the session's current thread.
 */
export function SessionInfo() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const from = useLocation().state as { from?: string; threadId?: string } | null;
  const back =
    from?.from === 'list'
      ? { to: '/', label: 'Sessions' }
      : {
          to: from?.threadId
            ? `/sessions/${id}/threads/${from.threadId}`
            : `/sessions/${id}`,
          label: 'Back to the thread',
        };

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSession(await api.getSession(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

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

  /**
   * Deletes the session and leaves for the list. Not through act, which
   * reloads the session it just acted on: there is nothing left to reload,
   * and asking for it again would only answer 404.
   */
  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSession(id);
      await refresh();
      void navigate('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <div className="flex flex-col gap-4">
        <Link to={back.to} className="text-sm text-muted-foreground hover:text-foreground">
          ← {back.label}
        </Link>
        {error ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            {error}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    );
  }

  const running = session.dockerState === 'running';

  return (
    <div className="flex flex-col gap-4">
      <Link
        to={back.to}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {back.label}
      </Link>

      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{session.name}</h1>
        <div className="flex flex-wrap gap-1.5">
          {sessionBadges(session).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      {running && !session.proxyAttached ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          The egress proxy is not attached to this session&apos;s network — the agent has no
          internet access until the reconcile loop reattaches it.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
            <Meta label="Session" value={session.id} />
            <Meta label="ACP thread" value={session.acpSessionId ?? 'not started'} />
            <Meta
              label="Container"
              value={session.containerId ? session.containerId.slice(0, 12) : '—'}
            />
            <Meta label="Network" value={`${session.networkName} (${session.subnet})`} />
            <Meta label="Last active" value={new Date(session.lastActiveAt).toLocaleString()} />
          </dl>
        </CardContent>
      </Card>

      {/* The dashboard needs none of this — it derives both from the page and
          the session list. It is here for an external ACP client. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Connect an external ACP client</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Any ACP client that speaks JSON-RPC over a WebSocket can attach to this session.
            The token travels as a <code className="font-mono">bearer.&lt;token&gt;</code>{' '}
            subprotocol entry, because a browser cannot set headers on a WebSocket.
          </p>
          <CopyField label="WebSocket URL" value={wsUrlFor(session.id)} />
          <CopyField label="Bearer token" value={session.wsToken} masked />
        </CardContent>
      </Card>

      <div className="flex gap-2">
        {running ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.stopSession(id))}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.startSession(id))}
          >
            Start
          </Button>
        )}
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${session.name}?`}
          description="The container, the network and both volumes are removed, so the workspace and the thread history go with them."
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </div>
  );
}
