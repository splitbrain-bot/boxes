import { afterAll, afterEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { SessionUpdate } from '../src/stores/thread/acp-types.ts';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';
import type { GatewayScript } from './stub-gateway.ts';

/**
 * The six complaints that forced the frontend decision, each asserted
 * against the real bundle in a real browser.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const SESSION = stubSession();

let stub: StubOrchestrator;

async function start(script?: Partial<GatewayScript>): Promise<void> {
  stub = await startStubOrchestrator(DIST, [SESSION], script);
}

/** A one-chunk assistant reply. */
function reply(text: string): SessionUpdate[] {
  return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as SessionUpdate];
}

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

// 2 — ArrowUp recalls previous messages.
test('ArrowUp walks back through what was sent, ArrowDown returns', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('ok') }] });
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');

    for (const text of ['first prompt', 'second prompt']) {
      await input.fill(text);
      await input.press('Enter');
      await expect.poll(() => input.inputValue()).toBe('');
    }

    await input.press('ArrowUp');
    await expect.poll(() => input.inputValue()).toBe('second prompt');
    await input.press('ArrowUp');
    await expect.poll(() => input.inputValue()).toBe('first prompt');
    await input.press('ArrowDown');
    await expect.poll(() => input.inputValue()).toBe('second prompt');
    await input.press('ArrowDown');
    await expect.poll(() => input.inputValue()).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// 3 — the composer keeps focus.
test('the composer is focused on arrival and stays focused after a send', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('done') }] });
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const focusedLabel = (): Promise<string | null> =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    await expect.poll(focusedLabel).toBe('Message input');

    const input = page.getByLabel('Message input');
    await input.fill('anything');
    await input.press('Enter');
    await expect.poll(() => page.getByText('done').isVisible()).toBe(true);
    await expect.poll(focusedLabel).toBe('Message input');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a send that fails still leaves the composer focused', async () => {
  // No prompt script and a gateway that answers, but the store reports the
  // failure through the error banner; either way the caret must not be lost.
  await start({ prompts: [] });
  const { page, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('goes nowhere');
    await input.press('Enter');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null))
      .toBe('Message input');
  } finally {
    await close();
  }
});

// 4 and 5 — !bang runs locally, and its output is visible.
test('a !bang command runs in the container and never reaches the agent', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('should not happen') }] });
  stub.execOutput = (command) => ({ output: `ran: ${command}\nhi\n`, exitCode: 0 });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('!echo hi');
    await input.press('Enter');

    // It went to the exec endpoint, not to the adapter.
    await expect.poll(() => stub.execCalls.length).toBe(1);
    expect(stub.execCalls[0]).toEqual({ sessionId: SESSION.id, command: 'echo hi' });
    expect(stub.gateway.prompts).toEqual([]);

    // It renders as a shell tool call, and its output is there to open.
    const group = page.locator('[data-slot="tool-group-trigger"]');
    await expect.poll(() => group.count()).toBe(1);
    await group.first().click();
    const call = page.locator('[data-slot="tool-fallback-trigger"]');
    await expect.poll(() => call.count()).toBe(1);
    await call.first().click();
    await expect.poll(() => page.getByText('ran: echo hi').isVisible()).toBe(true);
    expect(await page.getByText('[exit 0]').isVisible()).toBe(true);
    await shoot(page, 'bang-command');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a failing !bang command is marked failed and shows its exit code', async () => {
  await start();
  stub.execOutput = () => ({ output: 'bash: nope: command not found\n', exitCode: 127 });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('!nope');
    await input.press('Enter');

    await page.locator('[data-slot="tool-group-trigger"]').first().click();
    await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
    await expect.poll(() => page.getByText('command not found').isVisible()).toBe(true);
    expect(await page.getByText('[exit 127]').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('commands from a previous visit come back after the replay', async () => {
  await start();
  stub.execLog.push({
    id: 7,
    sessionId: SESSION.id,
    command: 'git status',
    output: 'nothing to commit\n',
    exitCode: 0,
    truncated: false,
    timedOut: false,
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 59_000,
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('!git status').isVisible()).toBe(true);
    await page.locator('[data-slot="tool-group-trigger"]').first().click();
    await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
    await expect.poll(() => page.getByText('nothing to commit').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// 5 — streamed tool output from the agent, collapsibly.
test('an agent tool call shows its streamed output collapsibly', async () => {
  await start({
    prompts: [
      {
        match: () => true,
        gapMs: 60,
        updates: [
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'a1',
            title: 'Run the proxy tests',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'npm test' },
          },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'a1',
            content: [{ type: 'content', content: { type: 'text', text: 'ok 1 - cidr' } }],
          },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'a1',
            status: 'completed',
            content: [
              { type: 'content', content: { type: 'text', text: 'ok 1 - cidr\nok 2 - subnet' } },
            ],
          },
        ] as SessionUpdate[],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('run the tests');
    await input.press('Enter');

    await page.locator('[data-slot="tool-group-trigger"]').first().click();
    await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
    await expect.poll(() => page.getByText('ok 2 - subnet').isVisible()).toBe(true);
    // The args are shown too, which is the other half of "can't see output".
    expect(await page.getByText('npm test', { exact: false }).first().isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// 6 — mode switching.
test('the mode switcher lists the advertised modes and sets one', async () => {
  await start({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'acceptEdits', name: 'Accept edits' },
        { id: 'bypassPermissions', name: 'Auto' },
      ],
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    const group = page.getByRole('radiogroup', { name: 'Agent mode' });
    await expect.poll(() => group.isVisible()).toBe(true);
    // Nothing hardcoded: whatever the adapter advertises is what appears.
    expect(await group.getByRole('radio').allInnerTexts()).toEqual([
      'Default',
      'Accept edits',
      'Auto',
    ]);
    expect(
      await group.getByRole('radio', { name: 'Default' }).getAttribute('aria-checked'),
    ).toBe('true');

    await group.getByRole('radio', { name: 'Auto' }).click();
    await expect
      .poll(() => group.getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked'))
      .toBe('true');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a current_mode_update from the adapter moves the switcher', async () => {
  await start({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    },
  });

  const { page, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    const group = page.getByRole('radiogroup', { name: 'Agent mode' });
    await expect.poll(() => group.isVisible()).toBe(true);
    stub.gateway.emit({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
    await expect
      .poll(() => group.getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked'))
      .toBe('true');
  } finally {
    await close();
  }
});

// Permissions.
test('a permission request renders its options and the choice answers the agent', async () => {
  await start({
    permissions: [
      {
        match: () => true,
        toolCall: { toolCallId: 'p1', title: 'Write to src/main.ts', kind: 'edit' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
        after: (optionId) => [
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `chose ${optionId}` },
          } as SessionUpdate,
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('edit the file');
    await input.press('Enter');

    // The question opens itself: a prompt nobody can see blocks the turn.
    const approval = page.locator('[data-slot="tool-fallback-approval"]');
    await expect.poll(() => approval.isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await approval.getByRole('button').allInnerTexts()).toEqual([
      'Allow once',
      'Always allow',
      'Reject',
    ]);
    await shoot(page, 'permission-request');

    await approval.getByRole('button', { name: 'Always allow' }).click();
    await expect.poll(() => page.getByText('chose always').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a permission request queued while nobody watched is delivered on attach', async () => {
  await start({
    queuedPermission: {
      match: () => true,
      toolCall: { toolCallId: 'q1', title: 'Delete build/', kind: 'delete' },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
      after: (optionId) => [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `queued answer: ${optionId}` },
        } as SessionUpdate,
      ],
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    const approval = page.locator('[data-slot="tool-fallback-approval"]');
    await expect.poll(() => approval.isVisible(), { timeout: 10_000 }).toBe(true);
    await approval.getByRole('button', { name: 'Reject' }).click();
    await expect.poll(() => page.getByText('queued answer: no').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
