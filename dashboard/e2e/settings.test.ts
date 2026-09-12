import { afterAll, afterEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { closeBrowser, openPage, shoot } from './browser.ts';
import {
  startStubOrchestrator,
  stubHarness,
  stubSession,
  type StubOrchestrator,
} from './stub-orchestrator.ts';

/**
 * The settings page in a real browser.
 *
 * What is worth proving here is the one-way rule: a secret goes in and what
 * comes back is four characters and a status, with the value itself never
 * reaching the page again. The rest is a round trip — what is saved is what
 * the next load shows.
 */

const DIST = resolve(import.meta.dirname, '../dist');

let stub: StubOrchestrator;

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the settings page renders in ${scheme}`, async () => {
    stub = await startStubOrchestrator(DIST, [stubSession()]);
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
  stub = await startStubOrchestrator(DIST, [stubSession()]);
  stub.state.harnesses = [stubHarness({ credential: null, runnable: false })];
  stub.state.credentials = [];

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
    expect(stub.state.credentials.map((c) => [c.id, c.account])).toEqual([['claude', '9876']]);

    // And the warning the session list was showing goes with it.
    const list = await openPage(stub.url, '/');
    try {
      await expect.poll(() => list.page.getByText('refactor auth').isVisible()).toBe(true);
      expect(await list.page.getByText(/No credential is set/).count()).toBe(0);
    } finally {
      await list.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a stored credential can be removed, and the warning comes back', async () => {
  stub = await startStubOrchestrator(DIST, [stubSession()]);
  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await expect.poll(() => page.getByText(/Ends 1234/).isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.getByRole('button', { name: 'Remove', exact: true }).last().click();

    await expect.poll(() => page.getByText('Not set.').first().isVisible()).toBe(true);
    expect(stub.state.credentials).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the git identity round-trips through the deployment', async () => {
  stub = await startStubOrchestrator(DIST, [stubSession()]);
  const { page, errors, close } = await openPage(stub.url, '/settings');
  try {
    await expect.poll(() => page.getByLabel('Name').inputValue()).toBe('boxes-bot');

    await page.getByLabel('Name').fill('Release bot');
    await page.getByLabel('Email').fill('bot@example.com');
    await page.getByRole('button', { name: 'Save identity' }).click();

    // The button says so once there is nothing left to save, which is the
    // only confirmation this page gives.
    await expect.poll(() => page.getByRole('button', { name: 'Saved' }).isVisible()).toBe(true);
    expect(stub.state.settings.gitName).toBe('Release bot');
    expect(stub.state.settings.gitEmail).toBe('bot@example.com');

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
  stub = await startStubOrchestrator(DIST, [stubSession()]);
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect.poll(() => page.getByText('Git identity').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
