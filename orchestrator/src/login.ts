/**
 * Account logins. The CLI of a harness runs the login of that harness in a
 * throwaway container. The Dev Tunnels login is the device flow of GitHub,
 * which the orchestrator runs itself.
 *
 * The CLIs do not document the lines they print. So the parsers look for
 * shapes, such as a URL on the service's host, a one-time code or a token
 * prefix, and the raw output goes to the log.
 */

import { randomUUID } from 'node:crypto';
import { finished, PassThrough, type Readable, type Writable } from 'node:stream';
import type { CredentialId, LoginState } from '../../shared/types.ts';
import {
  type CredentialStore,
  DEVTUNNELS_CLIENT_ID,
  GITHUB_TOKEN_URL,
  parseAuthDocument,
  postToken,
  type TokenPost,
} from './credentials.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import { type Login, runtime } from './runtime/runtime.ts';
import { Screen } from './screen.ts';

/** How long a person gets to finish a login before it fails, in milliseconds. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Age in milliseconds after which the sweep removes a login container. */
export const LOGIN_CONTAINER_MAX_AGE_MS = 15 * 60_000;

/** Where Codex keeps its state inside the login container's tmpfs home. */
const CODEX_HOME = '/home/agent/.codex';

/** Where Claude Code keeps its state inside the login container's tmpfs home. */
const CLAUDE_CONFIG_DIR = '/home/agent/.claude';

/**
 * The URL `codex login --device-auth` sends a person to.
 *
 * Matched by prefix, as anything the CLI appends, such as a query with the
 * code, is still the right URL to show.
 */
const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';

/**
 * The pattern of a Claude one-year token, which the login recognises it by.
 *
 * Only the `sk-ant-` prefix is matched, not the kind after it, so a new token
 * kind cannot make the login hang. The minimum length keeps it from matching other text.
 */
const CLAUDE_TOKEN = /sk-ant-[A-Za-z0-9_-]{20,}/;

/** The prompt `claude setup-token` blocks on, read off its screen. */
const CLAUDE_CODE_PROMPT = /paste code here/i;

/**
 * The CLI's complaint about a code it would not take. The login goes on, so
 * the captured sentence is shown beside the input.
 */
const CLAUDE_CODE_REFUSED = /OAuth error:?\s*([^\n]+)/i;

/** What the CLI shows in place of its prompt once it has refused a code. */
const RETRY_PROMPT = /press enter to retry/i;

/**
 * How long to wait between writing a code and writing the return that enters
 * it, in milliseconds.
 *
 * The UI reads a chunk of stdin as one keypress, and two writes back to back
 * arrive as one chunk.
 */
const ENTER_DELAY_MS = 150;

/**
 * How long a token is left to finish arriving before it is stored, in
 * milliseconds.
 *
 * A read can end in the middle of a token, and the part matches the pattern
 * too. The wait is fixed, as the CLI may print nothing more and never exit.
 */
const TOKEN_GRACE_MS = 150;

/** How long a Claude token is valid, in days. It cannot be refreshed. */
const CLAUDE_TOKEN_DAYS = 365;

/** GitHub's endpoint that starts a device login. */
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';

/** The scope the Dev Tunnels app asks of a GitHub account, which is its public profile. */
const DEVTUNNELS_SCOPE = 'read:user';

/** Seconds GitHub adds to the poll interval each time it answers `slow_down`. */
const SLOW_DOWN_SECONDS = 5;

/** How long the GitHub user lookup may take, in milliseconds. */
const LOOKUP_TIMEOUT_MS = 15_000;

/** How many characters of a CLI's output are kept. */
const OUTPUT_LIMIT = 64 * 1024;

/** How many characters of the output a log line or error reports. */
const ERROR_TAIL = 600;

/** The credentials that have a login flow at all. */
export const LOGIN_CREDENTIALS: readonly CredentialId[] = ['claude', 'openai', 'devtunnels'];

/**
 * Checks if a credential is obtained by logging in rather than by pasting.
 *
 * @param id The id of the credential.
 * @returns True when the credential has a login flow.
 */
export function hasLoginFlow(id: CredentialId): boolean {
  return LOGIN_CREDENTIALS.includes(id);
}

/**
 * The terminal size of an interactive login. A login URL is longer than the
 * default 80 columns, and a wrapped URL reads as two lines.
 */
const LOGIN_TERMINAL = { cols: 400, rows: 50 };

/** One command a login runs in its container. */
export interface LoginExecSpec {
  /** The argument vector. */
  cmd: readonly string[];
  /** Variables set for the command. */
  env?: Record<string, string>;
  /** True for a terminal and a writable stdin, which an interactive CLI needs. */
  tty?: boolean;
}

/**
 * A running login command: what it prints, what it can be told, and its end.
 * A CLI does not promise the stream that it prints its URL on, so the flows
 * read both.
 */
export interface LoginExec {
  /** stdout and stderr merged, in the order they were written. */
  output: Readable;
  /** The stdin of a TTY exec, or null for other execs. */
  stdin: Writable | null;
  /** Resolves when the command ends, with the exit code if known. */
  exited: Promise<number | null>;
  /** Ends the command's stream. */
  kill(): void;
}

/**
 * Runs one command in a login container.
 *
 * `tty` is for `claude setup-token`, an interactive UI that refuses to run
 * without a terminal and reads the code from stdin. Under a TTY the output is
 * one raw stream, with the CLI's redraws and escape sequences.
 *
 * @param login The login container.
 * @param spec The command and its options.
 * @returns The running command.
 */
async function spawnLogin(login: Login, spec: LoginExecSpec): Promise<LoginExec> {
  const proc = await login.spawn(spec.cmd, {
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.tty ? { tty: LOGIN_TERMINAL } : {}),
  });
  const output = new PassThrough();
  let open = 2;
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.pipe(output, { end: false });
    finished(stream, () => {
      open -= 1;
      if (open === 0) output.end();
    });
  }
  return {
    output,
    stdin: spec.tty ? proc.stdin : null,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

/** What the Dev Tunnels login needs from GitHub. An interface, so tests can fake it. */
export interface GitHubClient {
  /** One POST to an OAuth endpoint. */
  post: TokenPost;
  /**
   * Returns the login name of the account that a token belongs to.
   *
   * @param token The access token.
   * @returns The login name, or null when GitHub does not say.
   */
  login(token: string): Promise<string | null>;
}

/** The client that calls the real GitHub endpoints. */
export const gitHubClient: GitHubClient = {
  post: postToken,
  async login(token) {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const login = ((await res.json()) as { login?: unknown }).login;
      return typeof login === 'string' && login !== '' ? login : null;
    } catch {
      return null;
    }
  },
};

/** One login in progress, or the last one that finished. */
interface Flow {
  /** The login id the page polls with. */
  id: string;
  /** The credential the login is for. */
  credentialId: CredentialId;
  /** Where the login has got to. */
  state: LoginState;
  /** The login container, or null before it starts and after removal. */
  login: Login | null;
  /** The running CLI, or null. */
  exec: LoginExec | null;
  /** True once the state is `done` or `failed`. Nothing changes the state afterwards. */
  settled: boolean;
  /** Why the last code was refused, until another one is sent. */
  refusal: string | null;
  /** True when Enter for the retry that the CLI waits on was pressed already. */
  retrying: boolean;
  /** The LOGIN_TIMEOUT_MS timer, or null once released. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Runs the logins, one per credential at a time. Two logins for one
 * credential would race to write the same row, so a new one cancels the old.
 */
export class LoginManager {
  /** The current flow of each credential. */
  private readonly flows = new Map<CredentialId, Flow>();

  /**
   * @param credentials The store that a finished login writes its credential to.
   * @param timeoutMs How long a login may take, in milliseconds.
   * @param github The client that the Dev Tunnels login uses to call GitHub.
   */
  constructor(
    /** Where a finished login stores its credential. */
    private readonly credentials: CredentialStore,
    /** How long a login may take, in milliseconds. */
    private readonly timeoutMs: number = LOGIN_TIMEOUT_MS,
    /** Where the Dev Tunnels login talks to GitHub. */
    private readonly github: GitHubClient = gitHubClient,
  ) {}

  /**
   * Starts a login. It returns before the container starts, and the page
   * shows the `starting` state meanwhile. A new login cancels the current login
   * of the same credential.
   *
   * @param credentialId The credential to log in for.
   * @returns The login id that the page polls with.
   * @throws HttpError with status 400 when the credential has no login flow.
   */
  start(credentialId: CredentialId): string {
    if (!hasLoginFlow(credentialId)) {
      throw new HttpError(
        400,
        `${credentialId} has no login flow: paste its token on the settings page instead`,
      );
    }
    const previous = this.flows.get(credentialId);
    if (previous) this.abort(previous, 'a newer login replaced this one');

    const flow: Flow = {
      id: randomUUID(),
      credentialId,
      state: { state: 'starting' },
      login: null,
      exec: null,
      settled: false,
      refusal: null,
      retrying: false,
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

  /**
   * Returns the state of a login.
   *
   * @param credentialId The credential of the login.
   * @param loginId The login id.
   * @returns The state.
   * @throws HttpError with status 404 when the login is not the current one.
   */
  state(credentialId: CredentialId, loginId: string): LoginState {
    return this.flow(credentialId, loginId).state;
  }

  /**
   * Types the code the person pasted into the CLI's prompt.
   *
   * It also accepts a code before the prompt is drawn, as the CLI reads the
   * stream when it gets there.
   *
   * The code is entered with a carriage return, as a raw-mode UI does not turn
   * a newline into Enter. The return is written ENTER_DELAY_MS later, as a
   * separate keypress.
   *
   * @param credentialId The credential of the login.
   * @param loginId The login id.
   * @param code The code that the person pasted.
   * @throws HttpError with status 404 when the login is not the current one, 400 for an empty code, and 409 when
   *   the login does not wait for a code or has no stdin, such as the Codex flow.
   */
  submitCode(credentialId: CredentialId, loginId: string, code: string): void {
    const flow = this.flow(credentialId, loginId);
    const trimmed = code.trim();
    if (trimmed === '') throw new HttpError(400, 'code is required');
    const waiting = flow.state.state === 'awaiting_code' || flow.state.state === 'awaiting_browser';
    if (!waiting || !flow.exec?.stdin) {
      throw new HttpError(409, 'this login is not waiting for a code');
    }
    // The refusal was about the previous code, so it goes now.
    flow.refusal = null;
    if (flow.state.state === 'awaiting_code' && flow.state.error !== null) {
      this.settle(flow, { state: 'awaiting_code', url: flow.state.url, error: null });
    }
    const stdin = flow.exec.stdin;
    stdin.write(trimmed);
    const enter = setTimeout(() => {
      // The flow may have ended while this waited, taking the stream with it.
      if (flow.settled || !stdin.writable) return;
      stdin.write('\r');
    }, ENTER_DELAY_MS);
    enter.unref?.();
  }

  /**
   * Gives up on a login and removes its container.
   *
   * @param credentialId The credential of the login.
   * @param loginId The login id.
   * @throws HttpError with status 404 when the login is not the current one.
   */
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

  /**
   * Returns the named flow.
   *
   * @param credentialId The credential of the login.
   * @param loginId The login id.
   * @returns The flow.
   * @throws HttpError with status 404 when the flow is not the current one.
   */
  private flow(credentialId: CredentialId, loginId: string): Flow {
    const flow = this.flows.get(credentialId);
    if (!flow || flow.id !== loginId) {
      throw new HttpError(404, 'no such login: it finished, was cancelled, or was replaced');
    }
    return flow;
  }

  /**
   * Runs one flow to its end, and cleans up whatever it was holding.
   *
   * @param flow The flow.
   */
  private async run(flow: Flow): Promise<void> {
    if (flow.credentialId === 'devtunnels') {
      try {
        await this.devTunnelsLogin(flow);
      } catch (err) {
        this.fail(flow, (err as Error).message);
      } finally {
        this.release(flow);
      }
      return;
    }
    try {
      const login = await runtime().startLogin(flow.credentialId);
      flow.login = login;
      if (flow.settled) return;
      if (flow.credentialId === 'openai') await this.codexLogin(flow, login);
      else await this.claudeLogin(flow, login);
    } catch (err) {
      this.fail(flow, (err as Error).message);
    } finally {
      // The container always goes, as its home holds new credential material.
      this.release(flow);
      if (flow.login) {
        const login = flow.login;
        flow.login = null;
        await login.remove();
      }
    }
  }

  /**
   * Runs the Codex device-code flow.
   *
   * The CLI reads no stdin. It prints a URL and a one-time code, waits for the
   * person, writes `auth.json` and exits 0. On failure it exits 1 with the
   * reason on stderr.
   *
   * @param flow The flow.
   * @param login The login container.
   */
  private async codexLogin(flow: Flow, login: Login): Promise<void> {
    const exec = await spawnLogin(login, {
      // The Codex CLI fails when CODEX_HOME does not exist.
      cmd: ['bash', '-lc', `mkdir -p "$CODEX_HOME" && exec codex login --device-auth`],
      env: { CODEX_HOME },
    });
    flow.exec = exec;

    let url: string | null = null;
    let code: string | null = null;
    const output = await readOutput(exec.output, (text) => {
      if (flow.settled) return;
      url = grown(url, deviceUrlIn(text));
      if (!url) return;
      code = grown(code, deviceCodeIn(text, url));
      this.settle(flow, { state: 'awaiting_browser', url, code });
    });

    if (flow.settled) return;
    const exit = await exec.exited;
    // The raw output, so a person can finish by hand if the parse failed.
    log.info('codex device login finished', { exit, url, code, output: tail(output) });
    if (exit !== 0) {
      this.fail(flow, `codex login exited ${exit ?? 'without a status'}: ${tail(output)}`);
      return;
    }

    const read = await spawnLogin(login, {
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
   * Stores the whole document the Codex CLI wrote, as the refresh needs the
   * refresh token beside the access token.
   *
   * @param flow The flow.
   * @param document The content of `auth.json`.
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
   * Runs the GitHub device flow for the Dev Tunnels app.
   *
   * GitHub hands out a one-time code, which the page shows with its URL, and
   * the orchestrator polls until the person has entered it.
   *
   * @param flow The flow.
   * @throws Error when GitHub does not start the device login.
   */
  private async devTunnelsLogin(flow: Flow): Promise<void> {
    const started = await this.github.post(GITHUB_DEVICE_CODE_URL, {
      client_id: DEVTUNNELS_CLIENT_ID,
      scope: DEVTUNNELS_SCOPE,
    });
    const { device_code: deviceCode, user_code: userCode, verification_uri: url } = started;
    if (!deviceCode || !userCode || !url) {
      throw new Error(
        `GitHub did not start a device login: ${started.error_description ?? started.error ?? 'no code in the answer'}`,
      );
    }
    this.settle(flow, { state: 'awaiting_browser', url, code: userCode });

    let interval = started.interval ?? SLOW_DOWN_SECONDS;
    while (!flow.settled) {
      await sleep(interval * 1000);
      if (flow.settled) return;
      const answer = await this.github.post(GITHUB_TOKEN_URL, {
        client_id: DEVTUNNELS_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (flow.settled) return;
      if (answer.access_token) {
        await this.storeDevTunnelsLogin(flow, answer.access_token, answer);
        return;
      }
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') {
        interval += SLOW_DOWN_SECONDS;
        continue;
      }
      this.fail(
        flow,
        `GitHub ended the login: ${answer.error_description ?? answer.error ?? 'no token in the answer'}`,
      );
      return;
    }
  }

  /**
   * Stores a Dev Tunnels login as a document with both tokens, named by the
   * GitHub account it belongs to.
   *
   * @param flow The flow.
   * @param accessToken The access token.
   * @param answer The token answer of GitHub, with the refresh token and the lifetime.
   */
  private async storeDevTunnelsLogin(
    flow: Flow,
    accessToken: string,
    answer: { refresh_token?: string; expires_in?: number },
  ): Promise<void> {
    const account = await this.github.login(accessToken);
    if (flow.settled) return;
    const now = Date.now();
    this.credentials.put(
      'devtunnels',
      'oauth',
      JSON.stringify({ access_token: accessToken, refresh_token: answer.refresh_token ?? '' }),
      {
        // Without an account name, the store shows the last four characters of the document.
        account: account ?? 'a GitHub account',
        expires_at: answer.expires_in ? now + answer.expires_in * 1000 : null,
        refreshed_at: now,
      },
    );
    this.settle(flow, { state: 'done' });
    log.info('stored a Dev Tunnels login', { account });
  }

  /**
   * Runs the Claude login, an interactive terminal UI with a code pasted back.
   *
   * `claude setup-token` needs a TTY. It prints a URL, blocks on a prompt, and
   * prints a one-year token once the code is entered. The scan reads a
   * rebuilt screen, as the UI redraws only the cells it changes.
   *
   * @param flow The flow.
   * @param login The login container.
   */
  private async claudeLogin(flow: Flow, login: Login): Promise<void> {
    const exec = await spawnLogin(login, {
      cmd: ['bash', '-lc', 'exec claude setup-token'],
      env: { CLAUDE_CONFIG_DIR },
      tty: true,
    });
    flow.exec = exec;

    let url: string | null = null;
    let token: string | null = null;
    /** The timer that stores the token. It starts once a token is seen, so the rest can arrive. */
    let storing: ReturnType<typeof setTimeout> | null = null;
    /**
     * True once the CLI has asked for a code. It stays true, as a refusal
     * draws over the prompt while the CLI still wants a code.
     */
    let prompted = false;
    const output = await readScreen(exec.output, (text) => {
      if (flow.settled) return;
      // The only record of what the login showed.
      log.debug('claude login output', { text: tail(text) });
      url = grown(url, visitUrlIn(text));
      token = grown(token, CLAUDE_TOKEN.exec(text)?.[0] ?? null);
      if (token) {
        // The token ends the flow, without waiting for the CLI to exit. It is
        // stored after TOKEN_GRACE_MS, as a read may end mid-token.
        storing ??= setTimeout(() => {
          if (flow.settled) return;
          if (token) this.storeClaudeToken(flow, token);
          exec.kill();
        }, TOKEN_GRACE_MS);
        return;
      }
      if (!url) return;
      // The prompt shows the CLI is waiting, and the page then draws an input.
      prompted ||= CLAUDE_CODE_PROMPT.test(text);
      if (prompted) {
        // Kept on the flow, as the retry below takes the complaint off the
        // screen. submitCode clears it.
        const reason = CLAUDE_CODE_REFUSED.exec(text)?.[1]?.trim() ?? null;
        if (reason !== null && flow.refusal === null) {
          flow.refusal = reason;
          log.warn('the CLI refused a login code', { reason });
        }
        // After a refusal the CLI discards input until Enter brings the
        // prompt back, so Enter is pressed here for the person.
        if (RETRY_PROMPT.test(text) && !flow.retrying) {
          flow.retrying = true;
          exec.stdin?.write('\r');
        } else if (!RETRY_PROMPT.test(text)) {
          flow.retrying = false;
        }
        this.settle(flow, { state: 'awaiting_code', url, error: flow.refusal });
        return;
      }
      this.settle(flow, { state: 'awaiting_browser', url, code: null });
    });

    if (storing) clearTimeout(storing);
    if (flow.settled) return;
    if (token) {
      // The CLI ended during the grace wait, so the token is complete.
      this.storeClaudeToken(flow, token);
      return;
    }
    log.info('claude setup-token finished', { exit: await exec.exited, url, output: tail(output) });
    this.fail(flow, `claude setup-token printed no token before it ended: ${tail(output)}`);
  }

  /**
   * Stores the token the CLI printed, expiring CLAUDE_TOKEN_DAYS from now.
   * `setup-token` reports no account name, so the store uses the token's
   * last four characters.
   *
   * @param flow The flow.
   * @param token The token.
   */
  private storeClaudeToken(flow: Flow, token: string): void {
    this.credentials.put('claude', 'token', token, {
      expires_at: Date.now() + CLAUDE_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    });
    this.settle(flow, { state: 'done' });
    log.info('stored a Claude subscription token');
  }

  /**
   * Records a new state, unless the flow has ended. `done` and `failed` end it.
   *
   * @param flow The flow.
   * @param state The new state.
   */
  private settle(flow: Flow, state: LoginState): void {
    if (flow.settled) return;
    flow.state = state;
    if (state.state === 'done' || state.state === 'failed') {
      flow.settled = true;
      this.release(flow);
    }
  }

  /**
   * Ends a flow as failed.
   *
   * @param flow The flow.
   * @param error The sentence that the settings page shows.
   */
  private fail(flow: Flow, error: string): void {
    if (flow.settled) return;
    log.warn('a login failed', { credential: flow.credentialId, error });
    this.settle(flow, { state: 'failed', error });
  }

  /**
   * Fails a flow, removes its container now, and forgets it. Used for a
   * cancel, a shutdown, and a flow that a newer login replaced. `run` then finds no
   * container left to remove.
   *
   * @param flow The flow.
   * @param reason The sentence that the settings page shows.
   */
  private abort(flow: Flow, reason: string): void {
    this.fail(flow, reason);
    const login = flow.login;
    flow.login = null;
    if (login) void login.remove();
    if (this.flows.get(flow.credentialId) === flow) this.flows.delete(flow.credentialId);
  }

  /**
   * Drops the timer and the exec a settled flow no longer needs.
   *
   * @param flow The flow.
   */
  private release(flow: Flow): void {
    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }
    flow.exec?.kill();
  }
}

/**
 * Waits without holding the process open.
 *
 * @param ms The time to wait, in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Reads a redrawing CLI's terminal, and returns what is on its screen at the
 * end. onText gets the screen after every chunk, as the URL and the prompt
 * may be drawn over later.
 *
 * @param output The terminal stream.
 * @param onText The function that gets the screen after every chunk.
 * @returns The text on the screen at the end.
 */
async function readScreen(output: Readable, onText: (text: string) => void): Promise<string> {
  const screen = new Screen();
  try {
    for await (const chunk of output) {
      screen.write(String(chunk));
      onText(screen.text);
    }
  } catch (err) {
    log.debug('a login stream ended abruptly', { error: (err as Error).message });
  }
  return screen.text;
}

/**
 * Reads a stream to its end, stripped of terminal escapes, and returns the
 * text. onText gets the whole text so far after every chunk, as a match may
 * be split across reads.
 *
 * @param output The stream.
 * @param onText The function that gets the text so far after every chunk.
 * @returns The text, up to OUTPUT_LIMIT characters from the end.
 */
async function readOutput(output: Readable, onText: (text: string) => void): Promise<string> {
  let text = '';
  try {
    for await (const chunk of output) {
      text = clamp(text + stripAnsi(String(chunk)));
      onText(text);
    }
  } catch (err) {
    // A flow that is done kills the exec, which ends this stream mid-read.
    log.debug('a login stream ended abruptly', { error: (err as Error).message });
  }
  return text;
}

/**
 * Keeps the tail of a long stream, so the output of a CLI that prints much cannot grow without end.
 *
 * @param text The text so far.
 * @returns The last OUTPUT_LIMIT characters.
 */
function clamp(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

/**
 * Returns the end of some output, for a log line or an error message.
 *
 * @param text The output.
 * @returns The last ERROR_TAIL characters of the trimmed output, with an ellipsis in front when it was cut.
 */
export function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= ERROR_TAIL ? trimmed : `…${trimmed.slice(-ERROR_TAIL)}`;
}

/** The byte every terminal control sequence starts with. */
const ESC = String.fromCharCode(0x1b);

/** The single-byte form of ESC [, which a CLI may still emit. */
const CSI = String.fromCharCode(0x9b);

/** Matches operating-system commands, for example a title change or a hyperlink. */
const OSC_PATTERN = new RegExp(`${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g');

/** Matches control sequences, for example colour, cursor moves and erases, and the shorter escapes. */
const CSI_PATTERN = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]`,
  'g',
);

/**
 * Returns the text with its CSI and OSC terminal sequences removed, and with
 * carriage returns turned into newlines.
 *
 * @param text The terminal output.
 * @returns The plain text.
 */
export function stripAnsi(text: string): string {
  return (
    text
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      // A terminal UI rewrites a line by returning to its start. As text, the
      // return starts a new line.
      .replace(/\r\n?/g, '\n')
  );
}

/**
 * Returns the later reading when it extends the earlier one, and the earlier
 * one otherwise.
 *
 * A read may end in the middle of a URL or a code, so a longer later reading
 * replaces it. A redraw may cut a value short later, so a reading that does
 * not start with the earlier one is ignored.
 *
 * @param seen The earlier reading, or null.
 * @param read The later reading, or null.
 * @returns The reading to keep.
 */
export function grown(seen: string | null, read: string | null): string | null {
  if (read === null) return seen;
  if (seen === null || read.startsWith(seen)) return read;
  return seen;
}

/**
 * Returns the Codex device URL in some output.
 *
 * @param text The output.
 * @returns The URL, or null.
 */
export function deviceUrlIn(text: string): string | null {
  const match = new RegExp(`${CODEX_DEVICE_URL}[^\\s"'<>]*`).exec(text);
  if (match) return match[0];
  // Otherwise any URL on the login host, in case the CLI moved the path.
  return /https:\/\/auth\.openai\.com\/[^\s"'<>]*/.exec(text)?.[0] ?? null;
}

/** Words that have the shape of a device code and are not one. */
const NOT_A_CODE = new Set([
  'HTTP',
  'HTTPS',
  'URL',
  'CODE',
  'OPENAI',
  'CHATGPT',
  'CODEX',
  'ENTER',
  'VISIT',
  'PASTE',
  'HERE',
  'PROMPTED',
  'LOGIN',
  'DEVICE',
  'AUTH',
  'COPY',
  'PRESS',
  'CTRL',
  'WARNING',
  'ERROR',
  'NOTE',
  'THEN',
  'YOUR',
  'USER',
  'OPEN',
  'PLEASE',
  'WAITING',
  'BROWSER',
  'ACCOUNT',
  'SUCCESS',
  'FAILED',
  'TOKEN',
]);

/**
 * Returns the one-time code in some output, or null until one appears.
 *
 * It matches the shape: runs of four or more upper-case letters and digits,
 * joined by hyphens. Only text from the URL on is searched, with the URL cut
 * out. Words in NOT_A_CODE are skipped, and a match must have a hyphen, a
 * digit, or at least eight characters.
 *
 * @param text The output.
 * @param url The device URL in the output.
 * @returns The code, or null.
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
 * Returns the URL that `claude setup-token` asks the person to visit, or null.
 *
 * It prefers the URL after `Visit:`, and takes the first https URL otherwise.
 *
 * @param text The screen text.
 * @returns The URL, or null.
 */
export function visitUrlIn(text: string): string | null {
  const labelled = /Visit:\s*(https?:\/\/[^\s"'<>]+)/i.exec(text);
  if (labelled?.[1]) return labelled[1];
  return /https:\/\/[^\s"'<>]+/.exec(text)?.[0] ?? null;
}
