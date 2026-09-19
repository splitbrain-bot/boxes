import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { closeBrowser, openPage } from './browser.ts';
import { DEFAULT_SESSION, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';
import { reply } from './stub-gateway.ts';

/**
 * A shell in the box, over a real browser, a real WebSocket and the real
 * orchestrator.
 *
 * Docker is the only stand-in, and behind it is a pty that echoes and answers
 * — which is the whole contract this end has. What is asserted is that the
 * bytes make the round trip, that the page is reachable from the thread it
 * belongs to, and that the box is let go of when the terminal is closed.
 *
 * This is the fourth of the six complaints that forced the frontend decision;
 * the other five are asserted in ux.test.ts.
 */

const ID = DEFAULT_SESSION.id;

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

// 4 — a command runs in the box without going through the agent.
test('a terminal opens on the box and carries what is typed both ways', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}/terminal`);
  try {
    // The prompt is the pty's first bytes, so seeing it means the socket, the
    // exec and the emulator are all wired together.
    await expect.poll(() => screen(page)).toContain('agent@box');

    await page.locator('.xterm-helper-textarea').fill('');
    await page.keyboard.type('echo hi');
    // The echo comes back from the pty rather than from the emulator, which
    // is what says the keystrokes reached the box.
    await expect.poll(() => screen(page)).toContain('echo hi');

    await page.keyboard.press('Enter');
    await expect.poll(() => screen(page)).toContain('ran: echo hi');

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the terminal is opened from the thread and steps back to it', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await page.getByLabel('Open a terminal in this box').click();
    await page.waitForURL(`**/sessions/${ID}/terminal`);
    await expect.poll(() => screen(page)).toContain('agent@box');

    // Back is one step out, and it lands on the conversation rather than
    // pushing a second copy of it.
    await page.getByLabel('Back to the thread').click();
    await page.waitForURL(`**/sessions/${ID}`);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the terminal is opened from the session list', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByRole('link', { name: 'Terminal' }).click();
    await page.waitForURL(`**/sessions/${ID}/terminal`);
    await expect.poll(() => screen(page)).toContain('agent@box');

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a terminal holds the box, and closing the page lets it go', async () => {
  // The reaper reads this count, so it is what stands between a build running
  // in a terminal and the container being stopped under it.
  const { page, close } = await openPage(stub.url, `/sessions/${ID}/terminal`);
  try {
    await expect.poll(() => screen(page)).toContain('agent@box');
    expect(stub.terminalsOpen(ID)).toBe(1);
  } finally {
    await close();
  }
  await expect.poll(() => stub.terminalsOpen(ID)).toBe(0);
});
