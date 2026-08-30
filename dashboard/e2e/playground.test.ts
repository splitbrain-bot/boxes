import { afterAll, beforeAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startStubOrchestrator, type StubOrchestrator } from './stub-orchestrator.ts';

/**
 * The installed assistant-ui components, rendered over the canned store.
 *
 * This is the milestone's acceptance and the standing regression for a
 * registry re-run: every part kind draws, in both schemes, with nothing
 * unstyled and nothing on the console.
 */

const DIST = resolve(import.meta.dirname, '../dist');

let stub: StubOrchestrator;

beforeAll(async () => {
  stub = await startStubOrchestrator(DIST);
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the thread renders every part kind in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/playground', scheme);
    try {
      // The composer, and the assistant's markdown.
      await expect.poll(() => page.getByLabel('Message input').isVisible()).toBe(true);
      expect(await page.getByText('security boundary').first().isVisible()).toBe(true);

      // Markdown: the bold run, the code fence and the table all became real
      // elements rather than literal backticks and pipes.
      expect(await page.locator('strong', { hasText: 'security boundary' }).count()).toBe(1);
      expect(await page.locator('pre code').count()).toBeGreaterThan(0);
      expect(await page.locator('table').count()).toBe(1);

      // Tool calls arrive collapsed, which is the point of the group: the
      // output is there to open, not in the way.
      const groups = page.locator('[data-slot="tool-group-trigger"]');
      await expect.poll(() => groups.count()).toBe(2);
      await shoot(page, `playground-${scheme}`);

      await groups.first().click();

      // Opening the group reveals the call; opening the call reveals its
      // arguments and its output. Both levels are the point of requirement 5.
      const call = page.locator('[data-slot="tool-fallback-trigger"]');
      await expect.poll(() => call.count()).toBe(1);
      await call.first().click();
      await expect
        .poll(() => page.locator('[data-slot="tool-fallback-result"]').isVisible())
        .toBe(true);
      expect(await page.getByText('cidr.test.ts', { exact: false }).first().isVisible()).toBe(true);
      expect(await page.getByText('ls -1 proxy/src', { exact: false }).first().isVisible()).toBe(
        true,
      );
      await shoot(page, `playground-tool-open-${scheme}`);

      // The user's prompt and the reasoning part sit at the top of the thread.
      await page.getByText('Summarise what').first().scrollIntoViewIfNeeded();
      expect(await page.getByText('Summarise what').first().isVisible()).toBe(true);
      const reasoning = page.locator('[data-slot="reasoning-trigger"], .aui-reasoning-trigger');
      await expect.poll(() => reasoning.count()).toBeGreaterThan(0);
      await reasoning.first().click();
      await expect.poll(() => page.getByText('DNS-rebinding guard').isVisible()).toBe(true);
      await shoot(page, `playground-top-${scheme}`);

      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}

test('the components are styled by our own Tailwind build', async () => {
  const { page, close } = await openPage(stub.url, '/playground');
  try {
    const root = page.locator('.aui-thread-root');
    await expect.poll(() => root.count()).toBe(1);

    // bg-background is a utility the component carries and our @theme bridge
    // defines. No background here means the bridge is gone and every other
    // token utility went with it.
    const style = await root.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, position: cs.position };
    });
    expect(style.bg).not.toBe('rgba(0, 0, 0, 0)');

    // The thread lays out in the flow of whatever embeds it. @assistant-ui/
    // styles positioned .aui-root fixed, which floated the thread over the
    // dashboard's own chrome; nothing may reintroduce that.
    expect(style.position).toBe('static');
  } finally {
    await close();
  }
});
