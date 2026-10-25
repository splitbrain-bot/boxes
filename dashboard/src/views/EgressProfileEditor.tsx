import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { BackLink } from '@/components/BackLink';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useUp } from '@/hooks/use-up';
import type { EgressProfileDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';

/** The value of the mode select for the open mode. */
const OPEN = 'open';

/** The value of the mode select for the closed mode. */
const CLOSED = 'closed';

/**
 * Splits the text of the hosts field into host patterns.
 *
 * @param text The text, with one pattern on each line.
 * @returns The trimmed patterns, without empty lines.
 */
function parseHosts(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Editor for one egress profile. */
export function EgressProfileEditor() {
  const { profileId = '' } = useParams();
  /** Goes back to the list of profiles. */
  const up = useUp('/egress');

  const [profile, setProfile] = useState<EgressProfileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState(CLOSED);
  const [hosts, setHosts] = useState('');

  /**
   * Shows a profile and fills the fields from it.
   *
   * @param detail The profile.
   */
  const seed = useCallback((detail: EgressProfileDetail): void => {
    setProfile(detail);
    setName(detail.name);
    setMode(detail.open ? OPEN : CLOSED);
    setHosts(detail.hosts.join('\n'));
  }, []);

  /** Loads the profile. */
  const load = useCallback(async (): Promise<void> => {
    try {
      seed(await api.getEgressProfile(profileId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [profileId, seed]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!profile) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink up={up} label="Egress profiles" />
        {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : <Loading />}
      </div>
    );
  }

  const changed =
    name.trim() !== profile.name ||
    (mode === OPEN) !== profile.open ||
    parseHosts(hosts).join('\n') !== profile.hosts.join('\n');

  /** Saves the name, the mode and the hosts, and fills the fields from the answer. */
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      seed(
        await api.updateEgressProfile(profileId, {
          name: name.trim(),
          open: mode === OPEN,
          hosts: parseHosts(hosts),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Egress profiles" />

      <h1 className="text-xl font-semibold">{profile.name}</h1>

      <p className="text-sm text-muted-foreground">
        {profile.isDefault
          ? 'Each box without a selected profile uses this profile.'
          : `${profile.boxCount} ${profile.boxCount === 1 ? 'box uses' : 'boxes use'} this profile.`}{' '}
        A change applies to the next connection of the box.
      </p>

      {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : null}

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            id="profile-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-mode">Mode</Label>
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger id="profile-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OPEN}>Open: all public hosts on the ports 80 and 443</SelectItem>
              <SelectItem value={CLOSED}>Closed: only the hosts below</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="profile-hosts">Hosts</Label>
          <Textarea
            id="profile-hosts"
            value={hosts}
            // field-sizing-content ignores rows, so min-h sets the empty size.
            className="min-h-40 font-mono text-xs"
            placeholder={'registry.npmjs.org\n*.pythonhosted.org\nmcp.example.com:8443'}
            onChange={(e) => setHosts(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            One host on each line. A <code>*.</code> at the start stands for exactly one label. A
            host without a port allows the ports 80 and 443. The hosts of your credentials, your API
            keys and the MCP servers of the box are always allowed.
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            disabled={busy || !changed || name.trim() === ''}
            onClick={() => void save()}
          >
            {changed ? 'Save' : 'Saved'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
