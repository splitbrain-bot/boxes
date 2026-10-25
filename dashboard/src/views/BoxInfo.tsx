import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BackLink } from '@/components/BackLink';
import { boxBadges } from '@/components/BoxCard';
import { BoxWorkList } from '@/components/BoxWorkList';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUp } from '@/hooks/use-up';
import { pollWhileVisible } from '@/lib/poll';
import { shortSize } from '@/lib/rough';
import type { BoxDetail, EgressDenial, EgressProfileSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { refresh } from '../stores/boxes.ts';

/** The poll interval in milliseconds for the box, while the tab is visible. */
const POLL_MS = 5000;

/**
 * One field of the details grid.
 *
 * @param label The name of the field.
 * @param value The value of the field.
 */
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
  /** The egress profiles, for the select. Null while loading or when the request failed. */
  const [profiles, setProfiles] = useState<EgressProfileSummary[] | null>(null);
  /** The targets that the egress profile refused. Null while loading or when the request failed. */
  const [denials, setDenials] = useState<EgressDenial[] | null>(null);
  /** The message of the failed denials request, or null. */
  const [denialsError, setDenialsError] = useState<string | null>(null);

  /** Reads the box and the targets that its egress profile refused. */
  const load = useCallback(async (): Promise<void> => {
    try {
      setBox(await api.getBox(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    try {
      setDenials(await api.boxDenials(id));
      setDenialsError(null);
    } catch (err) {
      setDenials(null);
      setDenialsError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return pollWhileVisible(() => void load(), POLL_MS);
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        setProfiles(await api.listEgressProfiles());
      } catch {
        // Without the list, the page shows the name of the profile without the select.
      }
    })();
  }, []);

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
   * Deletes the box and goes back to the list. The function does not use
   * `act`, because a reload of the deleted box would get a 404.
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

  const running = box.runtimeState === 'running';

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

      {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : null}

      {running && !box.isolated ? (
        <Notice tone="warn" className="rounded-md border px-3 py-2">
          The network isolation of this box is not complete, so the traffic of the agent may not go
          through the egress proxy. The orchestrator tries to repair it.
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
            {box.runtimeDetails.map(([label, value]) => (
              <Meta key={label} label={label} value={value} />
            ))}
            {/* Every box gets the global set, so a box without a named set shows "global only". */}
            <Meta label="Agent set" value={box.agentSetName ?? 'global only'} />
            <Meta label="Last active" value={new Date(box.lastActiveAt).toLocaleString()} />
            {/* Null before the first measurement. */}
            <Meta
              label="On disk"
              value={box.diskBytes === null ? 'not measured' : shortSize(box.diskBytes)}
            />
            {/* A stopped box keeps the value of its last measurement, however old. */}
            {box.diskMeasuredAt === null ? null : (
              <Meta label="Measured" value={new Date(box.diskMeasuredAt).toLocaleString()} />
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Egress</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {profiles ? (
            <div className="flex flex-col gap-2">
              <Select
                value={box.egressProfileId}
                disabled={busy}
                onValueChange={(value) => void act(() => api.setBoxEgressProfile(id, value))}
              >
                <SelectTrigger aria-label="Egress profile" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A change applies to the next connection of the box.{' '}
                <Link to="/egress" className="underline hover:text-foreground">
                  Edit the profiles
                </Link>
                .
              </p>
            </div>
          ) : (
            <p className="text-sm">{box.egressProfileName}</p>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Refused hosts</span>
            {denialsError ? (
              <Notice className="rounded-md border px-3 py-2">{denialsError}</Notice>
            ) : null}
            {denials?.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
            {denials && denials.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {denials.map((d) => (
                  <li key={`${d.host}:${d.port}`} className="flex items-baseline gap-2">
                    <span className="truncate font-mono text-xs">
                      {d.host.includes(':') ? `[${d.host}]` : d.host}:{d.port}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {d.count}× · {new Date(d.lastAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {box.tunnels.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Shared web apps</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {box.tunnels.map((t) => (
                <li key={`${t.id}-${t.port}`} className="flex items-baseline gap-2">
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    Port {t.port}
                  </span>
                  <a
                    href={t.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-xs"
                  >
                    {t.url}
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

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
