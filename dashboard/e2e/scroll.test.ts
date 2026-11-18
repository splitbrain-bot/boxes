/**
 * Browser tests for the scroll position of a thread: the reader's own scrolls, and the thread following its output.
 */

import { afterAll, afterEach, expect, test } from 'vitest';
import type { ThreadUpdate } from '../src/stores/thread/acp-types.ts';
import { closeBrowser, getBrowser, VIEWPORTS } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';
import type { GatewayScript } from './stub-gateway.ts';

/** The orchestrator of the running test. */
let stub: TestOrchestrator;

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

/**
 * Opens the default thread on a phone with touch, and fills it with exchanges taller than the screen.
 *
 * @param script The fields of the gateway script that replace the defaults.
 * @returns The page, the CDP session that sends touch input, and a function that closes the context.
 */
async function openLongThread(script?: Partial<GatewayScript>) {
  stub = await startOrchestrator([{}], script);
  const context = await (await getBrowser()).newContext({
    viewport: VIEWPORTS.phone,
    hasTouch: true,
    isMobile: true,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  await page.goto(`${stub.url}/boxes/${DEFAULT_BOX.id}/threads/${DEFAULT_BOX.threadId}`);
  await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
  for (let i = 0; i < 12; i++) {
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      messageId: `u${i}`,
      content: { type: 'text', text: `question ${i}` },
    } as ThreadUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      messageId: `a${i}`,
      content: { type: 'text', text: `answer ${i}\n\n${'Some long text. '.repeat(60)}` },
    } as ThreadUpdate);
  }
  await expect.poll(() => page.getByText('answer 11').isVisible()).toBe(true);
  return { page, cdp: await context.newCDPSession(page), close: () => context.close() };
}

/**
 * The number of pixels of the thread below the fold.
 *
 * @param page The page.
 * @returns The distance to the bottom.
 */
function behind(page: Awaited<ReturnType<typeof openLongThread>>['page']): Promise<number> {
  return page
    .locator('[data-slot="aui_thread-viewport"]')
    .evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
}

test('a slow short swipe up on a phone stays where the reader put it', async () => {
  const { page, cdp, close } = await openLongThread();
  try {
    /**
     * Drags one finger from `fromY` to `toY` in small steps. A finger that moves down scrolls the thread up.
     *
     * @param fromY The start of the drag.
     * @param toY The end of the drag.
     * @param gap The time between two steps, in milliseconds.
     */
    const swipe = async (fromY: number, toY: number, gap: number): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 200, y: fromY }],
      });
      for (let i = 1; i <= 14; i++) {
        const y = fromY + ((toY - fromY) * i) / 14;
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: 200, y }],
        });
        await page.waitForTimeout(gap);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    // Up and down again, so the header goes away at the bottom.
    await swipe(300, 700, 16);
    for (let i = 0; i < 3; i++) await swipe(700, 200, 16);
    const shelf = page.locator('[data-slot="shelf"]');
    await expect.poll(() => shelf.evaluate((el) => el.hasAttribute('data-away'))).toBe(true);
    await expect.poll(() => behind(page)).toBeLessThanOrEqual(1);

    // The swipe brings the header back, which makes the viewport shorter. The thread stays off the bottom.
    await swipe(400, 470, 30);
    await expect.poll(() => shelf.evaluate((el) => el.hasAttribute('data-away'))).toBe(false);
    await page.waitForTimeout(800);
    expect(await behind(page)).toBeGreaterThan(30);
  } finally {
    await close();
  }
});

test('an answer that outgrows the screen keeps its newest output in view', async () => {
  const { page, close } = await openLongThread({
    prompts: [
      {
        match: () => true,
        gapMs: 80,
        updates: Array.from(
          { length: 40 },
          (_, i) =>
            ({
              sessionUpdate: 'agent_message_chunk',
              messageId: 'long',
              content: { type: 'text', text: `Line ${i} of the long answer.\n\n` },
            }) as ThreadUpdate,
        ),
      },
    ],
  });
  try {
    const input = page.getByLabel('Message input');
    await input.fill('tell me a lot');
    await input.press('Control+Enter');
    await expect.poll(() => page.getByText('Line 39 of the long answer.').isVisible()).toBe(true);
    expect(await behind(page)).toBeLessThanOrEqual(8);
  } finally {
    await close();
  }
});

test('output that arrives outside a turn follows the bottom', async () => {
  const { page, close } = await openLongThread();
  try {
    await expect.poll(() => behind(page)).toBeLessThanOrEqual(1);
    for (let i = 0; i < 6; i++) {
      stub.gateway.emit({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'late',
        content: { type: 'text', text: `Late line ${i}. ${'More text. '.repeat(30)}\n\n` },
      } as ThreadUpdate);
      await page.waitForTimeout(100);
    }
    await expect
      .poll(() => page.getByText('Late line 5.', { exact: false }).isVisible())
      .toBe(true);
    expect(await behind(page)).toBeLessThanOrEqual(8);
  } finally {
    await close();
  }
});
