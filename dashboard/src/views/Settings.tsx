import { KeyRound, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  CredentialId,
  CredentialMethod,
  CredentialSummary,
  HarnessHealth,
  HarnessId,
  Settings as SettingsShape,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BackLink } from '@/components/BackLink';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CredentialLogin } from '@/components/CredentialLogin';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUp } from '@/hooks/use-up';
import { CODEX_LOGIN_OFFERED } from '@/lib/harness';
import { shortAge } from '@/lib/rough';
import { useSessions } from '../stores/sessions.ts';

/**
 * The deployment's credentials, and the identity its boxes commit as.
 *
 * Secrets are entered here and never come back: what a stored credential
 * shows is the last four characters of what was pasted, so two tokens can be
 * told apart and neither can be read off the screen. The real value reaches
 * the egress proxy and nothing else — a box holds a placeholder, which is why
 * a credential entered now works in a box created yesterday.
 */

/** One credential this page can manage, and what a person is told about it. */
interface CredentialKind {
  id: CredentialId;
  label: string;
  /**
   * The harnesses that run on it, which is the one fact about a credential
   * that belongs to the registry rather than to this page. What each of them
   * is *called* is not written down here: the labels come from the harness
   * list, so this page and the dialogs name an agent the same way.
   */
  harnesses: HarnessId[];
  /** What stops working without it. */
  blurb: string;
  /** What the secret looks like, so a wrong paste is obvious before saving. */
  hint: string;
  /** What a pasted secret is stored as; a login decides its own. */
  method: CredentialMethod;
  /**
   * Whether an account can be logged in to instead of a secret pasted.
   *
   * True for the two agents, whose subscriptions have no static form to
   * paste: the orchestrator runs the harness's own CLI to get one. GitHub's
   * credential is a token and nothing else, so its card offers the form
   * alone.
   */
  canLogin: boolean;
}

/**
 * The credentials the settings page offers.
 *
 * The orchestrator's harness registry is the source of truth for which
 * credential each agent needs; this is the list a person is shown, and the
 * health probe is what says whether a harness can actually run on one.
 */
const KINDS: CredentialKind[] = [
  {
    id: 'claude',
    label: 'Claude',
    harnesses: ['claude'],
    blurb: 'What a Claude Code thread runs on. Without it, a turn fails at the first prompt.',
    hint: 'sk-ant-oat01-…, from claude setup-token',
    method: 'token',
    canLogin: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    harnesses: ['codex'],
    blurb: 'What a Codex thread runs on. Without it, a turn fails at the first prompt.',
    hint: 'sk-…, an OpenAI API key',
    method: 'api_key',
    canLogin: CODEX_LOGIN_OFFERED,
  },
  {
    id: 'github',
    label: 'GitHub',
    // Not a harness: every box uses it, whichever agent is in the box.
    harnesses: [],
    blurb:
      'What a box clones and pushes with. Without it, git and gh reach GitHub ' +
      'unauthenticated and a push is refused.',
    hint: 'ghp_…, a classic personal access token',
    method: 'token',
    canLogin: false,
  },
];

export function Settings() {
  /** Out to the session list, popped rather than pushed; see useUp. */
  const up = useUp('/');
  const { harnesses } = useSessions();

  const [credentials, setCredentials] = useState<CredentialSummary[] | null>(null);
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<CredentialKind | null>(null);
  /**
   * The login being followed, or null.
   *
   * One at a time on the page, which is stricter than the API's one at a time
   * per credential and is the same thing for a person: two device codes on
   * one screen is two things to get wrong. Starting another cancels this one
   * rather than leaving a container running for a flow nobody can see.
   */
  const [login, setLogin] = useState<{ id: CredentialId; loginId: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [stored, current] = await Promise.all([api.listCredentials(), api.getSettings()]);
      setCredentials(stored);
      setSettings(current);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Starts a login for one credential, taking down whatever was open. */
  const beginLogin = async (id: CredentialId): Promise<void> => {
    const open = login;
    setLogin(null);
    setBusy(true);
    setError(null);
    try {
      // Cancelled rather than abandoned: it holds a container of its own.
      if (open) await api.cancelLogin(open.id, open.loginId).catch(() => {});
      const { loginId } = await api.startLogin(id);
      setLogin({ id, loginId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A login that stored something: the flow goes and the row it wrote is read
   * back from the store, which is the only thing that knows what is in it.
   */
  const finishLogin = useCallback((): void => {
    setLogin(null);
    void load();
  }, [load]);

  /** Runs one mutation and reloads, so the page never guesses at the result. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Sessions" />

      <h1 className="text-xl font-semibold">Settings</h1>

      <p className="text-sm text-muted-foreground">
        Credentials are held by this deployment and swapped onto the wire by the egress proxy. A
        box never holds one: it gets a worthless placeholder of the same shape, so a credential
        entered here works in every box, including the ones already running.
      </p>

      {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : null}

      {credentials === null ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        KINDS.map((kind) => (
          <CredentialCard
            key={kind.id}
            kind={kind}
            stored={credentials.find((c) => c.id === kind.id) ?? null}
            // The harnesses that run on this credential, as the deployment
            // names them, so the card can say what is not working rather than
            // only that something is unset. Read off the health probe rather
            // than written down here: the labels are the registry's.
            stalled={harnesses.filter((h) => kind.harnesses.includes(h.id) && !h.runnable)}
            busy={busy}
            // The login this card is following, if any: one is open at a time
            // across the page, and it belongs under the credential it is for.
            loginId={login?.id === kind.id ? login.loginId : null}
            onSave={(secret) => act(() => api.putCredential(kind.id, kind.method, secret))}
            onLogin={() => void beginLogin(kind.id)}
            onLoginDone={finishLogin}
            onLoginClose={() => setLogin(null)}
            onRemove={() => setConfirmRemove(kind)}
          />
        ))
      )}

      {settings ? (
        <GitIdentity
          settings={settings}
          busy={busy}
          onSave={(patch) => act(() => api.patchSettings(patch))}
        />
      ) : null}

      {confirmRemove ? (
        <ConfirmDialog
          title={`Remove the ${confirmRemove.label} credential?`}
          description={
            'Nothing is intercepted for it afterwards, and anything in a box that used it ' +
            'fails until another is entered. Boxes keep running.'
          }
          confirmLabel="Remove"
          danger
          busy={busy}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const kind = confirmRemove;
            setConfirmRemove(null);
            void act(() => api.deleteCredential(kind.id));
          }}
        />
      ) : null}
    </div>
  );
}

/** One credential: what is stored, the form that replaces it, and its login. */
function CredentialCard({
  kind,
  stored,
  stalled,
  busy,
  loginId,
  onSave,
  onLogin,
  onLoginDone,
  onLoginClose,
  onRemove,
}: {
  kind: CredentialKind;
  stored: CredentialSummary | null;
  /** The harnesses that cannot run on it right now, empty when all can. */
  stalled: HarnessHealth[];
  busy: boolean;
  /** The login being followed under this card, or null. */
  loginId: string | null;
  onSave: (secret: string) => Promise<boolean>;
  onLogin: () => void;
  onLoginDone: () => void;
  onLoginClose: () => void;
  onRemove: () => void;
}) {
  const [secret, setSecret] = useState('');

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || secret.trim() === '') return;
    // Cleared whether or not the save worked: what was typed is a secret, and
    // leaving it in the field is leaving it on the screen.
    const typed = secret;
    setSecret('');
    await onSave(typed);
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">{kind.label}</h2>
        {stored ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-danger"
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 />
            Remove
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">{kind.blurb}</p>

      <p className="text-xs text-muted-foreground">{describe(stored, stalled)}</p>

      {stored?.lastError ? (
        <Notice tone="warn" className="rounded-md border px-3 py-2 text-xs">
          {stored.lastError}
        </Notice>
      ) : null}

      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => void save(e)}>
        <Label className="sr-only" htmlFor={`secret-${kind.id}`}>
          {`${kind.label} secret`}
        </Label>
        <Input
          id={`secret-${kind.id}`}
          // A password field: what is typed here is never shown again, and a
          // browser offering to remember it is offering the right thing.
          type="password"
          autoComplete="off"
          className="font-mono"
          placeholder={kind.hint}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <Button type="submit" disabled={busy || secret.trim() === ''}>
          {stored ? 'Replace' : 'Save'}
        </Button>
        {/* The other way in, for a credential that has an account behind it:
            a subscription has no static form to paste, so the orchestrator
            runs the harness's own CLI and this follows it. Beside the form
            rather than instead of it — a deployment on an API key wants the
            field, and one on a subscription wants this. */}
        {kind.canLogin && loginId === null ? (
          <Button
            type="button"
            variant="outline"
            aria-label={`Log in to ${kind.label}`}
            disabled={busy}
            onClick={onLogin}
          >
            Log in
          </Button>
        ) : null}
      </form>

      {loginId ? (
        <CredentialLogin
          credential={kind.id}
          label={kind.label}
          loginId={loginId}
          onDone={onLoginDone}
          onClose={onLoginClose}
          onRetry={onLogin}
        />
      ) : null}
    </Card>
  );
}

/** The one line under a credential's name: what is stored, and how it is doing. */
function describe(stored: CredentialSummary | null, stalled: HarnessHealth[]): string {
  if (!stored) {
    return stalled.length === 0
      ? 'Not set.'
      : `Not set, so ${stalled.map((h) => h.label).join(' and ')} cannot run.`;
  }
  // Past its own expiry, which is a date rather than the store's opinion of
  // one: both are shown, and neither is said twice.
  const expired = stored.expiresAt !== null && stored.expiresAt <= Date.now();
  const parts = [account(stored)];
  if (stored.status === 'expired' && !expired) parts.push('expired');
  if (stored.status === 'failing') parts.push('failing');
  parts.push(
    stored.refreshedAt
      ? `refreshed ${shortAge(Date.now() - stored.refreshedAt)} ago`
      : `entered ${shortAge(Date.now() - stored.updatedAt)} ago`,
  );
  if (stored.expiresAt) {
    parts.push(
      expired
        ? `expired ${shortAge(Date.now() - stored.expiresAt)} ago`
        : `expires in ${shortAge(stored.expiresAt - Date.now())}`,
    );
  }
  if (stalled.length > 0) {
    parts.push(`${stalled.map((h) => h.label).join(' and ')} cannot run on it`);
  }
  return `${parts.join(' · ')}.`;
}

/**
 * What a person recognises a credential by.
 *
 * A pasted secret is known by its last four characters, which is all anybody
 * can be shown of one. A login knows whose account it is, and saying "ends
 * someone@example.com" of an email address would be nonsense.
 */
function account(stored: CredentialSummary): string {
  if (!stored.account) return 'Stored';
  return stored.method === 'oauth'
    ? `Signed in as ${stored.account}`
    : `Ends ${stored.account}`;
}

/** Who a box commits as. Not a secret, and the only reason it lived in .env. */
function GitIdentity({
  settings,
  busy,
  onSave,
}: {
  settings: SettingsShape;
  busy: boolean;
  onSave: (patch: Partial<SettingsShape>) => Promise<boolean>;
}) {
  const [name, setName] = useState(settings.gitName);
  const [email, setEmail] = useState(settings.gitEmail);
  const dirty = name !== settings.gitName || email !== settings.gitEmail;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-medium">Git identity</h2>
      <p className="text-xs text-muted-foreground">
        What every box commits as. It reaches a box the next time that box starts.
      </p>

      <div className="flex flex-col gap-2">
        <Label htmlFor="git-name">Name</Label>
        <Input
          id="git-name"
          value={name}
          maxLength={100}
          placeholder="boxes-bot"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="git-email">Email</Label>
        <Input
          id="git-email"
          type="email"
          value={email}
          maxLength={200}
          placeholder="boxes-bot@users.noreply.github.com"
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void onSave({ gitName: name, gitEmail: email })}
        >
          {dirty ? 'Save identity' : 'Saved'}
        </Button>
      </div>
    </Card>
  );
}
