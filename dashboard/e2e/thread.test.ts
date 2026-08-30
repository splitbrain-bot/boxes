import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { SessionUpdate } from '../src/stores/thread/acp-types.ts';
import { closeBrowser, openPage } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';
import type { GatewayScript } from './stub-gateway.ts';

/**
 * The live thread against a stub gateway speaking the agent side of ACP.
 *
 * Everything asserted here is protocol behaviour, not a private arrangement:
 * the stub answers session/new, session/load, session/prompt and
 * session/cancel the way the real gateway does.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const SESSION = stubSession();

/** A streamed assistant reply, in the chunks an adapter would send it. */
function reply(...texts: string[]): SessionUpdate[] {
  return texts.map(
    (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as SessionUpdate,
  );
}

let stub: StubOrchestrator;

/** Starts a stub with the given gateway behaviour. */
async function start(script?: Partial<GatewayScript>): Promise<void> {
  stub = await startStubOrchestrator(DIST, [SESSION], script);
}

beforeEach(() => {
  stub = undefined as unknown as StubOrchestrator;
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

test('a prompt streams back and renders as it arrives', async () => {
  await start({
    prompts: [
      {
        match: (t) => t.includes('summarise'),
        gapMs: 120,
        updates: reply('The proxy ', '**vets** every ', 'resolved address.'),
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const input = page.getByLabel('Message input');
    await input.fill('summarise the proxy');
    await input.press('Enter');

    // The first chunk shows before the last has been sent, which is what
    // progressive rendering means.
    await expect.poll(() => page.getByText('The proxy').isVisible()).toBe(true);
    expect(stub.gateway.prompts).toEqual(['summarise the proxy']);

    await expect
      .poll(() => page.getByText('resolved address.', { exact: false }).isVisible(), {
        timeout: 5000,
      })
      .toBe(true);
    // Markdown, not literal asterisks.
    expect(await page.locator('strong', { hasText: 'vets' }).count()).toBe(1);

    // The prompt itself is in the thread too.
    expect(await page.getByText('summarise the proxy').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('reloading mid-conversation replays the whole thread', async () => {
  await start({
    prompts: [{ match: () => true, updates: reply('First answer.') }],
  });

  const first = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => first.page.getByText('connected').isVisible()).toBe(true);
    const input = first.page.getByLabel('Message input');
    await input.fill('question one');
    await input.press('Enter');
    await expect.poll(() => first.page.getByText('First answer.').isVisible()).toBe(true);
  } finally {
    await first.close();
  }

  // A fresh browser gets the same thread back, because session/load replays
  // it as notifications.
  const second = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => second.page.getByText('First answer.').isVisible()).toBe(true);
    expect(await second.page.getByText('question one').isVisible()).toBe(true);
    // Replayed once, not twice.
    expect(await second.page.getByText('First answer.').count()).toBe(1);
    expect(second.errors).toEqual([]);
  } finally {
    await second.close();
  }
});

test('a second tab sees updates live', async () => {
  await start({
    prompts: [{ match: () => true, updates: reply('Shared answer.') }],
  });

  const a = await openPage(stub.url, `/sessions/${SESSION.id}`);
  const b = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => a.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => b.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => stub.gateway.attached()).toBe(2);

    const input = a.page.getByLabel('Message input');
    await input.fill('ask once');
    await input.press('Enter');

    // The gateway broadcasts every update to every attached browser.
    await expect.poll(() => a.page.getByText('Shared answer.').isVisible()).toBe(true);
    await expect
      .poll(() => b.page.getByText('Shared answer.').isVisible(), { timeout: 5000 })
      .toBe(true);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test('cancelling stops the run state', async () => {
  await start({
    prompts: [
      { match: () => true, updates: reply('Working on it…'), hold: true },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('take your time');
    await input.press('Enter');

    // While the turn runs the composer offers a stop instead of a send.
    const cancel = page.getByLabel('Stop generating');
    await expect.poll(() => cancel.isVisible()).toBe(true);

    await cancel.click();
    await expect.poll(() => cancel.isVisible()).toBe(false);
    expect(await page.getByLabel('Send message').isVisible()).toBe(true);

    stub.gateway.release();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the thread sits inside the dashboard chrome rather than over it', async () => {
  await start({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The header is the dashboard's, and the thread must not cover it: the
    // back link, the mode switcher and the info link all have to be
    // clickable, not painted over by a floating panel.
    const header = (await page.locator('header').boundingBox())!;
    const thread = (await page.locator('.aui-thread-root').boundingBox())!;
    expect(header.height).toBeGreaterThan(0);
    expect(thread.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(await page.getByLabel('Back to sessions').isVisible()).toBe(true);
    expect(await page.getByLabel('Session details and controls').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an update the dashboard does not know about does not break the thread', async () => {
  await start({
    prompts: [
      {
        match: () => true,
        updates: [
          { sessionUpdate: 'usage_update', tokens: 42 } as unknown as SessionUpdate,
          ...reply('Still fine.'),
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('anything');
    await input.press('Enter');
    await expect.poll(() => page.getByText('Still fine.').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
