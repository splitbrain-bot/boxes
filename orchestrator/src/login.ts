import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { CredentialId, LoginState } from '../../shared/types.ts';
import { parseAuthDocument, type CredentialStore } from './credentials.ts';
import * as dk from './docker.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';

/**
 * Logging in to an account, rather than pasting a secret.
 *
 * A subscription is not a string anybody can type into a form: there is no
 * static form of a ChatGPT or Claude account credential at all, and the only
 * thing that knows how to obtain one is the harness's own CLI. So the
 * orchestrator does not speak OAuth. It runs that CLI in a throwaway
 * container built from the session image, reads what it prints, answers what
 * it asks, and stores what it produced. The settings page drives the whole of
 * it by polling one state machine.
 *
 * What is deliberately not here: any parser that treats a CLI's wording as an
 * API. Neither `codex login --device-auth` nor `claude setup-token` documents
 * the exact lines it prints, and both are free to reword them in a patch
 * release. Everything below therefore looks for the *shapes* that cannot
 * change without the flow itself changing — a URL on the service's own host, a
 * one-time code, a token with a fixed prefix — and puts the raw output in the
 * log so that a person can finish by hand on the day a CLI surprises us.
 * PLAN.md section 3, verify steps 8 and 9, neither of which can be run without
 * a Docker daemon.
 */

/** How long a person gets to finish a login before it is given up on. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** A login container older than this is nobody's and is swept. */
export const LOGIN_CONTAINER_MAX_AGE_MS = 15 * 60_000;

/** Where Codex keeps its state inside the login container's tmpfs home. */
const CODEX_HOME = '/home/agent/.codex';

/** Where Claude Code keeps its own, for the same reason. */
const CLAUDE_CONFIG_DIR = '/home/agent/.claude';

/**
 * The URL `codex login --device-auth` sends a person to.
 *
 * Matched by prefix rather than compared: the path is the documented entry
 * point, and anything the CLI appends to it — a query carrying the code, a
 * locale — is still the right URL to show.
 */
const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';

/** What a Claude one-year token looks like, which is how it is recognised. */
const CLAUDE_TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{8,}/;

/** The prompt `claude setup-token` blocks on, matched loosely. */
const CLAUDE_CODE_PROMPT = /paste code here/i;

/** How long a Claude token is good for. The CLI says a year and cannot refresh. */
const CLAUDE_TOKEN_DAYS = 365;

/** How much of a CLI's output is kept for the log and for an error message. */
const OUTPUT_LIMIT = 64 * 1024;

/** How much of it a failure reports. */
const ERROR_TAIL = 600;

/** The credentials that have a login flow at all. */
export const LOGIN_CREDENTIALS: readonly CredentialId[] = ['claude', 'openai'];

/** Whether a credential is obtained by logging in rather than by pasting. */
export function hasLoginFlow(id: CredentialId): boolean {
  return LOGIN_CREDENTIALS.includes(id);
}

// --- the container and exec layer -------------------------------------------

/** One command a login runs in its container. */
export interface LoginExecSpec {
  cmd: readonly string[];
  env?: Record<string, string>;
  /** A terminal and a writable stdin: what an interactive CLI needs. */
  tty?: boolean;
}

/** A running login command: what it prints, what it can be told, and its end. */
export interface LoginExec {
  /** stdout and stderr merged, in the order they were written. */
  output: Readable;
  /** Writable only on a TTY exec; null otherwise. */
  stdin: Writable | null;
  exited: Promise<number | null>;
  kill(): void;
}

/**
 * Everything a login needs from Docker.
 *
 * An interface rather than direct calls because the two flows are the part
 * worth testing and a daemon is the part that cannot be: the tests drive both
 * of them over scripted streams, exactly as `docker.test.ts` drives the rest
 * over a faked dockerode.
 */
export interface LoginRuntime {
  /** Creates and starts the throwaway container, and answers with its id. */
  start(credentialId: CredentialId): Promise<string>;
  exec(containerId: string, spec: LoginExecSpec): Promise<LoginExec>;
  /** Removes it, whatever state it is in. Never throws. */
  remove(containerId: string): Promise<void>;
}

/** The real thing: a container from the session image, driven over the socket. */
export function dockerLoginRuntime(image: string): LoginRuntime {
  return {
    async start(credentialId) {
      const id = await dk.createLoginContainer({ image, credentialId });
      await dk.startContainer(id);
      return id;
    },
    async exec(containerId, spec) {
      const exec = await dk.spawnLoginExec(containerId, spec.cmd, {
        ...(spec.env ? { env: spec.env } : {}),
        ...(spec.tty ? { tty: true } : {}),
      });
      return exec;
    },
    async remove(containerId) {
      try {
        await dk.removeContainer(containerId);
      } catch (err) {
        log.warn('could not remove a login container', {
          container: containerId,
          error: (err as Error).message,
        });
      }
    },
  };
}

// --- the flows --------------------------------------------------------------

/** One login in progress, or the last one that finished. */
interface Flow {
  id: string;
  credentialId: CredentialId;
  state: LoginState;
  containerId: string | null;
  exec: LoginExec | null;
  /** Set once the state is `done` or `failed`; nothing moves it afterwards. */
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Runs the logins, one per credential at a time.
 *
 * One at a time because a login is a container and a person: two of them for
 * the same credential would race to write the same row, and the second is
 * always the one that is meant. Starting one therefore cancels whatever was
 * running, and the abandoned flow's id stops resolving.
 */
export class LoginManager {
  private readonly flows = new Map<CredentialId, Flow>();

  constructor(
    private readonly credentials: CredentialStore,
    private runtime: LoginRuntime,
    /** Overridden by the tests, which cannot wait ten minutes. */
    private readonly timeoutMs: number = LOGIN_TIMEOUT_MS,
  ) {}

  /** Test seam, matching docker.ts's: install a runtime the tests script. */
  setRuntimeForTests(runtime: LoginRuntime): void {
    this.runtime = runtime;
  }

  /**
   * Starts a login and answers with the id the page polls.
   *
   * Returns as soon as the flow exists rather than when the container does:
   * pulling an image and starting a container take seconds, and `starting` is
   * a state the page can already draw.
   */
  start(credentialId: CredentialId): string {
    if (!hasLoginFlow(credentialId)) {
      throw new HttpError(
        400,
        `${credentialId} has no login flow: paste its token on the settings page instead`,
      );
    }
    // A second login is the one that is meant; the first is abandoned with
    // its container.
    const previous = this.flows.get(credentialId);
    if (previous) this.abort(previous, 'a newer login replaced this one');

    const flow: Flow = {
      id: randomUUID(),
      credentialId,
      state: { state: 'starting' },
      containerId: null,
      exec: null,
      settled: false,
      timer: null,
    };
    flow.timer = setTimeout(() => {
      this.fail(flow, 'the login was not finished in ten minutes');
    }, this.timeoutMs);
    flow.timer.unref?.();
    this.flows.set(credentialId, flow);

    void this.run(flow);
    return flow.id;
  }

  /** Where a login has got to, or a 404 for one that is no longer current. */
  state(credentialId: CredentialId, loginId: string): LoginState {
    return this.flow(credentialId, loginId).state;
  }

  /**
   * Answers the CLI's prompt with the code the login page gave the person.
   *
   * Accepted a moment early as well as on the prompt itself: the page can send
   * the code as soon as it has one, whether the prompt has been drawn by then
   * is a race about terminal output rather than anything a person did, and a
   * stream written to before the prompt is a stream the CLI reads when it gets
   * there. A flow with nothing to write to — Codex's, which reads no stdin at
   * all, or one that has not started its CLI yet — is a flow that has no
   * question outstanding, and says so.
   */
  submitCode(credentialId: CredentialId, loginId: string, code: string): void {
    const flow = this.flow(credentialId, loginId);
    const trimmed = code.trim();
    if (trimmed === '') throw new HttpError(400, 'code is required');
    const waiting = flow.state.state === 'awaiting_code' || flow.state.state === 'awaiting_browser';
    if (!waiting || !flow.exec?.stdin) {
      throw new HttpError(409, 'this login is not waiting for a code');
    }
    flow.exec.stdin.write(`${trimmed}\n`);
  }

  /** Gives up on a login and takes its container with it. */
  cancel(credentialId: CredentialId, loginId: string): void {
    const flow = this.flow(credentialId, loginId);
    this.abort(flow, 'the login was cancelled');
  }

  /** Stops every login in flight, for a shutdown that should leave nothing. */
  closeAll(): void {
    for (const flow of [...this.flows.values()]) {
      this.abort(flow, 'the orchestrator is shutting down');
    }
  }

  /** The named flow, or a 404 saying it is not the current one. */
  private flow(credentialId: CredentialId, loginId: string): Flow {
    const flow = this.flows.get(credentialId);
    if (!flow || flow.id !== loginId) {
      throw new HttpError(404, 'no such login: it finished, was cancelled, or was replaced');
    }
    return flow;
  }

  /** Runs one flow to its end, and cleans up whatever it was holding. */
  private async run(flow: Flow): Promise<void> {
    try {
      flow.containerId = await this.runtime.start(flow.credentialId);
      if (flow.settled) return;
      if (flow.credentialId === 'openai') await this.codexLogin(flow);
      else await this.claudeLogin(flow);
    } catch (err) {
      this.fail(flow, (err as Error).message);
    } finally {
      // Whatever happened, the container goes: it holds a tmpfs home with
      // freshly minted credential material in it.
      this.release(flow);
      if (flow.containerId) {
        const containerId = flow.containerId;
        flow.containerId = null;
        await this.runtime.remove(containerId);
      }
    }
  }

  /**
   * Codex: the device-code flow.
   *
   * The CLI reads nothing from stdin. It prints a URL and a one-time code,
   * polls OpenAI for up to fifteen minutes, writes `auth.json` and exits 0;
   * any failure exits 1 with the reason on stderr. So the whole of the
   * orchestrator's part is to read two things off the output, wait, and then
   * read the file. PLAN.md section 3, verify step 9: the wording of those
   * lines is what a real box still has to confirm, which is why the parse
   * below takes the URL by prefix and the code by shape, and why every line
   * is logged whether it was understood or not.
   */
  private async codexLogin(flow: Flow): Promise<void> {
    const exec = await this.runtime.exec(flow.containerId!, {
      // CODEX_HOME must already exist: the Codex CLI treats one that names a
      // missing directory as an error rather than creating it.
      cmd: ['bash', '-lc', `mkdir -p "$CODEX_HOME" && exec codex login --device-auth`],
      env: { CODEX_HOME },
    });
    flow.exec = exec;

    let url: string | null = null;
    let code: string | null = null;
    const output = await readOutput(exec.output, (text) => {
      if (flow.settled) return;
      url ??= deviceUrlIn(text);
      if (!url) return;
      code ??= deviceCodeIn(text, url);
      this.settle(flow, { state: 'awaiting_browser', url, code });
    });

    if (flow.settled) return;
    const exit = await exec.exited;
    // The raw lines, understood or not. The one thing that makes a CLI
    // rewording its output recoverable by hand rather than only by a release:
    // the URL and the code are in here whether or not the parse found them.
    log.info('codex device login finished', { exit, url, code, output: tail(output) });
    if (exit !== 0) {
      this.fail(flow, `codex login exited ${exit ?? 'without a status'}: ${tail(output)}`);
      return;
    }

    const read = await this.runtime.exec(flow.containerId!, {
      cmd: ['cat', `${CODEX_HOME}/auth.json`],
    });
    const document = await readOutput(read.output, () => {});
    if ((await read.exited) !== 0) {
      this.fail(flow, `codex logged in but wrote no auth.json: ${tail(document)}`);
      return;
    }
    this.storeCodexDocument(flow, document);
  }

  /**
   * Stores what the Codex CLI wrote, whole.
   *
   * The whole document rather than the access token alone, because the
   * refresh loop needs the refresh token beside it and the orchestrator is
   * the only thing that ever refreshes this credential. What is lifted out of
   * it is only what the settings page shows: when the access token expires,
   * and whose account it is.
   */
  private storeCodexDocument(flow: Flow, document: string): void {
    const parsed = parseAuthDocument(document);
    if (!parsed) {
      this.fail(flow, 'codex wrote an auth.json this does not understand');
      return;
    }
    this.credentials.put('openai', 'oauth', document.trim(), {
      account: parsed.account,
      expires_at: parsed.expiresAt,
      refreshed_at: parsed.lastRefresh,
    });
    this.settle(flow, { state: 'done' });
    log.info('stored a Codex subscription credential', {
      account: parsed.account,
      expiresAt: parsed.expiresAt,
    });
  }

  /**
   * Claude: an interactive terminal UI with a code pasted back.
   *
   * `claude setup-token` has no device-code mode and no non-interactive one.
   * It needs a TTY, prints a URL, blocks on a prompt, and prints a one-year
   * token once the code is entered. Everything here is therefore read off a
   * terminal stream — redraws, escape sequences and all — which is why the
   * scan is over the whole of the stripped output rather than over lines.
   * PLAN.md section 3, verify step 8.
   */
  private async claudeLogin(flow: Flow): Promise<void> {
    const exec = await this.runtime.exec(flow.containerId!, {
      cmd: ['bash', '-lc', 'exec claude setup-token'],
      env: { CLAUDE_CONFIG_DIR },
      tty: true,
    });
    flow.exec = exec;

    let url: string | null = null;
    let token: string | null = null;
    const output = await readOutput(exec.output, (text) => {
      if (flow.settled) return;
      url ??= visitUrlIn(text);
      token ??= CLAUDE_TOKEN.exec(text)?.[0] ?? null;
      if (token) {
        this.storeClaudeToken(flow, token);
        // The token is the end of the flow. The CLI may go on drawing, and
        // waiting for it to exit would risk waiting out the whole timeout on
        // a UI that wants a keypress. Verify step 8 says whether it does.
        exec.kill();
        return;
      }
      if (!url) return;
      // The prompt is what says the CLI is blocked rather than still
      // printing, which is the difference the page draws an input for.
      if (CLAUDE_CODE_PROMPT.test(text)) {
        this.settle(flow, { state: 'awaiting_code', url });
        return;
      }
      this.settle(flow, { state: 'awaiting_browser', url, code: null });
    });

    if (flow.settled) return;
    log.info('claude setup-token finished', { exit: await exec.exited, url, output: tail(output) });
    this.fail(
      flow,
      `claude setup-token printed no token before it ended: ${tail(output)}`,
    );
  }

  /**
   * Stores the token the CLI printed.
   *
   * A year out, because that is what the CLI mints and there is no refresh
   * token to ask for more: at expiry the refresh loop marks the credential
   * `expired` and the settings page asks for another login. The account is
   * left to the store's own rule — the token's last four characters — since
   * `setup-token` reports no account name to put there instead.
   */
  private storeClaudeToken(flow: Flow, token: string): void {
    this.credentials.put('claude', 'token', token, {
      expires_at: Date.now() + CLAUDE_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    });
    this.settle(flow, { state: 'done' });
    log.info('stored a Claude subscription token');
  }

  /** Records a final state, unless the flow already has one. */
  private settle(flow: Flow, state: LoginState): void {
    if (flow.settled) return;
    flow.state = state;
    if (state.state === 'done' || state.state === 'failed') {
      flow.settled = true;
      this.release(flow);
    }
  }

  /** Ends a flow badly, with a sentence the settings page can show. */
  private fail(flow: Flow, error: string): void {
    if (flow.settled) return;
    log.warn('a login failed', { credential: flow.credentialId, error });
    this.settle(flow, { state: 'failed', error });
  }

  /**
   * Ends a flow and takes its container now rather than at its own pace.
   *
   * For a cancel and for the flow a newer login replaced: `run` is still
   * awaiting a stream that only the kill will end, so the removal is started
   * here and `run`'s own cleanup finds nothing left to do.
   */
  private abort(flow: Flow, reason: string): void {
    this.fail(flow, reason);
    const containerId = flow.containerId;
    flow.containerId = null;
    if (containerId) void this.runtime.remove(containerId);
    if (this.flows.get(flow.credentialId) === flow) this.flows.delete(flow.credentialId);
  }

  /** Drops the timer and the exec a settled flow no longer needs. */
  private release(flow: Flow): void {
    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }
    flow.exec?.kill();
  }
}

// --- reading what a CLI printed ---------------------------------------------

/**
 * Everything a stream produces, stripped of terminal escapes, reported as it
 * grows.
 *
 * The callback is handed the whole of the output so far rather than the new
 * piece, because nothing here arrives on a chunk boundary: a URL can be split
 * across two reads, and a terminal UI rewrites lines it has already sent.
 * Scanning the accumulated text costs nothing at these sizes and cannot miss a
 * match that straddles a read.
 */
async function readOutput(
  output: Readable,
  onText: (text: string) => void,
): Promise<string> {
  let text = '';
  try {
    for await (const chunk of output) {
      text = clamp(text + stripAnsi(String(chunk)));
      onText(text);
    }
  } catch (err) {
    // A flow that has what it came for kills the exec, which destroys this
    // stream mid-read. That is an ending rather than a failure, and the text
    // read up to it is the text there was.
    log.debug('a login stream ended abruptly', { error: (err as Error).message });
  }
  return text;
}

/** Keeps the tail of a long stream, so a chatty CLI cannot grow without end. */
function clamp(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

/** The last of some output, for a log line or an error message. */
export function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= ERROR_TAIL ? trimmed : `…${trimmed.slice(-ERROR_TAIL)}`;
}

/**
 * Terminal escape sequences removed.
 *
 * Both CLIs colour their output and one of them is a full-screen UI, so
 * nothing below can match anything until this has run. Covers the two forms
 * that carry meaning here — CSI sequences and OSC strings — and leaves
 * anything else as the text it is.
 */
/** The byte every terminal control sequence starts with. */
const ESC = String.fromCharCode(0x1b);

/** The single-byte form of the same thing, which a CLI may still emit. */
const CSI = String.fromCharCode(0x9b);

/** Operating-system commands: a title change, a hyperlink. */
const OSC_PATTERN = new RegExp(
  `${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)`,
  'g',
);

/** Control sequences: colour, cursor moves, erases, and the shorter escapes. */
const CSI_PATTERN = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]`,
  'g',
);

export function stripAnsi(text: string): string {
  return (
    text
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      // A terminal UI rewrites a line by returning to its start; read as
      // text, that is a new line.
      .replace(/\r\n?/g, '\n')
  );
}

/** The Codex device URL in some output, or null. */
export function deviceUrlIn(text: string): string | null {
  const match = new RegExp(`${CODEX_DEVICE_URL}[^\\s"'<>]*`).exec(text);
  if (match) return match[0];
  // Any other URL on the login host will do. A CLI that moves the path has
  // still sent the person somewhere on the service's own login domain, and
  // showing it beats showing nothing.
  return /https:\/\/auth\.openai\.com\/[^\s"'<>]*/.exec(text)?.[0] ?? null;
}

/** Words that have the shape of a device code and are not one. */
const NOT_A_CODE = new Set([
  'HTTP', 'HTTPS', 'URL', 'CODE', 'OPENAI', 'CHATGPT', 'CODEX', 'ENTER', 'VISIT',
  'PASTE', 'HERE', 'PROMPTED', 'LOGIN', 'DEVICE', 'AUTH', 'COPY', 'PRESS',
  'CTRL', 'WARNING', 'ERROR', 'NOTE', 'THEN', 'YOUR', 'USER', 'OPEN', 'PLEASE',
  'WAITING', 'BROWSER', 'ACCOUNT', 'SUCCESS', 'FAILED', 'TOKEN',
]);

/**
 * The one-time code in some output, or null until one appears.
 *
 * Read by shape rather than by the sentence around it, because the sentence is
 * not an API and the shape is: a run of upper-case letters and digits, in one
 * piece or in two joined by a hyphen. Only the text from the URL onwards is
 * considered, since that is where the CLI prints it, and the URL itself is cut
 * out first so that nothing in it can be mistaken for the code.
 *
 * A word that merely looks like a code is the failure mode, so the obvious
 * ones are excluded and a candidate has to be hyphenated, carry a digit, or be
 * long enough not to be a word anybody writes in capitals. If a real box shows
 * the parse picking the wrong token, the log line beside it carries the
 * untouched output and this is the function to fix. PLAN.md section 3, verify
 * step 9.
 */
export function deviceCodeIn(text: string, url: string): string | null {
  const from = text.indexOf(url);
  const after = (from === -1 ? text : text.slice(from)).split(url).join(' ');
  for (const match of after.matchAll(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*\b/g)) {
    const candidate = match[0];
    if (NOT_A_CODE.has(candidate)) continue;
    if (candidate.includes('-') || /\d/.test(candidate) || candidate.length >= 8) {
      return candidate;
    }
  }
  return null;
}

/**
 * The URL `claude setup-token` wants visited, or null.
 *
 * `Visit:` first, since that is what the CLI labels it with today, and the
 * first https URL otherwise. A terminal wraps a long URL at its own width, so
 * a soft-wrapped one arrives split across lines; the exec asks for a wide
 * terminal to make that unlikely, and verify step 8 is where it is confirmed.
 */
export function visitUrlIn(text: string): string | null {
  const labelled = /Visit:\s*(https?:\/\/[^\s"'<>]+)/i.exec(text);
  if (labelled?.[1]) return labelled[1];
  return /https:\/\/[^\s"'<>]+/.exec(text)?.[0] ?? null;
}
