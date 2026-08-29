import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api } from '../api.ts';
import { refresh } from '../store.ts';
import './SessionCreate.css';

/** The new-session form, which opens the session's detail view on success. */
export function SessionCreate() {
  const { route } = useLocation();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSession({
        name: name.trim(),
        ...(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
      });
      await refresh();
      route(`/sessions/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form class="SessionCreate" onSubmit={(e) => void submit(e)}>
      <h1 class="SessionCreate-title">New session</h1>

      <div class="SessionCreate-field">
        <label class="SessionCreate-label" for="session-name">
          Name
        </label>
        <input
          id="session-name"
          value={name}
          required
          maxLength={100}
          placeholder="refactor auth"
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="SessionCreate-field">
        <label class="SessionCreate-label" for="session-repo">
          Repository URL (optional)
        </label>
        <input
          id="session-repo"
          type="url"
          value={repoUrl}
          placeholder="https://github.com/owner/repo"
          pattern="https://.*"
          onInput={(e) => setRepoUrl((e.target as HTMLInputElement).value)}
        />
        <span class="SessionCreate-hint">
          Cloned into /workspace/repo on first start. https:// only.
        </span>
      </div>

      {error ? <div class="SessionCreate-error">{error}</div> : null}

      <div class="SessionCreate-actions">
        <button type="button" onClick={() => route('/')} disabled={busy}>
          Cancel
        </button>
        <button class="SessionCreate-submit" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}
