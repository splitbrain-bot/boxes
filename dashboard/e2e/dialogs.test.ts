/**
 * Browser tests for the new-thread dialog and the new-box form.
 *
 * A dialog that shows the right modes and posts others starts the wrong
 * agent, so the tests check the request body the orchestrator received.
 */

import { afterAll, afterEach, expect, test } from 'vitest';
import { closeBrowser, openPage, pickModel, shoot } from './browser.ts';
import { type BoxSpec, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/** The box the tests drive. */
const ID = 'a1b2c3d4';

/** The orchestrator of the running test. */
let stub: TestOrchestrator;

/**
 * Starts a deployment with a credential and a catalogue for both agents.
 *
 * @param boxes The boxes to create.
 */
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
    await pickModel(page, 'gpt', 'GPT-5.6');
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
    await pickModel(page, 'gpt', 'GPT-5.6');

    // Enter on the model button opens the list and does not submit the form.
    const model = page.getByRole('combobox', { name: 'Model' });
    await expect.poll(() => page.getByRole('listbox').count()).toBe(0);
    await model.press('Enter');
    await expect.poll(() => page.getByRole('listbox', { name: 'Model' }).isVisible()).toBe(true);
    expect(stub.boxCalls).toEqual([]);
    await page.getByRole('textbox', { name: 'Filter' }).press('Escape');

    await page.getByRole('button', { name: 'Create' }).click();

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
    // opencode has models that need no key, so it can run without any credential.
    expect(await dialog.getByRole('button', { name: 'opencode' }).isEnabled()).toBe(true);

    // The one that can run is the one it opened on.
    expect(
      await dialog.getByRole('button', { name: 'Claude Code' }).getAttribute('aria-pressed'),
    ).toBe('true');
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
    await expect
      .poll(() => dialog.getByRole('button', { name: 'Claude Code' }).isVisible())
      .toBe(true);
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
    await pickModel(page, 'son', 'Sonnet');
    await page.getByRole('button', { name: 'Start thread' }).click();

    // Stored in the deployment per harness, so any device opens on it.
    await expect
      .poll(async () => (await stub.settings()).dialogs.claude)
      .toEqual({
        modeId: 'plan',
        // No effort, because nobody changed it and the registry has no default for it.
        config: { model: 'sonnet' },
      });

    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await page.getByLabel('Back to boxes').click();
    await page.getByRole('button', { name: 'New thread' }).click();

    await expect.poll(() => page.getByLabel('Agent mode').inputValue()).toBe('plan');
    expect(await page.getByRole('combobox', { name: 'Model' }).textContent()).toBe('Sonnet');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the model combobox filters a long list and takes only an entry of it', async () => {
  await twoHarnesses();
  stub.state.catalogued = ['claude', 'codex', 'opencode'];

  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('button', { name: 'New thread' }).click();
    const dialog = page.getByRole('dialog');
    await expect
      .poll(() => dialog.getByRole('button', { name: 'opencode' }).isEnabled())
      .toBe(true);
    await dialog.getByRole('button', { name: 'opencode' }).click();

    const model = dialog.getByRole('combobox', { name: 'Model' });
    const filter = page.getByRole('textbox', { name: 'Filter' });
    const options = page.getByRole('listbox', { name: 'Model' }).getByRole('option');
    await expect.poll(() => model.textContent()).toBe('OpenCode Zen/Big Pickle');

    // The list opens with each model and the focus in the filter. The typed words filter the list.
    await model.click();
    await expect.poll(() => options.count()).toBe(303);
    await expect.poll(() => filter.evaluate((el) => el === document.activeElement)).toBe(true);
    // The list opens at the selected model, which is the last entry.
    await expect
      .poll(() => page.getByRole('listbox', { name: 'Model' }).evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await filter.fill('sonnet');
    expect(await options.allInnerTexts()).toEqual(['OpenRouter/Claude Sonnet 4.5']);

    // The arrow keys move through the matches, and Enter selects one.
    await filter.fill('model-12');
    await expect.poll(() => options.count()).toBe(11);
    await filter.press('ArrowDown');
    await filter.press('ArrowDown');
    await filter.press('ArrowUp');
    await filter.press('Enter');
    await expect.poll(() => model.textContent()).toBe('OpenRouter/Vendor 12 Model 120');
    await expect.poll(() => page.getByRole('listbox').count()).toBe(0);

    // Escape closes the list and keeps the model, and the dialog stays open.
    await model.click();
    await filter.fill('gpt');
    await expect.poll(() => options.count()).toBe(1);
    await filter.press('Escape');
    await expect.poll(() => page.getByRole('listbox').count()).toBe(0);
    expect(await dialog.isVisible()).toBe(true);
    expect(await model.textContent()).toBe('OpenRouter/Vendor 12 Model 120');

    // Text that names no model changes nothing, also with Enter.
    await model.click();
    await filter.fill('no such model');
    await expect.poll(() => page.getByText('No match').isVisible()).toBe(true);
    await filter.press('Enter');
    await dialog.getByText('New thread').first().click();
    await expect.poll(() => page.getByRole('listbox').count()).toBe(0);
    expect(await model.textContent()).toBe('OpenRouter/Vendor 12 Model 120');

    await page.getByRole('button', { name: 'Start thread' }).click();
    await expect.poll(() => stub.threadCalls.length).toBe(1);
    expect(stub.threadCalls[0]?.body).toEqual({
      options: {
        harness: 'opencode',
        modeId: 'build',
        config: { model: 'openrouter/vendor-12/model-120' },
      },
    });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the dialog shows the efforts of the selected model', async () => {
  await twoHarnesses();
  stub.state.catalogued = ['claude', 'codex', 'opencode'];

  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('button', { name: 'New thread' }).click();
    const dialog = page.getByRole('dialog');
    await expect
      .poll(() => dialog.getByRole('button', { name: 'opencode' }).isEnabled())
      .toBe(true);
    await dialog.getByRole('button', { name: 'opencode' }).click();
    const model = dialog.getByRole('combobox', { name: 'Model' });
    await expect.poll(() => model.inputValue()).toBe('OpenCode Zen/Big Pickle');
    const effort = dialog.getByLabel('Effort');
    expect(await effort.count()).toBe(0);

    // A model that ran before shows its efforts.
    await pickModel(page, 'sonnet', 'OpenRouter/Claude Sonnet 4.5');
    await expect.poll(() => effort.count()).toBe(1);
    expect(await effort.locator('option').allTextContents()).toEqual(['High', 'Max', 'Default']);
    await effort.selectOption('max');

    // A model that never ran shows no efforts.
    await pickModel(page, 'model-120', 'OpenRouter/Vendor 12 Model 120');
    await expect.poll(() => effort.count()).toBe(0);
    await pickModel(page, 'sonnet', 'OpenRouter/Claude Sonnet 4.5');

    await page.getByRole('button', { name: 'Start thread' }).click();
    await expect.poll(() => stub.threadCalls.length).toBe(1);
    expect(stub.threadCalls[0]?.body).toEqual({
      options: {
        harness: 'opencode',
        modeId: 'build',
        config: { model: 'openrouter/anthropic/claude-sonnet-4.5', effort: 'max' },
      },
    });
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
