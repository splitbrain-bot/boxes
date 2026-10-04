import { afterAll, beforeAll, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/** Browser tests for the box list, the forms and the box views. */

let stub: TestOrchestrator;

beforeAll(async () => {
  stub = await startOrchestrator([
    { threads: [{ lastActiveAt: Date.now() - 3 * 60_000 }], diskBytes: 348 * 1024 ** 2 },
    {
      id: 'e5f6a7b8',
      name: 'flaky CI',
      status: 'stopped',
      containerRunning: false,
      // Idle for a fortnight and small, the other end of both ranges from the box above.
      threads: [{ pendingCount: 2, lastActiveAt: Date.now() - 14 * 86_400_000 }],
      diskBytes: 4_200_000,
    },
    {
      id: '99887766',
      name: 'nightly bench',
      // One thread with a build still running, and one the agent is talking on.
      // Each thread row shows which one keeps the box awake.
      threads: [
        { turnActive: true, backgroundBusy: true, lastActiveAt: Date.now() - 12_000 },
        { title: 'flaky retry logic', speaking: true, lastActiveAt: Date.now() - 5 * 3_600_000 },
      ],
      attachedCount: 1,
      diskBytes: 2.4 * 1024 ** 3,
    },
  ]);
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`box list renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/', scheme);
    try {
      await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('2 approvals').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('thinking').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('1 job').isVisible()).toBe(true);
      // The thread that is running it, said in a dot and readable as words.
      await expect
        .poll(() => page.getByRole('img', { name: 'jobs' }).isVisible())
        .toBe(true);
      // Time since each thread was active, and disk use per box. The seconds
      // are matched by shape, because the clock moves while the page loads.
      await expect.poll(() => page.getByText(/^\d+s$/).isVisible()).toBe(true);
      await expect.poll(() => page.getByText('5h', { exact: true }).isVisible()).toBe(true);
      await expect.poll(() => page.getByText('14d', { exact: true }).isVisible()).toBe(true);
      await expect.poll(() => page.getByText('348 MB').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('4.0 MB').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('2.4 GB').isVisible()).toBe(true);
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

  test(`box info renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/boxes/a1b2c3d4/info', scheme);
    try {
      await expect.poll(() => page.getByText('Details').isVisible()).toBe(true);
      await expect
        .poll(() => page.getByText('348 MB', { exact: true }).isVisible())
        .toBe(true);
      await shoot(page, `info-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}

test('a deep link into the SPA is served by the index fallback', async () => {
  const { page, errors, close } = await openPage(stub.url, '/boxes/a1b2c3d4/info');
  try {
    await expect.poll(() => page.getByText('Details').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('tapping a card opens nothing, and tapping a thread opens that thread', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    // The card is not a link: a box has no thread it would open on its own.
    await page.getByText('refactor auth').click();
    expect(new URL(page.url()).pathname).toBe('/');

    await page.locator('a[href="/boxes/a1b2c3d4/threads/th1"]').click();
    await page.waitForURL('**/boxes/a1b2c3d4/threads/th1');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the info corner opens the ops route instead', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByLabel('Details and controls for refactor auth').click();
    await page.waitForURL('**/boxes/a1b2c3d4/info');
    expect(new URL(page.url()).pathname).toBe('/boxes/a1b2c3d4/info');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a link to a box that is gone says so instead of offering a composer', async () => {
  const { page, errors, close } = await openPage(stub.url, '/boxes/deadbeef/threads/th1');
  try {
    // Nothing can connect without the box's token, so a composer would be useless.
    await expect.poll(() => page.getByText('Back to boxes').isVisible()).toBe(true);
    expect(await page.getByRole('textbox', { name: 'Message input' }).isVisible()).toBe(false);
    await expect.poll(() => page.getByText('disconnected').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the box list says which build of each image is running', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    // The digest abbreviated as Docker abbreviates an id, the build time and
    // the size. The time is matched by shape, because it is in local time.
    await expect
      .poll(() =>
        page
          .getByText(/^orchestrator 1a2b3c4d5e6f · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 400 MB$/)
          .isVisible(),
      )
      .toBe(true);
    const proxy = page.getByText(/^proxy 9f8e7d6c5b4a · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 180 MB$/);
    await expect.poll(() => proxy.isVisible()).toBe(true);
    // In gigabytes.
    await expect.poll(() => page.getByText(/^box 001122334455 · .* · 4.2 GB$/).isVisible())
      .toBe(true);
    // The whole digest shows on hover, for pasting into a comparison.
    expect(await proxy.getAttribute('title')).toBe(
      'sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
    );
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a box busy with work no conversation claims offers to stop all of it', async () => {
  // The box is busy, but no thread has a task, so no thread bar can stop the
  // work. After an adapter respawn, every build the old adapter left looks like this.
  stub.createBox({
    id: 'orphan01',
    name: 'orphaned build',
    backgroundBusy: true,
    threads: [{ backgroundBusy: false }],
    boxWork: [
      { pid: 2180, command: 'bash -c eval npm run build', elapsedSeconds: 16_741 },
      { pid: 2184, command: 'james -config conf/james.yaml', elapsedSeconds: 16_741 },
    ],
  });
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    const stop = page.getByRole('button', { name: 'Stop everything running in this box' });
    await expect.poll(() => stop.isVisible()).toBe(true);

    // Confirmed first, because it kills work nobody is watching.
    await stop.click();
    // The confirmation lists the processes with their age, because no other
    // place in the dashboard names them.
    await expect
      .poll(() => page.getByText('james -config conf/james.yaml').isVisible())
      .toBe(true);
    expect(await page.getByText('4h 39m').count()).toBe(2);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => stub.boxStops).toEqual(['orphan01']);

    // The offer goes once the next reading finds the box idle.
    await expect.poll(() => stop.isVisible()).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a box whose own conversation is running the work offers no box-wide kill', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    // The first thread of 'nightly bench' claims the work, so its own bar
    // stops it through the adapter.
    await expect.poll(() => page.getByText('nightly bench').isVisible()).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Stop everything running in this box' }).count(),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a box that shares a web app shows it on its card and its info view', async () => {
  const url = 'https://kfb7sp43-3000.uks1.devtunnels.ms/';
  stub.createBox({
    id: 'shared01',
    name: 'shared app',
    tunnels: [{ id: 'kfb7sp43', cluster: 'uks1', port: 3000, url }],
  });
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByText('1 tunnel', { exact: true }).isVisible()).toBe(true);

    await page.goto(`${stub.url}/boxes/shared01/info`);
    await expect.poll(() => page.getByText('Shared web apps').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('Port 3000').isVisible()).toBe(true);
    expect(await page.getByRole('link', { name: url }).getAttribute('href')).toBe(url);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the info view lists what the box is running, whoever left it there', async () => {
  // The card lists the work only inside the kill confirmation. The info view
  // shows it without one.
  stub.createBox({
    id: 'orphan02',
    name: 'leaked server',
    backgroundBusy: true,
    threads: [{ backgroundBusy: false }],
    boxWork: [{ pid: 2184, command: 'james -config conf/james.yaml', elapsedSeconds: 16_741 }],
  });
  const { page, errors, close } = await openPage(stub.url, '/boxes/orphan02/info');
  try {
    await expect.poll(() => page.getByText('Running in the box').isVisible()).toBe(true);
    await expect
      .poll(() => page.getByText('james -config conf/james.yaml').isVisible())
      .toBe(true);
    await expect.poll(() => page.getByText('4h 39m').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the box list offers to notify this browser', async () => {
  const { page, errors, close } = await openPage(stub.url, '/', 'dark');
  try {
    // A browser that can subscribe is offered the choice rather than
    // subscribed for it: the permission prompt has to come from a click.
    const toggle = page.getByRole('button', { name: 'Notify me' });
    await expect.poll(() => toggle.isVisible()).toBe(true);
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- the lifecycle ----------------------------------------------------------

test('a box is created from the form and is on the list afterwards', async () => {
  const { page, errors, close } = await openPage(stub.url, '/new');
  try {
    await page.getByLabel('Name').fill('a brand new box');
    await page.getByRole('button', { name: 'Create' }).click();

    // Straight into the new box's thread.
    await page.waitForURL(/\/boxes\/[0-9a-f]{8}\/threads\/[^/]+$/);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await page.getByLabel('Back to boxes').click();
    await expect.poll(() => page.getByText('a brand new box').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a stopped box is started from its info view, and stopped again', async () => {
  const { page, errors, close } = await openPage(stub.url, '/boxes/e5f6a7b8/info');
  try {
    // The fixture left this box stopped.
    await expect.poll(() => page.getByText('stopped').isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: 'Start' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Start' }).click();

    // The view is redrawn from the box the orchestrator returns.
    await expect.poll(() => page.getByRole('button', { name: 'Stop' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByText('up', { exact: true }).isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => page.getByRole('button', { name: 'Start' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByText('stopped').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
