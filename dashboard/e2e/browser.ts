import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The one Chromium the e2e suite shares, and the helpers every test uses to
 * open a page in a known colour scheme.
 */

let browser: Browser | null = null;

/**
 * A Chromium the environment already provides, preferred over Playwright's
 * own download so a browser build that does not match the pinned library
 * version is not a reason to fetch one.
 */
const PROVIDED_CHROMIUM = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

/** Launches Chromium once and reuses it for the whole run. */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch(
      existsSync(PROVIDED_CHROMIUM) ? { executablePath: PROVIDED_CHROMIUM } : {},
    );
  }
  return browser;
}

/** Closes the shared Chromium, if one was launched. */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/** Where screenshots land. Reviewed by eye, not compared pixel by pixel. */
const SHOT_DIR = resolve(import.meta.dirname, 'screenshots');

/** Opens a page in the given colour scheme, failing the test on a console error. */
export async function openPage(
  base: string,
  path: string,
  scheme: 'light' | 'dark' = 'dark',
): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await (
    await getBrowser()
  ).newContext({ colorScheme: scheme, viewport: { width: 430, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  return { page, errors, close: () => context.close() };
}

/** Saves a full-page screenshot under e2e/screenshots. */
export async function shoot(page: Page, name: string): Promise<string> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const path = resolve(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}
