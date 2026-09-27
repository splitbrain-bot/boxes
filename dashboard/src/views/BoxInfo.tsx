import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { BoxDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BackLink } from '@/components/BackLink';
import { BoxWorkList } from '@/components/BoxWorkList';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { boxBadges } from '@/components/BoxCard';
import { StatusBadge } from '@/components/StatusBadge';
import { useUp } from '@/hooks/use-up';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { pollWhileVisible } from '@/lib/poll';
import { shortSize } from '@/lib/rough';
import { refresh } from '../stores/boxes.ts';

/** How often the detail view re-reads the box, while its tab is visible. */
const POLL_MS = 5000;

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
 * Page with the details of one box and its start, stop and delete controls.
 *
 * Back returns to the list or thread that opened the page. Without an app
 * entry below, the box list replaces this entry.
 */
export function BoxInfo() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const up = useUp('/');

  const [box, setBox] = useState<BoxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setBox(await api.getBox(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return pollWhileVisible(() => void load(), POLL_MS);
  }, [load]);

  /** Runs one action on the box, then reloads the box and the box list. */
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
   * Deletes the box and leaves for the list. It bypasses `act`, because a
   * reload of the deleted box would answer 404.
   */
  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteBox(id);
      await refresh();
      // Replaces this entry, so back from the list does not open the deleted box.
      void navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!box) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink up={up} label="Back" />
        {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : <Loading />}
      </div>
    );
  }

  const running = box.dockerState === 'running';

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Back" />

      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{box.name}</h1>
        <div className="flex flex-wrap gap-1.5">
          {boxBadges(box).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
        </div>
      </div>

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      {running && !box.proxyAttached ? (
        <Notice tone="warn" className="rounded-md border px-3 py-2">
          The egress proxy is not attached to this box&apos;s network — the agent has no
          internet access until the reconcile loop reattaches it.
        </Notice>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
            <Meta label="Box" value={box.id} />
            <Meta label="ACP thread" value={box.acpSessionId ?? 'not started'} />
            <Meta
              label="Container"
              value={box.containerId ? box.containerId.slice(0, 12) : '—'}
            />
            <Meta label="Network" value={`${box.networkName} (${box.subnet})`} />
            {/* Every box gets the global set, so no named set reads as "global only". */}
            <Meta label="Agent set" value={box.agentSetName ?? 'global only'} />
            <Meta label="Last active" value={new Date(box.lastActiveAt).toLocaleString()} />
            {/* Null before the first measurement, or when the box has no directory
                to measure, such as a box on named volumes. */}
            <Meta
              label="On disk"
              value={
                box.diskBytes === null
                  ? 'not measured'
                  : `${shortSize(box.diskBytes)} on disk`
              }
            />
          </dl>
        </CardContent>
      </Card>

      {/* Hidden when empty. The card's badge can show work that is not listed
          here, such as a task an adapter announced on its thread's bar. */}
      {box.boxWork.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Running in the box</CardTitle>
          </CardHeader>
          <CardContent>
            <BoxWorkList work={box.boxWork} />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex gap-2">
        {running ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.stopBox(id))}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.startBox(id))}
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
          title={`Delete ${box.name}?`}
          description="The container, the network, the workspace directory and the home volume are removed, so the files and the thread history go with them."
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
