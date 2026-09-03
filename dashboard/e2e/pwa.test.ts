import { afterAll, beforeAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { closeBrowser, getBrowser, launchProfile } from './browser.ts';
import { startStubOrchestrator, type StubOrchestrator } from './stub-orchestrator.ts';

/**
 * Installing the dashboard: what a browser has to be able to fetch, and read,
 * before it will offer to.
 *
 * This is asked of the built bundle in a real Chromium because none of it is
 * visible from the source. The manifest is correct either way; whether the
 * browser ever gets to read it depends on how the page asks for it, and the
 * answer only differs in the deployment shape the README requires — an
 * authenticating reverse proxy in front of an orchestrator that has no auth
 * of its own. So the stub is put behind one here.
 */

const DIST = resolve(import.meta.dirname, '../dist');

/** What the proxy in front of this deployment is imagined to check. */
const COOKIE = 'boxes_proxy_session';

let stub: StubOrchestrator;

beforeAll(async () => {
  stub = await startStubOrchestrator(DIST);
  stub.state.requireCookie = COOKIE;
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

test('Chrome will install the app from behind an authenticating proxy', async () => {
  const { context, close } = await launchProfile();
  try {
    // Signed in, the way the browser would be by the time anybody thinks
    // about installing: every request the page makes is answered.
    await context.addCookies([{ name: COOKIE, value: 'signed-in', url: stub.url }]);
    const page = await context.newPage();
    const manifestStatus: number[] = [];
    page.on('response', (res) => {
      if (res.url().endsWith('/manifest.webmanifest')) manifestStatus.push(res.status());
    });
    await page.goto(stub.url, { waitUntil: 'networkidle' });

    // The fetch itself, which is the one that goes out without credentials
    // unless the link says otherwise. A 302 to the login page here is the
    // whole bug: everything else on the page still loads.
    expect(manifestStatus).toEqual([200]);

    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(manifest.data).toBeTruthy();
    expect(JSON.parse(manifest.data ?? '{}')).toMatchObject({
      short_name: 'Boxes',
      display: 'standalone',
      start_url: '/',
    });

    // And the verdict, from the same check that decides whether the browser
    // offers the install at all.
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors).toEqual([]);
  } finally {
    await close();
  }
});

test('iOS is told to install even where the manifest never arrives', async () => {
  // Safari offers Add to Home Screen whether or not it read a manifest, and
  // an installed icon that opens a browser tab has the Push API of a browser
  // tab — which is to say none. These say standalone where nothing can fail
  // to fetch them, and name the app before the title starts tracking threads.
  const { context, close } = await launchProfile();
  try {
    await context.addCookies([{ name: COOKIE, value: 'signed-in', url: stub.url }]);
    const page = await context.newPage();
    await page.goto(stub.url, { waitUntil: 'networkidle' });
    const meta = (name: string) =>
      page.locator(`meta[name="${name}"]`).getAttribute('content', { timeout: 5_000 });
    expect(await meta('apple-mobile-web-app-capable')).toBe('yes');
    expect(await meta('apple-mobile-web-app-title')).toBe('Boxes');
  } finally {
    await close();
  }
});

test('the service worker registers on a browser that cannot subscribe', async () => {
  // An iPhone in a tab, which is the browser the install matters most to: no
  // Push API until it has one. Registering the worker only where push already
  // works would leave it out of exactly that case, and out of every browser
  // whose user has declined notifications.
  const context = await (await getBrowser()).newContext();
  try {
    await context.addCookies([{ name: COOKIE, value: 'signed-in', url: stub.url }]);
    await context.addInitScript(() => {
      // @ts-expect-error deleting a browser global is the point
      delete window.PushManager;
    });
    const page = await context.newPage();
    await page.goto(stub.url, { waitUntil: 'networkidle' });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const registrations = await navigator.serviceWorker.getRegistrations();
          return registrations.map((r) => r.scope);
        }),
      )
      .toEqual([`${stub.url}/`]);
  } finally {
    await context.close();
  }
});
