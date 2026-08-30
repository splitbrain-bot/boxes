import { afterAll, beforeAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';

/**
 * The dashboard's own routes, driven in a real browser against the real
 * production bundle served the way the orchestrator serves it.
 */

const DIST = resolve(import.meta.dirname, '../dist');

let stub: StubOrchestrator;

beforeAll(async () => {
  stub = await startStubOrchestrator(DIST, [
    stubSession(),
    stubSession({
      id: 'e5f6a7b8',
      name: 'flaky CI',
      repoUrl: null,
      status: 'stopped',
      dockerState: 'exited',
      pendingCount: 2,
      turnActive: false,
      attachedCount: 0,
    }),
    stubSession({
      id: '99887766',
      name: 'nightly bench',
      status: 'running',
      dockerState: 'running',
      turnActive: true,
      attachedCount: 1,
      proxyAttached: false,
    }),
  ]);
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`session list renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/', scheme);
    try {
      await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
      expect(await page.getByText('2 approvals waiting').isVisible()).toBe(true);
      expect(await page.getByText('running turn').isVisible()).toBe(true);
      await shoot(page, `list-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`create form renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/new', scheme);
    try {
      await expect.poll(() => page.getByLabel('Name').isVisible()).toBe(true);
      await shoot(page, `create-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`session info renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/sessions/a1b2c3d4/info', scheme);
    try {
      await expect.poll(() => page.getByText('Details').isVisible()).toBe(true);
      expect(await page.getByText('Connect an external ACP client').isVisible()).toBe(true);
      await shoot(page, `info-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}

test('a deep link into the SPA is served by the index fallback', async () => {
  const { page, errors, close } = await openPage(stub.url, '/sessions/a1b2c3d4/info');
  try {
    await expect.poll(() => page.getByText('Details').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('tapping a card opens that session thread', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByText('refactor auth').click();
    await page.waitForURL('**/sessions/a1b2c3d4');
    expect(new URL(page.url()).pathname).toBe('/sessions/a1b2c3d4');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the info corner opens the ops route instead', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByLabel('Details and controls for refactor auth').click();
    await page.waitForURL('**/sessions/a1b2c3d4/info');
    expect(new URL(page.url()).pathname).toBe('/sessions/a1b2c3d4/info');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
