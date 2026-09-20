import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'vitest';
import { CredentialStore, parseAuthDocument } from './credentials.ts';
import { openDb, type Db } from './db.ts';
import { HttpError } from './http-error.ts';
import {
  deviceCodeIn,
  deviceUrlIn,
  LoginManager,
  stripAnsi,
  visitUrlIn,
  type LoginExec,
  type LoginExecSpec,
  type LoginRuntime,
} from './login.ts';

/**
 * The two login flows, over a scripted exec.
 *
 * Everything a login does is read something a CLI printed and answer it, so
 * the only part worth a daemon is the part a daemon cannot be asked about
 * here. The runtime is injected and the streams are written by hand, exactly
 * as `docker.test.ts` fakes dockerode — which also means these tests say what
 * the parse expects, and a real box that prints something else is a change to
 * the strings below.
 */

/** The escape byte, spelled rather than typed, so the source stays printable. */
const ESC = String.fromCharCode(27);

/** Some output as a colouring CLI would actually write it. */
function coloured(text: string): string {
  return `${ESC}[1;32m${text}${ESC}[0m`;
}

/** One scripted command: what it prints, what it is told, and how it ends. */
class FakeExec implements LoginExec {
  readonly output = new PassThrough();
  readonly stdin: PassThrough | null;
  /** Everything the flow wrote back to the CLI. */
  input = '';
  /** The same, kept as the separate writes it arrived in: the UI reads one
      chunk as one keypress, so how it was split is part of what was sent. */
  chunks: string[] = [];
  killed = false;
  readonly exited: Promise<number | null>;
  private settle: (code: number | null) => void = () => {};

  constructor(readonly spec: LoginExecSpec) {
    this.stdin = spec.tty ? new PassThrough() : null;
    this.stdin?.on('data', (chunk: Buffer) => {
      this.input += chunk.toString('utf8');
      this.chunks.push(chunk.toString('utf8'));
    });
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  print(text: string): void {
    this.output.write(text);
  }

  /** The command exits, which is what ends its output. */
  end(code = 0): void {
    this.output.end();
    this.settle(code);
  }

  kill(): void {
    this.killed = true;
    this.output.destroy();
    this.settle(null);
  }
}

/** The daemon this suite pretends to talk to. */
interface Fake {
  runtime: LoginRuntime;
  started: string[];
  removed: string[];
  execs: FakeExec[];
}

function fakeRuntime(): Fake {
  const fake: Fake = {
    started: [],
    removed: [],
    execs: [],
    runtime: {
      async start(credentialId) {
        const id = `login-${credentialId}-${fake.started.length + 1}`;
        fake.started.push(id);
        return id;
      },
      async exec(_containerId, spec) {
        const exec = new FakeExec(spec);
        fake.execs.push(exec);
        return exec;
      },
      async remove(containerId) {
        fake.removed.push(containerId);
      },
    },
  };
  return fake;
}

/** Waits for something the flow does on its own, or gives up loudly. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A JWT as the two services mint them: three parts, only one of them read. */
function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `header.${body}.signature`;
}

/** What `codex login --device-auth` leaves behind. */
function authJson(expSeconds: number, email = 'someone@example.com'): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ 'https://api.openai.com/profile': { email } }),
      access_token: jwt({ exp: expSeconds }),
      refresh_token: 'refresh-me',
      account_id: 'acct_123',
    },
    last_refresh: '2026-09-12T10:00:00Z',
  });
}

let dir: string;
let db: Db;
let store: CredentialStore;
let fake: Fake;
let logins: LoginManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-login-'));
  db = openDb(dir);
  store = new CredentialStore(db, () => {});
  fake = fakeRuntime();
  logins = new LoginManager(store, fake.runtime, 5_000);
});

afterEach(() => {
  logins.closeAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the Codex flow shows a URL and a code, and stores the document the CLI wrote', async () => {
  const loginId = logins.start('openai');
  assert.deepEqual(logins.state('openai', loginId), { state: 'starting' });

  await until('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  // The CLI reads nothing from stdin, and its state has to go somewhere the
  // read-only rootfs allows.
  assert.equal(cli.spec.tty, undefined);
  assert.match(cli.spec.cmd.join(' '), /codex login --device-auth/);
  assert.equal(cli.spec.env?.['CODEX_HOME'], '/home/agent/.codex');

  // Coloured, and split across reads, because that is how it arrives.
  cli.print(`Open this URL to authenticate:\n  ${coloured('https://auth.openai.com/codex/dev')}`);
  cli.print('ice\nand enter the code ');
  cli.print(`${coloured('WXYZ-1234')}\n`);

  await until('the URL and the code to be read', () => {
    const state = logins.state('openai', loginId);
    return state.state === 'awaiting_browser' && state.code !== null;
  });
  assert.deepEqual(logins.state('openai', loginId), {
    state: 'awaiting_browser',
    url: 'https://auth.openai.com/codex/device',
    code: 'WXYZ-1234',
  });

  cli.print('Successfully logged in\n');
  cli.end(0);

  // The login ends by reading the file the CLI wrote, in the same container.
  await until('auth.json to be read', () => fake.execs.length === 2);
  const read = fake.execs[1]!;
  assert.deepEqual([...read.spec.cmd], ['cat', '/home/agent/.codex/auth.json']);
  const document = authJson(1_800_000_000);
  read.print(document);
  read.end(0);

  await until('the login to finish', () => logins.state('openai', loginId).state === 'done');

  const row = store.get('openai');
  assert.equal(row?.method, 'oauth');
  // The whole document, so the refresh has the refresh token beside the
  // access token.
  assert.equal(row?.secret, document);
  assert.equal(row?.account, 'someone@example.com');
  assert.equal(row?.expires_at, 1_800_000_000_000);
  // And the container it all ran in is gone.
  await until('the container to be removed', () => fake.removed.length === 1);
  assert.deepEqual(fake.removed, [fake.started[0]]);
});

test('a Codex login that exits non-zero fails with what it printed', async () => {
  const loginId = logins.start('openai');
  await until('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  cli.print('device code login is disabled for this account\n');
  cli.end(1);

  await until('the failure', () => logins.state('openai', loginId).state === 'failed');
  const state = logins.state('openai', loginId);
  assert.equal(state.state, 'failed');
  assert.match(state.state === 'failed' ? state.error : '', /disabled for this account/);
  assert.equal(store.get('openai'), undefined);
  await until('the container to be removed', () => fake.removed.length === 1);
});

test('the Claude flow takes a code back and stores the token it prints', async () => {
  const loginId = logins.start('claude');
  await until('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  // An Ink UI: it refuses to run without a terminal, and the code goes back
  // up the same stream.
  assert.equal(cli.spec.tty, true);
  assert.match(cli.spec.cmd.join(' '), /claude setup-token/);

  cli.print(`${ESC}[2J${ESC}[HVisit: https://claude.ai/oauth/authorize?code=true\n`);
  await until('the URL to be read', () => {
    return logins.state('claude', loginId).state === 'awaiting_browser';
  });
  assert.deepEqual(logins.state('claude', loginId), {
    state: 'awaiting_browser',
    url: 'https://claude.ai/oauth/authorize?code=true',
    code: null,
  });

  cli.print('\nPaste code here if prompted > ');
  await until('the prompt', () => logins.state('claude', loginId).state === 'awaiting_code');

  logins.submitCode('claude', loginId, '  the-code-from-the-page  ');
  await until('the code to be entered', () => cli.input.endsWith('\r'));
  // A carriage return, which is what the Enter key sends: the UI reads its
  // terminal raw, and a newline is typed rather than entered.
  assert.equal(cli.input, 'the-code-from-the-page\r');

  cli.print('\nsk-ant-oat01-abcdefghijklmnop1234\n');
  await until('the login to finish', () => logins.state('claude', loginId).state === 'done');

  const row = store.get('claude');
  assert.equal(row?.method, 'token');
  assert.equal(row?.secret, 'sk-ant-oat01-abcdefghijklmnop1234');
  // A year, because that is what the CLI mints and nothing can renew it.
  const year = 365 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs((row?.expires_at ?? 0) - (Date.now() + year)) < 60_000);
  // The token is the end of the flow, whatever the UI does next.
  assert.equal(cli.killed, true);
  await until('the container to be removed', () => fake.removed.length === 1);
});

test('the prompt is recognised when the UI lays it out by column', async () => {
  const loginId = logins.start('claude');
  await until('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  cli.print('Visit: https://claude.ai/oauth/authorize?code=true\n');
  await until('the URL', () => logins.state('claude', loginId).state === 'awaiting_browser');

  // What the CLI actually writes: each word placed at a column of its own,
  // which leaves the stripped text with no spaces in it at all.
  cli.print(
    `${ESC}[2GPaste${ESC}[8Gcode${ESC}[13Ghere${ESC}[18Gif${ESC}[21Gprompted${ESC}[30G>`,
  );
  await until('the prompt', () => logins.state('claude', loginId).state === 'awaiting_code');
  assert.equal(logins.state('claude', loginId).state, 'awaiting_code');
});

test('a code sent before the prompt is drawn still reaches the CLI', async () => {
  const loginId = logins.start('claude');
  await until('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  cli.print('Visit: https://claude.ai/oauth/authorize\n');
  await until('the URL', () => logins.state('claude', loginId).state === 'awaiting_browser');

  // Whether the prompt has been drawn is a race about terminal output; the
  // stream takes the answer either way.
  logins.submitCode('claude', loginId, 'early');
  await until('the code to be entered', () => cli.input.endsWith('\r'));
  assert.equal(cli.input, 'early\r');
});

test('the return that enters a code is a keypress of its own', async () => {
  const loginId = logins.start('claude');
  await until('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  cli.print('Visit: https://claude.ai/oauth/authorize\nPaste code here if prompted > ');
  await until('the prompt', () => logins.state('claude', loginId).state === 'awaiting_code');

  // The length of a real one. A short code hides this: it arrives in a chunk
  // small enough that the UI reads the return in it as the key either way.
  const code = 'a'.repeat(92);
  logins.submitCode('claude', loginId, code);
  await until('the code to be entered', () => cli.input.endsWith('\r'));

  // The code is typed and the return enters it, as two writes with a pause
  // between them: sent together the UI takes the return for part of what was
  // typed, and the code is never entered.
  assert.deepEqual(cli.chunks, [code, '\r']);
});

test('a code the CLI refuses is shown, and the login stays open for another', async () => {
  const loginId = logins.start('claude');
  await until('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  cli.print('Visit: https://claude.ai/oauth/authorize\r\nPaste code here if prompted > ');
  await until('the prompt', () => logins.state('claude', loginId).state === 'awaiting_code');

  logins.submitCode('claude', loginId, 'the-wrong-one');
  // The CLI's own complaint, with the prompt drawn again underneath: it is
  // asking for another code rather than ending.
  const complaint = 'Invalid code. Please make sure the full code was copied.';
  cli.print(`\r\nOAuth error: ${complaint}\r\nPaste code here if prompted > `);
  await until('the refusal to be read', () => {
    const state = logins.state('claude', loginId);
    return state.state === 'awaiting_code' && state.error !== null;
  });
  const refused = logins.state('claude', loginId);
  assert.equal(refused.state, 'awaiting_code');
  // The CLI's own words, whole: the screen it is read off kept every
  // character it drew.
  assert.equal(refused.state === 'awaiting_code' ? refused.error : null, complaint);

  // Sending another code takes the answered complaint off the page at once,
  // rather than leaving the last code's refusal standing over this one.
  logins.submitCode('claude', loginId, 'the-right-one');
  const answered = logins.state('claude', loginId);
  assert.equal(answered.state === 'awaiting_code' ? answered.error : 'x', null);

  cli.print('\r\nsk-ant-oat01-abcdefghijklmnop1234\r\n');
  await until('the login to finish', () => logins.state('claude', loginId).state === 'done');
  assert.equal(store.get('claude')?.secret, 'sk-ant-oat01-abcdefghijklmnop1234');
});

test('a login that never finishes fails, and takes its container with it', async () => {
  const quick = new LoginManager(store, fake.runtime, 10);
  const loginId = quick.start('openai');

  await until('the timeout', () => quick.state('openai', loginId).state === 'failed');
  const state = quick.state('openai', loginId);
  assert.match(state.state === 'failed' ? state.error : '', /not finished/);
  await until('the container to be removed', () => fake.removed.length === 1);
  assert.equal(store.get('openai'), undefined);
});

test('cancelling ends the login, removes the container, and forgets the id', async () => {
  const loginId = logins.start('openai');
  await until('the CLI to be running', () => fake.execs.length === 1);

  logins.cancel('openai', loginId);
  await until('the container to be removed', () => fake.removed.length === 1);
  assert.throws(() => logins.state('openai', loginId), (err: unknown) => {
    return err instanceof HttpError && err.statusCode === 404;
  });
  assert.equal(store.get('openai'), undefined);
});

test('a second login cancels the first, and the first id stops resolving', async () => {
  const first = logins.start('openai');
  await until('the first CLI', () => fake.execs.length === 1);
  const second = logins.start('openai');

  await until('the first container to go', () => fake.removed.length >= 1);
  assert.equal(fake.removed[0], fake.started[0]);
  assert.throws(() => logins.state('openai', first));
  assert.equal(logins.state('openai', second).state !== 'failed', true);
});

test('GitHub has no login flow and says so instead of starting a container', () => {
  assert.throws(
    () => logins.start('github'),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400,
  );
  assert.deepEqual(fake.started, []);
});

test('a code is refused when no login is waiting for one', async () => {
  const loginId = logins.start('openai');
  await until('the CLI to be running', () => fake.execs.length === 1);

  assert.throws(
    () => logins.submitCode('openai', loginId, 'x'),
    (err: unknown) => err instanceof HttpError && err.statusCode === 409,
  );
  assert.throws(
    () => logins.submitCode('openai', 'not-this-login', 'x'),
    (err: unknown) => err instanceof HttpError && err.statusCode === 404,
  );
});

// --- reading what a CLI printed ----------------------------------------------

test('terminal escapes are removed before anything is read', () => {
  assert.equal(stripAnsi(`${ESC}[1mbold${ESC}[0m`), 'bold');
  assert.equal(stripAnsi(`${ESC}[2J${ESC}[Hcleared`), 'cleared');
  // A redrawn line reads as a new one rather than as a joined one.
  assert.equal(stripAnsi('one\rtwo'), 'one\ntwo');
});

test('the device URL is taken by prefix, so a query on it is kept', () => {
  assert.equal(
    deviceUrlIn('go to https://auth.openai.com/codex/device?code=ABCD now'),
    'https://auth.openai.com/codex/device?code=ABCD',
  );
  // A CLI that moves the path still sends a person to the login host.
  assert.equal(
    deviceUrlIn('go to https://auth.openai.com/activate'),
    'https://auth.openai.com/activate',
  );
  assert.equal(deviceUrlIn('nothing here'), null);
});

test('the one-time code is taken by shape, and prose beside it is not', () => {
  const url = 'https://auth.openai.com/codex/device';
  assert.equal(deviceCodeIn(`Visit ${url}\nand ENTER THE CODE: WXYZ-1234`, url), 'WXYZ-1234');
  assert.equal(deviceCodeIn(`Visit ${url}\nyour code is A1B2C3D4`, url), 'A1B2C3D4');
  // Nothing before the URL, since the code is printed after it.
  assert.equal(deviceCodeIn(`OPENAI CODEX\n${url}\nwaiting`, url), null);
});

test("Claude's URL is read after its label, and off the stream otherwise", () => {
  assert.equal(
    visitUrlIn('Visit: https://claude.ai/oauth/authorize?x=1\n'),
    'https://claude.ai/oauth/authorize?x=1',
  );
  assert.equal(visitUrlIn('open https://console.anthropic.com/x in a browser'), 'https://console.anthropic.com/x');
  assert.equal(visitUrlIn('press enter'), null);
});

test('a Codex auth.json is described without being verified', () => {
  const described = parseAuthDocument(authJson(1_700_000_000, 'person@example.com'));
  assert.equal(described?.account, 'person@example.com');
  assert.equal(described?.expiresAt, 1_700_000_000_000);
  assert.equal(described?.lastRefresh, Date.parse('2026-09-12T10:00:00Z'));

  // Neither a signature nor a claim set anybody recognises is required, and
  // anything that is not a document at all is refused.
  assert.equal(parseAuthDocument('{"tokens":{"access_token":"not-a-jwt"}}')?.expiresAt, null);
  assert.equal(parseAuthDocument('not json'), null);
  assert.equal(parseAuthDocument('{"tokens":{}}'), null);
});
