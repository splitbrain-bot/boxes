import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type LaunchOptions,
  type Page,
} from 'playwright';

/** The Chromium the whole e2e run shares, launched on first use. */
let browser: Browser | null = null;

/** The Chromium binary that CHROMIUM_PATH names. It overrides every other choice. */
const NAMED_CHROMIUM = process.env.CHROMIUM_PATH;

/** The Chromium binary in the box image. Launching it needs no download. */
const IMAGE_CHROMIUM = '/usr/local/bin/chromium';

/**
 * Playwright default flags removed from every launch.
 *
 * `--disable-dev-shm-usage` moves the shared memory of Chromium to TMPDIR. In a box container, TMPDIR is in the home
 * directory, which is on disk. The orchestrator gives a box container a 512 MB `/dev/shm`. Playwright adds the flag
 * itself, so only `ignoreDefaultArgs` removes it.
 */
const IGNORED_DEFAULT_ARGS = ['--disable-dev-shm-usage'];

/**
 * Picks the Chromium to launch.
 *
 * CHROMIUM_PATH comes first and is not checked, so a wrong path fails with its
 * name. Next comes the build this Playwright pins, if it is installed. Last
 * comes the box image's Chromium.
 *
 * Every choice is a full Chromium. The default headless shell always reports `Notification.permission` as `denied`,
 * so the push toggle shows the "blocked" note and not the button.
 *
 * @returns The launch options that select the Chromium binary.
 */
function chromiumToLaunch(): LaunchOptions {
  if (NAMED_CHROMIUM) return { executablePath: NAMED_CHROMIUM };
  // executablePath() returns a path also when the browser is not installed.
  if (existsSync(chromium.executablePath())) return { channel: 'chromium' };
  if (existsSync(IMAGE_CHROMIUM)) return { executablePath: IMAGE_CHROMIUM };
  // Lets Playwright fail with its own error, which names the install command.
  return { channel: 'chromium' };
}

/**
 * Launches Chromium once and reuses it for the whole run.
 *
 * @returns The shared browser.
 */
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
 *
 * @returns The persistent context, and a function that closes it and deletes the profile directory.
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

/** The directory for the screenshots. People examine them. */
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

/**
 * Opens a page in the given colour scheme and viewport, and collects its errors.
 *
 * @param base The origin of the dashboard server.
 * @param path The path to open, with a leading slash.
 * @param scheme The colour scheme of the context.
 * @param viewport The key of the viewport in {@link VIEWPORTS}.
 * @returns The page, the console and page errors it collects, and a function that closes its context.
 */
export async function openPage(
  base: string,
  path: string,
  scheme: 'light' | 'dark' = 'dark',
  viewport: keyof typeof VIEWPORTS = 'phone',
): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await (await getBrowser()).newContext({
    colorScheme: scheme,
    viewport: VIEWPORTS[viewport],
  });
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
 * Selects a model in the model combobox. It types a part of the name and clicks the entry.
 *
 * @param page The page with the combobox.
 * @param typed The text to type into the combobox.
 * @param name The full name of the entry to click.
 */
export async function pickModel(page: Page, typed: string, name: string): Promise<void> {
  const input = page.getByRole('combobox', { name: 'Model' });
  await input.click();
  await input.fill(typed);
  await page
    .getByRole('listbox', { name: 'Model' })
    .getByRole('option', { name, exact: true })
    .click();
}

/**
 * Saves a screenshot under e2e/screenshots.
 *
 * @param page The page to capture.
 * @param name The file name without the `.png` extension.
 * @param area The full page, or only the viewport. Use `viewport` for a sheet or dialog that is fixed to the viewport,
 *   because a full-page capture misplaces it.
 * @returns The path of the screenshot.
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
