import { afterAll, afterEach, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startOrchestrator, type BoxSpec, type TestOrchestrator } from './orchestrator.ts';

/**
 * Browser tests for the new-thread dialog and the new-box form.
 *
 * A dialog that shows the right modes and posts others starts the wrong
 * agent, so the tests check the request body the orchestrator received.
 */

/** The box the tests drive. */
const ID = 'a1b2c3d4';

let stub: TestOrchestrator;

/** Starts a deployment with a credential and a catalogue for both agents. */
async function twoHarnesses(boxes: BoxSpec[] = [{}]): Promise<void> {
  stub = await startOrchestrator(boxes);
  stub.state.openaiCredential = 'ok';
  stub.state.catalogued = ['claude', 'codex'];
}

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

test('the new-thread dialog posts the agent, mode and model it was set to', async () => {
  await twoHarnesses();
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('button', { name: 'New thread' }).click();

    // Choosing the second agent swaps in its modes, models and efforts.
    await expect.poll(() => page.getByRole('button', { name: 'Codex' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Codex' }).click();

    const mode = page.getByLabel('Agent mode');
    await expect.poll(() => mode.inputValue()).toBe('agent-full-access');
    // The adapter cannot know whether this container lets its sandbox start.
    expect(await mode.locator('option').allTextContents()).toEqual([
      'Ask for approval (may be unavailable here)',
      'Approve for me (may be unavailable here)',
      'Full access',
    ]);

    await mode.selectOption('read-only');
    await expect
      .poll(() => page.getByText('May be unavailable in this deployment.').isVisible())
      .toBe(true);
    await page.getByLabel('Model').selectOption('gpt-5.6');
    await page.getByLabel('Reasoning effort').selectOption('high');

    await page.getByRole('button', { name: 'Start thread' }).click();

    await expect.poll(() => stub.threadCalls.length).toBe(1);
    expect(stub.threadCalls[0]).toEqual({
      boxId: ID,
      body: {
        options: {
          harness: 'codex',
          modeId: 'read-only',
          config: { model: 'gpt-5.6', reasoning_effort: 'high' },
        },
      },
    });

    // And the thread it made is the one the browser lands in.
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the new-box form creates the box and its first thread in one request', async () => {
  await twoHarnesses();
  const { page, errors, close } = await openPage(stub.url, '/new');
  try {
    await page.getByLabel('Name').fill('second box');
    await expect.poll(() => page.getByRole('button', { name: 'Codex' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Codex' }).click();
    await page.getByLabel('Model').selectOption('gpt-5.6');

    await page.getByRole('button', { name: 'Create' }).click();

    // One request makes the box and its first thread on the chosen agent.
    await expect.poll(() => stub.boxCalls.length).toBe(1);
    expect(stub.boxCalls[0]).toEqual({
      name: 'second box',
      agentSet: null,
      thread: {
        harness: 'codex',
        modeId: 'agent-full-access',
        config: { model: 'gpt-5.6' },
      },
    });
    expect(stub.threadCalls).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an agent with no credential is offered greyed out, with the reason', async () => {
  await twoHarnesses();
  stub.state.openaiCredential = null;

  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('button', { name: 'New thread' }).click();
    const dialog = page.getByRole('dialog');

    // A list that dropped the agent would look like a deployment without it.
    const codex = dialog.getByRole('button', { name: 'Codex' });
    await expect.poll(() => codex.isVisible()).toBe(true);
    expect(await codex.isDisabled()).toBe(true);
    await expect.poll(() => codex.textContent()).toContain('no credential');

    // And a link to where the credential is entered.
    await expect
      .poll(() =>
        dialog
          .getByText('Codex cannot run a turn until a working credential is entered.')
          .isVisible(),
      )
      .toBe(true);
    expect(await dialog.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/settings',
    );

    // The one that can run is the one it opened on.
    expect(await dialog.getByRole('button', { name: 'Claude Code' }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a deployment that has never run an agent offers the agent choice alone', async () => {
  stub = await startOrchestrator();
  // No adapter has answered here, so there is no catalogue to offer.
  stub.state.catalogued = [];

  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('button', { name: 'New thread' }).click();
    const dialog = page.getByRole('dialog');
    await expect.poll(() => dialog.getByRole('button', { name: 'Claude Code' }).isVisible()).toBe(
      true,
    );
    expect(await dialog.getByLabel('Agent mode').count()).toBe(0);
    expect(await dialog.getByLabel('Model').count()).toBe(0);
    await expect.poll(() => dialog.getByText('has not run here yet').isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Start thread' }).click();

    // Started on the registry's defaults.
    await expect.poll(() => stub.threadCalls.length).toBe(1);
    expect(stub.threadCalls[0]?.body).toEqual({
      options: { harness: 'claude', config: { model: 'opus' } },
    });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the dialog opens on what the last one chose, from the deployment', async () => {
  await twoHarnesses();
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('button', { name: 'New thread' }).click();
    await expect.poll(() => page.getByLabel('Agent mode').isVisible()).toBe(true);
    await page.getByLabel('Agent mode').selectOption('plan');
    await page.getByLabel('Model').selectOption('sonnet');
    await page.getByRole('button', { name: 'Start thread' }).click();

    // Stored in the deployment per harness, so any device opens on it.
    await expect.poll(async () => (await stub.settings()).dialogs['claude']).toEqual({
      modeId: 'plan',
      // No effort: nobody changed it, and the registry has no default for it.
      config: { model: 'sonnet' },
    });

    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    // The back control appears once the thread is connected.
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await page.getByLabel('Back to boxes').click();
    await page.getByRole('button', { name: 'New thread' }).click();

    await expect.poll(() => page.getByLabel('Agent mode').inputValue()).toBe('plan');
    expect(await page.getByLabel('Model').inputValue()).toBe('sonnet');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a thread says which agent runs it, on its row and in its header', async () => {
  await twoHarnesses([{ threads: [{}, { id: 'th2', harness: 'codex' }] }]);

  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    const second = page.getByRole('link', { name: 'Thread 2' });
    await expect.poll(() => second.isVisible()).toBe(true);
    await expect.poll(() => second.getByText('Codex').isVisible()).toBe(true);
    await expect
      .poll(() => page.getByRole('link', { name: 'Thread 1' }).getByText('Claude Code').isVisible())
      .toBe(true);

    await second.click();
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('· Codex').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the new-thread dialog renders in ${scheme}`, async () => {
    await twoHarnesses();
    const { page, errors, close } = await openPage(stub.url, '/', scheme);
    try {
      await page.getByRole('button', { name: 'New thread' }).click();
      await expect.poll(() => page.getByRole('dialog').isVisible()).toBe(true);
      await expect.poll(() => page.getByLabel('Agent mode').isVisible()).toBe(true);
      await shoot(page, `new-thread-${scheme}`, 'viewport');
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`the new-box form renders its agent block in ${scheme}`, async () => {
    await twoHarnesses();
    const { page, errors, close } = await openPage(stub.url, '/new', scheme);
    try {
      await expect.poll(() => page.getByRole('button', { name: 'Codex' }).isVisible()).toBe(true);
      await expect.poll(() => page.getByLabel('Agent mode').isVisible()).toBe(true);
      await shoot(page, `create-agent-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}
