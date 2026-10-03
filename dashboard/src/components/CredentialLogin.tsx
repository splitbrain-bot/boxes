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
 * How often the login state is polled, in milliseconds. Faster than other
 * polls, because the reader is waiting for this answer.
 */
const POLL_MS = 1_000;

/**
 * Panel that follows one account login on the settings page.
 *
 * The orchestrator runs the harness's own CLI in a throwaway container. Codex
 * prints a URL and a one-time code and polls by itself. Claude prints a URL
 * and waits until the code is pasted back. For Dev Tunnels the orchestrator
 * runs GitHub's device flow itself, which shows a URL and a code like Codex.
 * The page starts the login, so a remount does not start a second one.
 */
export function CredentialLogin({
  credential,
  label,
  loginId,
  onDone,
  onClose,
  onRetry,
}: {
  /** The credential the login is for. */
  credential: CredentialId;
  /** The credential's name, for the screen reader labels. */
  label: string;
  /** The login to follow, as `POST /api/credentials/:id/login` answered. */
  loginId: string;
  /**
   * Called when the CLI stored the credential. The caller keeps it stable,
   * because an effect calls it.
   */
  onDone: () => void;
  /** Called when the reader closes the panel, after a cancel or a failure. */
  onClose: () => void;
  /** Starts another login after a failure. */
  onRetry: () => void;
}) {
  const [state, setState] = useState<LoginState>({ state: 'starting' });
  /** A failed request to the login API. The login itself may still run. */
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * True while a sent code waits for the CLI's answer.
   *
   * The request returns once the code reaches the CLI's terminal, seconds
   * before the CLI has exchanged it. The form stays hidden meanwhile, so the
   * reader cannot send a one-time code twice.
   */
  const [checking, setChecking] = useState(false);

  // Polling stops once the login is done or failed.
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
          // The next tick tries again. The login still runs in its container.
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

  // A refused code brings the form back for another code.
  useEffect(() => {
    if (state.state !== 'awaiting_code' || state.error === null) return;
    setChecking(false);
  }, [state]);

  useEffect(() => {
    if (state.state === 'done') onDone();
  }, [state.state, onDone]);

  /** Cancels the login, so the orchestrator removes its container now. */
  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.cancelLogin(credential, loginId);
    } catch {
      // The orchestrator ends an unfinished login after ten minutes anyway.
    }
    setBusy(false);
    onClose();
  };

  /** Sends the CLI the code it waits for. */
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
          Starting a login. This takes a few seconds.
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
          {/* The CLI's message about a refused code. The CLI asks again. */}
          {state.error ? (
            <Notice tone="warn" className="rounded-md border px-3 py-2 text-xs">
              {state.error}
            </Notice>
          ) : null}
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
 * The URL the CLI printed, as a link that shows the whole URL. The login is
 * often finished in another browser, where the reader retypes it.
 *
 * @param url The login URL.
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
