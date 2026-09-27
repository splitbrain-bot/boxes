import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** The Chromium the whole e2e run shares, launched on first use. */
let browser: Browser | null = null;

/** The Chromium binary CHROMIUM_PATH names. It overrides every other choice. */
const NAMED_CHROMIUM = process.env['CHROMIUM_PATH'];

/** The Chromium binary the box image ships. Launching it needs no download. */
const IMAGE_CHROMIUM = '/usr/local/bin/chromium';

/**
 * Playwright default flags removed from every launch.
 *
 * `--disable-dev-shm-usage` moves Chromium's shared memory to TMPDIR. In a box
 * TMPDIR lies on the home directory, which is on disk. The orchestrator gives
 * a box container a 512 MB `/dev/shm` instead. Playwright adds the flag by
 * itself, so leaving it out of `args` does not remove it.
 */
const IGNORED_DEFAULT_ARGS = ['--disable-dev-shm-usage'];

/**
 * Picks the Chromium to launch.
 *
 * CHROMIUM_PATH comes first and is not checked, so a wrong path fails with its
 * name. Next comes the build this Playwright pins, if it is installed. Last
 * comes the box image's Chromium.
 *
 * Every choice is a full Chromium, never the default headless shell. The
 * headless shell reports `Notification.permission` as `denied` for good, and
 * the push toggle then reads the browser as one that can never subscribe.
 */
function chromiumToLaunch(): LaunchOptions {
  if (NAMED_CHROMIUM) return { executablePath: NAMED_CHROMIUM };
  // Returns the path whether or not the browser is installed.
  if (existsSync(chromium.executablePath())) return { channel: 'chromium' };
  if (existsSync(IMAGE_CHROMIUM)) return { executablePath: IMAGE_CHROMIUM };
  // Lets Playwright fail with its own error, which names the install command.
  return { channel: 'chromium' };
}

/** Launches Chromium once and reuses it for the whole run. */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      ...chromiumToLaunch(),
    });
  }
  return browser;
}

/**
 * Launches a Chromium with a profile directory of its own, deleted on close.
 *
 * Chrome offers to install an app only outside incognito, and every context
 * from `newContext()` is incognito. The caller gets the context rather than a
 * page, so it can set cookies before the first navigation.
 */
export async function launchProfile(): Promise<{
  context: BrowserContext;
  close: () => Promise<void>;
}> {
  const profile = mkdtempSync(resolve(tmpdir(), 'boxes-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    viewport: VIEWPORTS.phone,
    colorScheme: 'dark',
    ...chromiumToLaunch(),
  });
  return {
    context,
    close: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Closes the shared Chromium, if one was launched. */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/** Where screenshots land. People review them by eye; no test compares them. */
const SHOT_DIR = resolve(import.meta.dirname, 'screenshots');

/**
 * The two viewports the dashboard is built for.
 *
 * Phone is the default because people drive Boxes from a phone. Desktop covers
 * the views that change their layout above the `md` breakpoint.
 */
export const VIEWPORTS = {
  phone: { width: 430, height: 900 },
  desktop: { width: 1280, height: 900 },
} as const;

/** Opens a page in the given colour scheme and viewport, and collects its errors. */
export async function openPage(
  base: string,
  path: string,
  scheme: 'light' | 'dark' = 'dark',
  viewport: keyof typeof VIEWPORTS = 'phone',
): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await (
    await getBrowser()
  ).newContext({ colorScheme: scheme, viewport: VIEWPORTS[viewport] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (msg) => {
    // Chromium logs every failed response, and several tests provoke a 404 or
    // 409 on purpose. A real fault still arrives as a page error or its own message.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:')) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  return { page, errors, close: () => context.close() };
}

/**
 * Saves a screenshot under e2e/screenshots and returns its path.
 *
 * `area` is the full page by default. Use `viewport` for a sheet or dialog
 * that is fixed to the viewport, because a full-page capture misplaces it.
 */
export async function shoot(
  page: Page,
  name: string,
  area: 'page' | 'viewport' = 'page',
): Promise<string> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const path = resolve(SHOT_DIR, `${name}.png`);
  // A sheet that slides in is still off-screen when it first counts as visible.
  await page.screenshot({ path, fullPage: area === 'page', animations: 'disabled' });
  return path;
}
