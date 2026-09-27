import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { closeBrowser, openPage } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';
import { reply } from './stub-gateway.ts';

/**
 * Browser tests for several threads on one box.
 *
 * A box's threads share its container, workspace and home, so only their
 * transcripts differ.
 */

/** The box the tests drive. */
const ID = DEFAULT_BOX.id;

/** The `text-decoration-line` the browser computed for one element. */
function decoration(target: import('playwright').Locator): Promise<string> {
  return target.evaluate((el) => getComputedStyle(el).textDecorationLine);
}

let stub: TestOrchestrator;

beforeEach(async () => {
  stub = await startOrchestrator([{}], {
    prompts: [{ match: () => true, updates: reply('First answer.') }],
  });
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

/** Starts a fresh thread from the list, with the dialog's defaults. */
async function startThread(page: import('playwright').Page): Promise<void> {
  await page.getByRole('button', { name: 'New thread' }).click();
  await page.getByRole('button', { name: 'Start thread' }).click();
}

/** Waits for the connection, asks one question, and waits for the answer. */
async function askOnce(page: import('playwright').Page): Promise<void> {
  await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
  const input = page.getByLabel('Message input');
  await input.fill('question one');
  await input.press('Control+Enter');
  await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
}

test('a new thread starts empty on the same box', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to boxes').click();
    await startThread(page);
    // Each thread has its own route.
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
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
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await askOnce(page);

    await page.getByLabel('Fork this thread').click();
    await expect
      .poll(() => page.getByRole('link', { name: 'Open it in a new tab' }).isVisible())
      .toBe(true);
    await page.getByLabel('Back to boxes').click();
    await page.getByRole('link', { name: 'Thread 2' }).click();
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The fork replays the first thread's messages on a thread of its own.
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('switching back to the first thread returns its transcript', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to boxes').click();
    await startThread(page);
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(0);

    await page.getByLabel('Back to boxes').click();
    await page.getByRole('link', { name: 'Thread 1' }).click();
    await page.waitForURL(`**/boxes/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('question one').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the thread names itself even when the box has only one', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    // Without the name, two tabs on one box look the same.
    await expect.poll(() => page.getByText('Thread 1').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a fork from inside the thread leaves it where it is and offers a new tab', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await askOnce(page);

    await page.getByLabel('Fork this thread').click();

    // The link is revealed rather than followed: a window.open after the
    // await is what popup blockers exist to stop.
    const link = page.getByRole('link', { name: 'Open it in a new tab' });
    await expect.poll(() => link.isVisible()).toBe(true);
    expect(await link.getAttribute('href')).toBe(`/boxes/${ID}/threads/th2`);
    expect(await link.getAttribute('target')).toBe('_blank');

    // This thread keeps its route, transcript and connection.
    expect(page.url()).toContain(`/boxes/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('two tabs on two threads each keep to their own conversation', async () => {
  await stub.close();
  // A prompt that stays open, because a busy thread is the one people fork.
  stub = await startOrchestrator([{}], {
    prompts: [
      { match: (t: string) => t === 'the long job', updates: reply('Working on it.'), hold: true },
      { match: () => true, updates: reply('A quick answer.') },
    ],
  });

  const working = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await expect.poll(() => working.page.getByText('connected').isVisible()).toBe(true);
    const first = working.page.getByLabel('Message input');
    await first.fill('the long job');
    await first.press('Control+Enter');
    await expect.poll(() => working.page.getByText('Working on it.').isVisible()).toBe(true);

    // Fork it and open the fork in its own tab.
    await working.page.getByLabel('Fork this thread').click();
    await expect.poll(() =>
      working.page.getByRole('link', { name: 'Open it in a new tab' }).isVisible(),
    ).toBe(true);

    const exploring = await openPage(stub.url, `/boxes/${ID}/threads/th2`);
    try {
      await expect.poll(() => exploring.page.getByText('connected').isVisible()).toBe(true);
      // Both sockets are up at once, on two threads of one box.
      await expect.poll(() => stub.gateway.attached()).toBe(2);

      // The fork carries what the original had said so far, and its composer
      // is usable while the original's turn is still open.
      await expect.poll(() => exploring.page.getByText('Working on it.').isVisible()).toBe(true);
      const second = exploring.page.getByLabel('Message input');
      await second.fill('what are you doing?');
      await second.press('Control+Enter');
      await expect.poll(() => exploring.page.getByText('A quick answer.').isVisible()).toBe(true);

      // None of that reached the thread that is still working.
      expect(await working.page.getByText('A quick answer.').count()).toBe(0);
      expect(await working.page.getByText('what are you doing?').count()).toBe(0);
      expect(working.errors).toEqual([]);
      expect(exploring.errors).toEqual([]);
    } finally {
      stub.gateway.release();
      await exploring.close();
    }
  } finally {
    await working.close();
  }
});

test('forking is not offered when the adapter does not advertise it', async () => {
  await stub.close();
  stub = await startOrchestrator([{ canFork: false }]);

  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    expect(await page.getByLabel('Fork this thread').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('marking a thread done crosses it out on the list, and the mark comes off again', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await page.getByLabel('Mark this thread done').click();
    // The same button, now saying what it would undo.
    await expect.poll(() => page.getByLabel('Mark this thread not done').isVisible()).toBe(true);

    await page.getByLabel('Back to boxes').click();
    const name = page.getByRole('link', { name: 'Thread 1' }).getByText('Thread 1');
    await expect.poll(() => name.isVisible()).toBe(true);
    await expect.poll(() => decoration(name)).toBe('line-through');

    // The row is still a link into the thread, which still connects.
    await name.click();
    await page.waitForURL(`**/boxes/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await page.getByLabel('Mark this thread not done').click();
    await expect.poll(() => page.getByLabel('Mark this thread done').isVisible()).toBe(true);

    await page.getByLabel('Back to boxes').click();
    await expect.poll(() => name.isVisible()).toBe(true);
    await expect.poll(() => decoration(name)).toBe('none');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
