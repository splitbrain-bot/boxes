import { chromium, type Browser, type LaunchOptions, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The one Chromium the e2e suite shares, and the helpers every test uses to
 * open a page in a known colour scheme.
 */

let browser: Browser | null = null;

/** A Chromium named outright, which is the last word on the subject. */
const NAMED_CHROMIUM = process.env['CHROMIUM_PATH'];

/**
 * Where a Boxes session image keeps the browser it ships.
 *
 * Playwright's own copy cannot be used in a session: the image points
 * PLAYWRIGHT_BROWSERS_PATH at itself, so the revision this suite's Playwright
 * resolves is a path on a read-only filesystem that nothing can download
 * into. The image links what it installed to this name for exactly this.
 */
const IMAGE_CHROMIUM = '/usr/local/bin/chromium';

/**
 * `/dev/shm` is Docker's default 64 MB in a session container, which Chromium
 * exhausts on any substantial page and reports as a closed target. Harmless
 * everywhere else, and the same reason the browser CLI's own config carries
 * it — see session-image/playwright-cli.config.json.
 */
const LAUNCH_ARGS = ['--disable-dev-shm-usage'];

/**
 * Which Chromium to launch.
 *
 * CHROMIUM_PATH first, because somebody said so, and with no check that it
 * exists: an explicit path that is wrong should say which path, not be
 * quietly ignored. Then the build this suite's own Playwright pins, when it
 * has been installed — the exactly matching one, which is what CI installs
 * and what the README's two lines put in a session's home volume. Then the
 * session image's, which is a couple of Chrome majors off and used because it
 * is there and needs no download.
 *
 * `channel: 'chromium'` rather than the default, which is the
 * chromium-headless-shell build: that one has no permission UI and so reports
 * `Notification.permission` as a permanent `denied`, which the push toggle
 * reads as a browser that can never subscribe. The suite would then be
 * asserting one thing on a machine that provides its own Chromium and
 * another on CI, which is worse than either. Both `executablePath` branches
 * name a full browser for the same reason.
 */
function chromiumToLaunch(): LaunchOptions {
  if (NAMED_CHROMIUM) return { executablePath: NAMED_CHROMIUM };
  // Never throws; it answers where the browser would be, installed or not.
  if (existsSync(chromium.executablePath())) return { channel: 'chromium' };
  if (existsSync(IMAGE_CHROMIUM)) return { executablePath: IMAGE_CHROMIUM };
  // Nothing to launch. The channel gets Playwright's own error, which names
  // the install command, rather than an ENOENT on a path this file chose.
  return { channel: 'chromium' };
}

/** Launches Chromium once and reuses it for the whole run. */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ args: LAUNCH_ARGS, ...chromiumToLaunch() });
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

/**
 * The two viewports the dashboard is built for.
 *
 * Phone is the default because Boxes is driven from one; desktop exists for the
 * views that arrange themselves differently above the `md` breakpoint, which
 * the review is the first of.
 */
export const VIEWPORTS = {
  phone: { width: 430, height: 900 },
  desktop: { width: 1280, height: 900 },
} as const;

/** Opens a page in the given colour scheme, failing the test on a console error. */
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
    // A request the app deliberately provokes and handles — a 404 for an
    // unknown file, a 409 for a session whose workspace cannot be read — logs
    // a console error in Chromium for the response itself. Handling those
    // correctly is what several tests are about, so the resource line is not a
    // page fault; a real one still arrives as a pageerror or as a message of
    // its own.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:')) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  return { page, errors, close: () => context.close() };
}

/**
 * Saves a screenshot under e2e/screenshots.
 *
 * Full page by default. `viewport` is for a shot of something anchored to the
 * viewport rather than to the document — a bottom sheet, a dialog — which a
 * full-page capture scrolls out from under.
 */
export async function shoot(
  page: Page,
  name: string,
  area: 'page' | 'viewport' = 'page',
): Promise<string> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const path = resolve(SHOT_DIR, `${name}.png`);
  // Animations finished rather than caught mid-flight: a sheet sliding in is
  // still translated off-screen when it first counts as visible, so a shot of
  // one would otherwise show an empty page.
  await page.screenshot({ path, fullPage: area === 'page', animations: 'disabled' });
  return path;
}
