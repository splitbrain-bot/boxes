import { ChevronRight, Lock, Plus, Shield } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BackLink } from '@/components/BackLink';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUp } from '@/hooks/use-up';
import type { EgressProfileSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';

/** Page that lists every egress profile, the default profile first. */
export function EgressProfiles() {
  /** Goes back to the box list. */
  const up = useUp('/');
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<EgressProfileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<EgressProfileSummary | null>(null);

  /** Reads the list of profiles. */
  const load = useCallback(async (): Promise<void> => {
    try {
      setProfiles(await api.listEgressProfiles());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Creates a closed profile with the typed name and opens it in the editor. */
  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createEgressProfile({ name: name.trim() });
      void navigate(`/egress/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  /** Deletes a profile and reloads the list. */
  const remove = async (profile: EgressProfileSummary): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteEgressProfile(profile.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Boxes" />

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Egress Profiles</h1>
        <Button size="sm" onClick={() => setCreating((c) => !c)}>
          <Plus />
          New profile
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        An egress profile sets the hosts that the agent in a box can reach. In the open mode, the
        agent can reach every public host on the ports 80 and 443. In the closed mode, it can reach
        only the hosts of the profile. The hosts of your credentials, your API keys and the MCP
        servers of the box are always allowed. A box without a selected profile uses the default
        profile.
      </p>

      {creating ? (
        <Card className="p-4">
          <form className="flex flex-col gap-3" onSubmit={(e) => void create(e)}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-name">Name of the new profile</Label>
              <Input
                id="profile-name"
                value={name}
                autoFocus
                required
                maxLength={100}
                placeholder="Package registries only"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : null}

      {profiles === null ? <Loading className="py-8 text-center" /> : null}

      {profiles?.map((profile) => (
        <Card key={profile.id} className="flex flex-row items-center gap-3 p-4">
          <Link to={`/egress/${profile.id}`} className="flex min-w-0 flex-1 items-center gap-3">
            {profile.open ? (
              <Shield className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Lock className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{profile.name}</span>
              <span className="text-xs text-muted-foreground">{describe(profile)}</span>
            </span>
            <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </Link>
          {/* The API refuses to delete the default profile. */}
          {profile.isDefault ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={() => setConfirmDelete(profile)}
            >
              Delete
            </Button>
          )}
        </Card>
      ))}

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${confirmDelete.name}?`}
          description={
            confirmDelete.boxCount === 0
              ? 'The profile is removed. No box uses it.'
              : `${confirmDelete.boxCount} ${
                  confirmDelete.boxCount === 1 ? 'box uses' : 'boxes use'
                } this profile. They use the default profile from their next connection.`
          }
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void remove(confirmDelete)}
        />
      ) : null}
    </div>
  );
}

/**
 * Builds the one-line summary under the name of a profile.
 *
 * @param profile The profile.
 * @returns The summary.
 */
function describe(profile: EgressProfileSummary): string {
  const parts = [profile.open ? 'open' : 'closed'];
  if (profile.isDefault) parts.push('default');
  parts.push(`${profile.boxCount} ${profile.boxCount === 1 ? 'box' : 'boxes'}`);
  return parts.join(' · ');
}
