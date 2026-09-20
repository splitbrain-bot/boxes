import { useEffect, useState, type FormEvent } from 'react';
import type { CredentialId, LoginState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { CopyField } from '@/components/CopyField';
import { Notice } from '@/components/Notice';
import { Spinner } from '@/components/Spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { pollWhileVisible } from '@/lib/poll';

/**
 * One login in progress, on the settings page, for a credential that is an
 * account rather than a string.
 *
 * The orchestrator runs the harness's own CLI in a throwaway container and
 * this follows it, because there is nothing else it could do: no static form
 * of the credential exists, and neither CLI speaks anything but its own
 * interactive flow. What differs between the two is only what the person at
 * the browser is asked for — Codex prints a URL and a one-time code and polls
 * for itself, Claude prints a URL and blocks until the code is pasted back —
 * so both are the same machine with two waiting states.
 *
 * Nothing here starts a login: the id comes from the page, because starting
 * one is a click rather than a consequence of rendering, and a flow that
 * started itself would start a second one on every remount.
 */

/**
 * How often the flow is asked where it has got to.
 *
 * Faster than anything else the dashboard polls, and for the one reason that
 * justifies it: somebody is watching this, having just done something in
 * another tab, and the whole of what they are waiting for is this answer.
 */
const POLL_MS = 1_000;

export function CredentialLogin({
  credential,
  label,
  loginId,
  onDone,
  onClose,
  onRetry,
}: {
  credential: CredentialId;
  /** What the credential is called, for the labels a screen reader reads. */
  label: string;
  /** The login to follow, as `POST /api/credentials/:id/login` answered. */
  loginId: string;
  /**
   * The CLI stored something: the page refetches the credentials and shows
   * the row. Kept stable by the caller, since reaching `done` calls it.
   */
  onDone: () => void;
  /** The reader gave up, and the login has been cancelled. */
  onClose: () => void;
  /** Start another one after a failure, with this one already over. */
  onRetry: () => void;
}) {
  const [state, setState] = useState<LoginState>({ state: 'starting' });
  /** A failed request about the login, which is not a failed login. */
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * A code has gone to the CLI and it has not answered yet.
   *
   * The request carrying it is answered as soon as the code is written to the
   * CLI's terminal, which is seconds before the CLI has exchanged it. Without
   * this the form comes back empty and idle-looking meanwhile, and a reader
   * who cannot tell sends a code that can only be used once a second time.
   */
  const [checking, setChecking] = useState(false);

  // Nothing moves after either of these, so the polling stops rather than
  // asking a finished login the same question every second.
  const settled = state.state === 'done' || state.state === 'failed';

  useEffect(() => {
    if (settled) return;
    let live = true;
    const tick = (): void => {
      void api.loginState(credential, loginId).then(
        (next) => {
          if (!live) return;
          setState(next);
          setError(null);
        },
        (err: Error) => {
          // A poll that did not land says so and is tried again: the login
          // itself is still running in its container.
          if (live) setError(err.message);
        },
      );
    };
    tick();
    const stop = pollWhileVisible(tick, POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, [credential, loginId, settled]);

  // A refusal is the CLI answering, so the form comes back for another code.
  // Every other ending takes the whole flow with it.
  useEffect(() => {
    if (state.state !== 'awaiting_code' || state.error === null) return;
    setChecking(false);
  }, [state]);

  // The credential exists now, so the page reads it back rather than being
  // told about it here: what a row says about an account — its name, when it
  // expires — is the store's answer and not this flow's.
  useEffect(() => {
    if (state.state === 'done') onDone();
  }, [state.state, onDone]);

  /** Gives up, and tells the orchestrator so the container goes now. */
  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.cancelLogin(credential, loginId);
    } catch {
      // Nothing to do about it and nothing lost: a login nobody finishes is
      // swept with its container ten minutes from now.
    }
    setBusy(false);
    onClose();
  };

  /** Hands the CLI the code it is blocked on. */
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || code.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await api.submitLoginCode(credential, loginId, code.trim());
      setCode('');
      setChecking(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      {state.state === 'starting' ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner label={`Starting the ${label} login`} />
          Starting a login. This takes a few seconds: it runs in a container of its own.
        </p>
      ) : null}

      {state.state === 'awaiting_browser' ? (
        <>
          <p className="text-xs text-muted-foreground">
            {state.code
              ? 'Open this link and enter the code. This page notices when you are done.'
              : 'Open this link and finish there. This page notices when you are done.'}
          </p>
          <LoginLink url={state.url} />
          {state.code ? <CopyField label="Code" value={state.code} /> : null}
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner label="Waiting for the login to finish" />
            Waiting.
          </p>
        </>
      ) : null}

      {state.state === 'awaiting_code' ? (
        <>
          <p className="text-xs text-muted-foreground">
            Open this link, then paste the code it gives you back here.
          </p>
          <LoginLink url={state.url} />
          {/* The CLI's own words about the last code it would not take, shown
              here rather than ending the login, because it asks again:
              without this a refused code looks like a button that did
              nothing. */}
          {state.error ? (
            <Notice tone="warn" className="rounded-md border px-3 py-2 text-xs">
              {state.error}
            </Notice>
          ) : null}
          {/* The form gives way while the CLI works. Exchanging a code takes
              seconds, and a form standing there empty invites a second send of
              a code that can only be used once. */}
          {checking ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner label="Checking the code" />
              Checking the code.
            </p>
          ) : (
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => void submit(e)}>
              <Label className="sr-only" htmlFor={`login-code-${credential}`}>
                {`${label} login code`}
              </Label>
              <Input
                id={`login-code-${credential}`}
                autoComplete="off"
                className="font-mono"
                placeholder="The code from that page"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button type="submit" disabled={busy || code.trim() === ''}>
                Send code
              </Button>
            </form>
          )}
        </>
      ) : null}

      {state.state === 'done' ? (
        <p className="text-xs text-muted-foreground">Signed in.</p>
      ) : null}

      {state.state === 'failed' ? (
        <Notice className="rounded-md border px-3 py-2 text-xs">{state.error}</Notice>
      ) : null}

      {error ? (
        <Notice tone="warn" className="rounded-md border px-3 py-2 text-xs">
          {error}
        </Notice>
      ) : null}

      <div className="flex justify-end gap-2">
        {state.state === 'failed' ? (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button type="button" onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The URL the CLI printed, as a link and as text.
 *
 * Shown whole rather than behind a word: the browser that finishes the login
 * is often not this one — a phone drives a deployment on a laptop — and a
 * link nobody can read is a link nobody can retype.
 */
function LoginLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-xs break-all text-foreground underline"
    >
      {url}
    </a>
  );
}
