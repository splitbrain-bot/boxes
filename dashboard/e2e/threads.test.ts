import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { SessionUpdate } from '../src/stores/thread/acp-types.ts';
import { closeBrowser, openPage } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';

/**
 * Several conversations on one session.
 *
 * A session shares its container and both volumes across its threads, so the
 * difference between them is the transcript and nothing else. What is asserted
 * here is that difference: a fresh thread starts empty, a fork starts from
 * what the source had, and going back to a thread brings its own transcript
 * back.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const ID = 'a1b2c3d4';

/** A streamed assistant reply, in the chunks an adapter would send it. */
function reply(...texts: string[]): SessionUpdate[] {
  return texts.map(
    (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as SessionUpdate,
  );
}

let stub: StubOrchestrator;

beforeEach(async () => {
  stub = await startStubOrchestrator(DIST, [stubSession()], {
    prompts: [{ match: () => true, updates: reply('First answer.') }],
  });
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

/** Opens the session, asks one question, and waits for the answer. */
async function askOnce(page: import('playwright').Page): Promise<void> {
  await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
  const input = page.getByLabel('Message input');
  await input.fill('question one');
  await input.press('Enter');
  await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
}

test('a new thread starts empty on the same session', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('button', { name: 'New thread' }).click();
    await page.waitForURL(`**/sessions/${ID}`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The second thread has a transcript of its own, which is empty.
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(0);
    expect(await page.getByText('question one').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a fork carries the source thread messages into the new one', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('button', { name: 'Fork' }).click();
    await page.waitForURL(`**/sessions/${ID}`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // A branch of the first conversation, not a copy of the session: the
    // replay comes back on a thread of its own.
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('switching back to the first thread returns its transcript', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('button', { name: 'New thread' }).click();
    await page.waitForURL(`**/sessions/${ID}`);
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(0);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('button', { name: 'Thread 1' }).click();
    await page.waitForURL(`**/sessions/${ID}`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The first thread was left where it was, and comes back whole.
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    expect(await page.getByText('question one').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('forking is not offered when the adapter does not advertise it', async () => {
  await stub.close();
  stub = await startStubOrchestrator(DIST, [stubSession({ canFork: false })]);

  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByRole('button', { name: 'New thread' }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole('button', { name: 'Fork' }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
