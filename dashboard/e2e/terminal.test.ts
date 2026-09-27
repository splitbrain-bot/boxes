import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { closeBrowser, openPage } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';
import { reply } from './stub-gateway.ts';

/**
 * Browser tests for the terminal page, over a real WebSocket and the real
 * orchestrator. Only Docker is a stand-in, with a pty that echoes and answers.
 */

/** The box the tests drive. */
const ID = DEFAULT_BOX.id;

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

/** Everything the terminal has drawn, as the rows read left to right. */
function screen(page: import('playwright').Page): Promise<string> {
  return page.locator('.xterm-screen').innerText();
}

test('a terminal opens on the box and carries what is typed both ways', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/terminal`);
  try {
    // The prompt is the pty's first output, so the socket, exec and emulator work.
    await expect.poll(() => screen(page)).toContain('agent@box');

    await page.locator('.xterm-helper-textarea').fill('');
    await page.keyboard.type('echo hi');
    // The pty echoes, not the emulator, so the keystrokes reached the box.
    await expect.poll(() => screen(page)).toContain('echo hi');

    await page.keyboard.press('Enter');
    await expect.poll(() => screen(page)).toContain('ran: echo hi');

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the terminal is opened from the thread and steps back to it', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await page.getByLabel('Open a terminal in this box').click();
    await page.waitForURL(`**/boxes/${ID}/terminal`);
    await expect.poll(() => screen(page)).toContain('agent@box');

    // Back returns to the thread rather than pushing a second copy of it.
    await page.getByLabel('Back', { exact: true }).click();
    await page.waitForURL(`**/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the terminal is opened from the box list', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('link', { name: 'Terminal' }).click();
    await page.waitForURL(`**/boxes/${ID}/terminal`);
    await expect.poll(() => screen(page)).toContain('agent@box');

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a terminal holds the box, and closing the page lets it go', async () => {
  // The reaper does not stop a box while this count is above zero.
  const { page, close } = await openPage(stub.url, `/boxes/${ID}/terminal`);
  try {
    await expect.poll(() => screen(page)).toContain('agent@box');
    expect(stub.terminalsOpen(ID)).toBe(1);
  } finally {
    await close();
  }
  await expect.poll(() => stub.terminalsOpen(ID)).toBe(0);
});
