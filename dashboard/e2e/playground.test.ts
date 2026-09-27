import { afterAll, beforeAll, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/**
 * Browser tests for the installed assistant-ui components, rendered over
 * canned messages on the playground page.
 *
 * They catch a registry re-run that leaves a part kind unstyled or broken.
 */

let stub: TestOrchestrator;

beforeAll(async () => {
  stub = await startOrchestrator();
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
      await expect.poll(() => page.getByText('security boundary').first().isVisible()).toBe(true);

      // Markdown: the bold run, the code fence and the table became elements.
      expect(await page.locator('strong', { hasText: 'security boundary' }).count()).toBe(1);
      expect(await page.locator('pre code').count()).toBeGreaterThan(0);
      expect(await page.locator('table').count()).toBe(1);

      // Tool calls arrive collapsed.
      const groups = page.locator('[data-slot="tool-group-trigger"]');
      await expect.poll(() => groups.count()).toBe(2);
      await shoot(page, `playground-${scheme}`);

      await groups.first().click();

      // Opening the group reveals the call; opening the call reveals its
      // arguments and its output.
      const call = page.locator('[data-slot="tool-fallback-trigger"]');
      await expect.poll(() => call.count()).toBe(1);
      await call.first().click();
      await expect
        .poll(() => page.locator('[data-slot="tool-fallback-result"]').isVisible())
        .toBe(true);
      await expect.poll(() => page.getByText('cidr.test.ts', { exact: false }).first().isVisible()).toBe(true);
      await expect
        .poll(() => page.getByText('ls -1 proxy/src', { exact: false }).first().isVisible())
        .toBe(true);
      await shoot(page, `playground-tool-open-${scheme}`);

      // The user's prompt and the reasoning part sit at the top of the thread.
      await page.getByText('Summarise what').first().scrollIntoViewIfNeeded();
      await expect.poll(() => page.getByText('Summarise what').first().isVisible()).toBe(true);
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

    // The @theme bridge defines bg-background. Without a background, the
    // bridge and every other token utility are gone.
    const style = await root.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, position: cs.position };
    });
    expect(style.bg).not.toBe('rgba(0, 0, 0, 0)');

    // A fixed position, as @assistant-ui/styles sets on .aui-root, would float
    // the thread over the dashboard's own chrome.
    expect(style.position).toBe('static');
  } finally {
    await close();
  }
});
