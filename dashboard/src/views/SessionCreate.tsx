import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.ts';
import { refresh } from '../stores/sessions.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** The new-session form, which opens the session's thread on success. */
export function SessionCreate() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSession({ name: name.trim() });
      await refresh();
      void navigate(`/sessions/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
      <h1 className="text-xl font-semibold">New session</h1>

      <div className="flex flex-col gap-2">
        <Label htmlFor="session-name">Name</Label>
        <Input
          id="session-name"
          value={name}
          required
          maxLength={100}
          placeholder="refactor auth"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => void navigate('/')} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
