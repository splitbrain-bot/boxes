import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/**
 * The settings page in a real browser.
 *
 * What is worth proving here is the one-way rule: a secret goes in and what
 * comes back is four characters and a status, with the value itself never
 * reaching the page again. The rest is a round trip — what is saved is what
 * the next load shows.
 */

let stub: TestOrchestrator;

beforeEach(async () => {
  stub = await startOrchestrator();
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the settings page renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/settings', scheme);
    try {
      await expect.poll(() => page.getByText('Git identity').isVisible()).toBe(true);
      await expect.poll(() => page.getByRole('heading', { name: 'GitHub' }).isVisible()).toBe(true);
      await shoot(page, `settings-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}

test('a pasted credential is stored and comes back as its last four characters', async () => {
  stub.state.claudeCredential = null;

  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await expect.poll(() => page.getByText('Not set.').first().isVisible()).toBe(true);

    await page.getByLabel('Claude secret').fill('sk-ant-oat01-pastedtoken9876');
    await page.getByRole('button', { name: 'Save' }).first().click();

    await expect.poll(() => page.getByText(/Ends 9876/).isVisible()).toBe(true);
    // The secret is write-only: the field is cleared, and nothing on the page
    // carries the value that was typed.
    await expect.poll(() => page.getByLabel('Claude secret').inputValue()).toBe('');
    expect(await page.content()).not.toContain('sk-ant-oat01-pastedtoken9876');
    // Stored as the deployment sees it, without the secret.
    expect((await stub.credentials()).find((c) => c.id === 'claude')?.account).toBe('9876');

    // And the warning the session list was showing goes with it.
    const list = await openPage(stub.url, '/');
    try {
      await expect.poll(() => list.page.getByText('refactor auth').isVisible()).toBe(true);
      expect(await list.page.getByText(/No credential is set for Claude Code/).count()).toBe(0);
    } finally {
      await list.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a stored credential can be removed, and the warning comes back', async () => {
  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await expect.poll(() => page.getByText(/Ends 1234/).isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click();

    await expect.poll(() => page.getByText('Not set.').first().isVisible()).toBe(true);
    expect((await stub.credentials()).map((c) => c.id)).toEqual(['openai']);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the git identity round-trips through the deployment', async () => {
  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await expect.poll(() => page.getByLabel('Name').inputValue()).toBe('boxes-bot');

    await page.getByLabel('Name').fill('Release bot');
    await page.getByLabel('Email').fill('bot@example.com');
    await page.getByRole('button', { name: 'Save identity' }).click();

    // The button says so once there is nothing left to save, which is the
    // only confirmation this page gives.
    await expect.poll(() => page.getByRole('button', { name: 'Saved' }).isVisible()).toBe(true);
    const saved = await stub.settings();
    expect(saved.gitName).toBe('Release bot');
    expect(saved.gitEmail).toBe('bot@example.com');

    // And it is what the next load shows, rather than only what this one holds.
    const again = await openPage(stub.url, '/settings');
    try {
      await expect.poll(() => again.page.getByLabel('Name').inputValue()).toBe('Release bot');
    } finally {
      await again.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the session list links to the settings page', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect.poll(() => page.getByText('Git identity').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

/**
 * The two login flows, over the real login manager and a scripted CLI.
 *
 * What is worth proving is that the page follows a flow it does not drive:
 * the orchestrator runs the harness's own CLI in a container, and all the
 * browser has is a state per poll. Codex prints a URL and a code and finishes
 * by itself; Claude prints a URL and blocks until the code is pasted back.
 */

test('a Codex login shows the URL and the code, and the account arrives with it', async () => {
  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await page.getByRole('button', { name: 'Log in to OpenAI' }).click();
    await expect.poll(() => stub.logins.length).toBe(1);
    stub.logins[0]!.print('Open https://auth.openai.com/codex/device and enter WDJB-MJHT\n');

    // What the CLI printed: a link to open somewhere else — often on another
    // device — and the one-time code to type into it.
    await expect
      .poll(() => page.getByText('https://auth.openai.com/codex/device').isVisible())
      .toBe(true);
    await expect.poll(() => page.getByText('WDJB-MJHT').isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/Open this link and enter the code/).isVisible())
      .toBe(true);
    expect(stub.logins.map((l) => l.id)).toEqual(['openai']);

    // The CLI finishes on its own, and the page notices on its next poll:
    // the flow goes, and the row it wrote takes its place.
    stub.logins[0]!.exit(0);
    await expect.poll(() => page.getByText(/Signed in as agent@example.com/).isVisible())
      .toBe(true);
    await expect.poll(() => page.getByText('WDJB-MJHT').isVisible()).toBe(false);
    expect((await stub.credentials()).map((c) => [c.id, c.method])).toEqual([
      ['claude', 'token'],
      ['openai', 'oauth'],
    ]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a Claude login takes the code back and stores what the CLI printed', async () => {
  stub.state.claudeCredential = null;

  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await page.getByRole('button', { name: 'Log in to Claude' }).click();
    await expect.poll(() => stub.logins.length).toBe(1);
    const cli = stub.logins[0]!;
    cli.print('Visit: https://claude.ai/oauth/code\nPaste code here if prompted > ');

    await expect.poll(() => page.getByText('https://claude.ai/oauth/code').isVisible()).toBe(true);
    const field = page.getByLabel('Claude login code');
    await expect.poll(() => field.isVisible()).toBe(true);

    await field.fill('AB12-CD34');
    await page.getByRole('button', { name: 'Send code' }).click();

    // Which is what the CLI was blocked on: it goes to the login, and the
    // flow carries on from there.
    await expect.poll(() => cli.input).toBe('AB12-CD34\n');
    cli.print('\nYour token: sk-ant-oat01-minted-by-the-cli-9f2c\n');
    // A setup-token names no account, so the credential is known by its last
    // four characters like any other paste — and never by its value.
    await expect.poll(() => page.getByText(/Ends 9f2c/).isVisible()).toBe(true);
    expect(await page.content()).not.toContain('AB12-CD34');
    expect(await page.content()).not.toContain('minted-by-the-cli');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a login that fails says why, and can be started again', async () => {
  stub.state.claudeCredential = null;

  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await page.getByRole('button', { name: 'Log in to Claude' }).click();
    await expect.poll(() => stub.logins.length).toBe(1);
    // The CLI gives up before it prints a token, which is what a login that
    // timed out or was refused looks like from here.
    stub.logins[0]!.print('Visit: https://claude.ai/oauth/code\nSomething went wrong.\n');
    stub.logins[0]!.exit(1);
    await expect
      .poll(() => page.getByText(/printed no token before it ended/).isVisible())
      .toBe(true);
    // Nothing was stored, so the card still says what is missing.
    expect((await stub.credentials()).map((c) => c.id)).toEqual(['openai']);

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => stub.logins.length).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a login can be given up on, and the container goes with it', async () => {
  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await page.getByRole('button', { name: 'Log in to OpenAI' }).click();
    await expect.poll(() => stub.logins.length).toBe(1);
    stub.logins[0]!.print('Open https://auth.openai.com/codex/device and enter WDJB-MJHT\n');
    await expect.poll(() => page.getByText('WDJB-MJHT').isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Cancel' }).click();

    // Said to the orchestrator rather than only closed here: the login is
    // holding a container of its own.
    await expect.poll(() => stub.logins[0]?.cancelled).toBe(true);
    await expect.poll(() => page.getByText('WDJB-MJHT').isVisible()).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the login states render in ${scheme}`, async () => {
    stub.state.claudeCredential = null;
    const { page, errors, close } = await openPage(stub.url, '/settings', scheme);
    try {
      // The flow that shows a code, and the flow that asks for one: the two
      // shapes a login takes, both under the credential they belong to.
      await page.getByRole('button', { name: 'Log in to OpenAI' }).click();
      await expect.poll(() => stub.logins.length).toBe(1);
      stub.logins[0]!.print('Open https://auth.openai.com/codex/device and enter WDJB-MJHT\n');
      await expect.poll(() => page.getByText('WDJB-MJHT').isVisible()).toBe(true);
      await shoot(page, `settings-login-${scheme}`);

      // Starting another takes the first down, which is the one-at-a-time
      // rule seen from the page.
      await page.getByRole('button', { name: 'Log in to Claude' }).click();
      await expect.poll(() => stub.logins.length).toBe(2);
      stub.logins[1]!.print('Visit: https://claude.ai/oauth/code\nPaste code here if prompted > ');
      await expect.poll(() => page.getByLabel('Claude login code').isVisible()).toBe(true);
      expect(await page.getByText('WDJB-MJHT').count()).toBe(0);
      await shoot(page, `settings-login-code-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}
