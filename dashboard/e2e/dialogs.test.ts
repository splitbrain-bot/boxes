import { afterAll, afterEach, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startOrchestrator, type SessionSpec, type TestOrchestrator } from './orchestrator.ts';

/**
 * The two dialogs that start a conversation, driven in a real browser.
 *
 * What is worth proving here is that the answer reaches the orchestrator: a
 * picker that shows the right modes and then posts somebody else's is a
 * dialog that silently starts the wrong agent, and a box is not a thing you
 * re-run. So every test below ends at the request body the stub recorded.
 *
 * The rest is what the plan asks the dialogs to be honest about — an agent
 * whose credential is missing is shown and greyed rather than dropped, a
 * deployment that has never run an agent offers the choice alone, and the
 * last answer comes back next time from wherever it was given.
 */

const ID = 'a1b2c3d4';

let stub: TestOrchestrator;

/**
 * A deployment running both agents, which is what the dialogs are for: a
 * credential for each, and each adapter's catalogue for the dialog to read.
 */
async function twoHarnesses(sessions: SessionSpec[] = [{}]): Promise<void> {
  stub = await startOrchestrator(sessions);
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

    // The second agent is offered by name rather than by id, and choosing it
    // swaps the whole block: its modes, its models, its efforts.
    await expect.poll(() => page.getByRole('button', { name: 'Codex' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Codex' }).click();

    const mode = page.getByLabel('Agent mode');
    await expect.poll(() => mode.inputValue()).toBe('agent-full-access');
    // What each mode does, in the adapter's own words — and the one thing the
    // adapter cannot know, which is whether this container will let its
    // sandbox start at all.
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
      sessionId: ID,
      body: {
        options: {
          harness: 'codex',
          modeId: 'read-only',
          config: { model: 'gpt-5.6', reasoning_effort: 'high' },
        },
      },
    });

    // And the thread it made is the one the browser lands in.
    await page.waitForURL(`**/sessions/${ID}/threads/th2`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the new-session form creates the box and its first thread in one request', async () => {
  await twoHarnesses();
  const { page, errors, close } = await openPage(stub.url, '/new');
  try {
    await page.getByLabel('Name').fill('second box');
    await expect.poll(() => page.getByRole('button', { name: 'Codex' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Codex' }).click();
    await page.getByLabel('Model').selectOption('gpt-5.6');

    await page.getByRole('button', { name: 'Create' }).click();

    // One request: a box is made to be worked in, so it is made with a
    // conversation in it, on the agent the same form chose.
    await expect.poll(() => stub.sessionCalls.length).toBe(1);
    expect(stub.sessionCalls[0]).toEqual({
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

    // Shown rather than dropped: a list that silently loses an agent looks
    // like a deployment that never had one.
    const codex = dialog.getByRole('button', { name: 'Codex' });
    await expect.poll(() => codex.isVisible()).toBe(true);
    expect(await codex.isDisabled()).toBe(true);
    await expect.poll(() => codex.textContent()).toContain('no credential');

    // And the way out of it, from where the reader is.
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
  // No adapter has ever answered here, so there is nothing cached to offer
  // and nothing is started to find out.
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

    // Started on the registry's defaults, which is what the block said.
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

    // Stored against the harness rather than in this browser, so the next
    // dialog opens on it from any device.
    await expect.poll(async () => (await stub.settings()).dialogs['claude']).toEqual({
      modeId: 'plan',
      // The model, because the registry has a default for it; not the
      // effort, which nobody touched — the catalogue's own value for one is
      // whatever the last thread happened to be in, which is not a default
      // to pin a new thread to.
      config: { model: 'sonnet' },
    });

    await page.waitForURL(`**/sessions/${ID}/threads/th2`);
    // The thread's own chrome arrives with its connection; the way back is
    // part of it.
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await page.getByLabel('Back to sessions').click();
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
    // The agent is a fact about the conversation, and in a box holding one of
    // each it is the difference between two rows that otherwise look alike.
    await expect.poll(() => second.getByText('Codex').isVisible()).toBe(true);
    await expect
      .poll(() => page.getByRole('link', { name: 'Thread 1' }).getByText('Claude Code').isVisible())
      .toBe(true);

    await second.click();
    await page.waitForURL(`**/sessions/${ID}/threads/th2`);
    // And it is in the header too, because it is what the settings behind the
    // button next to it mean.
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
      // The viewport rather than the page: a dialog is anchored to the
      // screen, and a full-page capture scrolls out from under it.
      await shoot(page, `new-thread-${scheme}`, 'viewport');
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`the new-session form renders its agent block in ${scheme}`, async () => {
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
