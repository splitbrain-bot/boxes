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
import { useBoxes } from '../stores/boxes.ts';

/** One credential this page can manage, and what a person is told about it. */
interface CredentialKind {
  /** The credential's id. */
  id: CredentialId;
  /** The name on the card. */
  label: string;
  /**
   * The harnesses that run on it. Their labels come from the harness list, so
   * this page and the dialogs name an agent the same way.
   */
  harnesses: HarnessId[];
  /** What stops working without it. */
  blurb: string;
  /**
   * What the secret looks like, so a wrong paste is obvious before saving.
   * Null for a credential that can only be obtained by logging in, which
   * then gets no paste form.
   */
  hint: string | null;
  /** What a pasted secret is stored as; a login decides its own. */
  method: CredentialMethod;
  /**
   * Whether the card offers an account login beside the paste form. The
   * orchestrator then runs the harness's own CLI to get the credential.
   */
  canLogin: boolean;
}

/**
 * The credentials the settings page offers.
 *
 * The orchestrator's harness registry decides which credential each agent
 * needs. The health probe says whether a harness can run on it.
 */
const KINDS: CredentialKind[] = [
  {
    id: 'claude',
    label: 'Claude',
    harnesses: ['claude'],
    blurb: 'Claude Code authentication. Use `claude setup-token` to use your subscription seat.',
    hint: 'sk-ant-oat01-…, from claude setup-token',
    method: 'token',
    canLogin: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    harnesses: ['codex'],
    blurb: 'OpenAI Codex authentication. Subscription seats are not supported yet.',
    hint: 'sk-…, an OpenAI API key',
    method: 'api_key',
    canLogin: CODEX_LOGIN_OFFERED,
  },
  {
    id: 'github',
    label: 'GitHub',
    // No harness runs on it. Every box uses it for git.
    harnesses: [],
    blurb: 'A personal access token to push and interact with GitHub.',
    hint: 'ghp_…, a classic personal access token',
    method: 'token',
    canLogin: false,
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    harnesses: [],
    blurb:
      'A personal access token to push and interact with GitLab. Set a custom domain in the settings if your ' +
      'GitLab is self-hosted.',
    hint: 'glpat-…, a personal access token with the api and write_repository scopes',
    method: 'token',
    canLogin: false,
  },
  {
    id: 'devtunnels',
    label: 'Dev Tunnels',
    harnesses: [],
    blurb:
      'Github based authentication with Microsoft Dev Tunnels service. Used to make box services temporarily '+
      'accessible from the outside',
    hint: null,
    method: 'oauth',
    canLogin: true,
  },
];

/**
 * Page with the deployment's credentials and the git identity of its boxes.
 *
 * A stored secret never comes back to the page. Only the egress proxy gets
 * the real value, and a box holds a placeholder.
 */
export function Settings() {
  /** Leaves for the box list. */
  const up = useUp('/');
  const { harnesses } = useBoxes();

  const [credentials, setCredentials] = useState<CredentialSummary[] | null>(null);
  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<CredentialKind | null>(null);
  /**
   * The login being followed, or null.
   *
   * The page follows one login at a time. The API allows one per credential.
   * Starting another login cancels this one.
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

  /** Starts a login for one credential and cancels the open one. */
  const beginLogin = async (id: CredentialId): Promise<void> => {
    const open = login;
    setLogin(null);
    setBusy(true);
    setError(null);
    try {
      // Cancels the open login, because it holds a container of its own.
      if (open) await api.cancelLogin(open.id, open.loginId).catch(() => {});
      const { loginId } = await api.startLogin(id);
      setLogin({ id, loginId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Closes a login that stored a credential, and reloads the credentials. */
  const finishLogin = useCallback((): void => {
    setLogin(null);
    void load();
  }, [load]);

  /**
   * Runs one mutation, then reloads the page data.
   *
   * @returns Whether the mutation succeeded.
   */
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
      <BackLink up={up} label="Boxes" />

      <h1 className="text-xl font-semibold">Authentication Settings</h1>

      <p className="text-sm text-muted-foreground">
          Configure your credentials and the git identity of your boxes here. Credentials are
          not passed directly to the boxes, but are swapped in by the egress proxy. Agents never
          see the real secret and thus cannot leak it.
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
            stalled={harnesses.filter((h) => kind.harnesses.includes(h.id) && !h.runnable)}
            busy={busy}
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
    // Cleared even when the save fails, so the secret does not stay in the field.
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
        {kind.hint !== null ? (
          <>
            <Label className="sr-only" htmlFor={`secret-${kind.id}`}>
              {`${kind.label} secret`}
            </Label>
            <Input
              id={`secret-${kind.id}`}
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
          </>
        ) : null}
        {/* A subscription has no secret to paste, so a login sits beside the form. */}
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

/**
 * Builds the status line under a credential's name.
 *
 * @param stored The stored credential, or null.
 * @param stalled The harnesses that cannot run on it.
 * @returns One line of text.
 */
function describe(stored: CredentialSummary | null, stalled: HarnessHealth[]): string {
  if (!stored) {
    return stalled.length === 0
      ? 'Not set.'
      : `Not set, so ${stalled.map((h) => h.label).join(' and ')} cannot run.`;
  }
  // The expiry date and the stored status can both say expired, so only one is shown.
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
 * Names a stored credential: the account of a login, or the last four
 * characters of a pasted secret.
 *
 * @param stored The stored credential.
 * @returns The label.
 */
function account(stored: CredentialSummary): string {
  if (!stored.account) return 'Stored';
  return stored.method === 'oauth'
    ? `Signed in as ${stored.account}`
    : `Ends ${stored.account}`;
}

/** Card that edits the name and email every box commits as. */
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
