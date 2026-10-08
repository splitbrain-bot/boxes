import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AgentSetSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { refresh } from '../stores/boxes.ts';
import { Notice } from '@/components/Notice';
import { ThreadOptions, useThreadOptions } from '@/components/ThreadOptions';
import { useUp } from '@/hooks/use-up';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Picker value for no extra set. The form sends it as null. */
const NO_SET = 'none';

/** Form that creates a box and then opens its first thread. */
export function BoxCreate() {
  const navigate = useNavigate();
  /** Leaves for the box list on Cancel. */
  const up = useUp('/');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The sets a box may name, without the global set, which every box gets.
   * Null while loading. The picker is hidden while this is null or empty.
   */
  const [agentSets, setAgentSets] = useState<AgentSetSummary[] | null>(null);
  const [agentSet, setAgentSet] = useState(NO_SET);
  /** The agent and settings of the box's first thread, created in the same request. */
  const thread = useThreadOptions();

  useEffect(() => {
    void (async () => {
      try {
        setAgentSets((await api.listAgentSets()).filter((s) => !s.global));
      } catch {
        // A box needs no set, so the form works without the list.
        setAgentSets([]);
      }
    })();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createBox({
        name: name.trim(),
        agentSet: agentSet === NO_SET ? null : agentSet,
        ...(thread.value ? { thread: thread.value } : {}),
      });
      // Stored only after the create succeeded, so it records what a thread started as.
      thread.remember();
      await refresh();
      // Replaces the form's entry, so back does not return to a form that
      // would create a second box.
      const first = created.threads[0];
      void navigate(first ? `/boxes/${created.id}/threads/${first.id}` : '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
      <h1 className="text-xl font-semibold">New box</h1>

      <div className="flex flex-col gap-2">
        <Label htmlFor="box-name">Name</Label>
        <Input
          id="box-name"
          value={name}
          required
          maxLength={100}
          placeholder="refactor auth"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {agentSets && agentSets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="box-agent-set">Agent set</Label>
          <Select value={agentSet} onValueChange={setAgentSet}>
            <SelectTrigger id="box-agent-set" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SET}>Global set only</SelectItem>
              {agentSets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Merged over the global AGENTS.md and skills, which every box gets.{' '}
            <Link to="/agents" className="underline hover:text-foreground">
              Edit the sets
            </Link>
            .
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">First thread</span>
        <ThreadOptions state={thread} />
      </div>

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={up.go} disabled={busy}>
          Cancel
        </Button>
        {/* Held until the harness list has loaded or failed. An earlier create
            would start the first thread on the orchestrator's default agent. */}
        <Button type="submit" disabled={busy || !name.trim() || !thread.ready}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
