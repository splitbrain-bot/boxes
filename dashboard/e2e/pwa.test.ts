import { afterAll, beforeAll, expect, test } from 'vitest';
import { closeBrowser, getBrowser, launchProfile } from './browser.ts';
import { startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/**
 * Browser tests for installing the dashboard as an app.
 *
 * The deployment sits behind a stand-in authenticating proxy, because only
 * there does it matter how the page fetches its manifest.
 */

/** The cookie the stand-in proxy checks. */
const COOKIE = 'boxes_proxy_session';

let stub: TestOrchestrator;

beforeAll(async () => {
  stub = await startOrchestrator();
  stub.state.requireCookie = COOKIE;
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

test('Chrome will install the app from behind an authenticating proxy', async () => {
  const { context, close } = await launchProfile();
  try {
    // Signed in, so the proxy answers every request that carries the cookie.
    await context.addCookies([{ name: COOKIE, value: 'signed-in', url: stub.url }]);
    const page = await context.newPage();
    const manifestStatus: number[] = [];
    page.on('response', (res) => {
      if (res.url().endsWith('/manifest.webmanifest')) manifestStatus.push(res.status());
    });
    await page.goto(stub.url, { waitUntil: 'networkidle' });

    // A browser fetches the manifest without credentials unless the link asks
    // for them. A 302 to the login page here breaks the install alone.
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

    // The same check decides whether Chrome offers the install.
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors).toEqual([]);
  } finally {
    await close();
  }
});

test('iOS is told to install even where the manifest never arrives', async () => {
  // Safari installs without a manifest, and an icon that opens a tab gets no
  // Push API. The meta tags are in the page itself, so no fetch can fail.
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
  // Like an iPhone in a tab, which has no Push API until the app is installed.
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
