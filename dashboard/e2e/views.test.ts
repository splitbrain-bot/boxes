import { afterAll, beforeAll, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/**
 * The dashboard's own routes, driven in a real browser against the real
 * production bundle, served by the real orchestrator.
 */

let stub: TestOrchestrator;

beforeAll(async () => {
  stub = await startOrchestrator([
    { threads: [{ lastActiveAt: Date.now() - 3 * 60_000 }], diskBytes: 348 * 1024 ** 2 },
    {
      id: 'e5f6a7b8',
      name: 'flaky CI',
      status: 'stopped',
      containerRunning: false,
      // A box left alone for a fortnight, and one small enough to be a
      // checkout and nothing else: the two rough indicators at the other end
      // of their ranges from the box above.
      threads: [{ pendingCount: 2, lastActiveAt: Date.now() - 14 * 86_400_000 }],
      diskBytes: 4_200_000,
    },
    {
      id: '99887766',
      name: 'nightly bench',
      // Which of its conversations is doing what is the row's own bullet,
      // and the only place a list says which thread is holding the box awake:
      // one with a build still running in it, and one the agent is talking
      // on, which is what the box's own badge goes by.
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
      await expect.poll(() => page.getByText('2 approvals waiting').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('running turn').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('still running').isVisible()).toBe(true);
      // The thread that is running it, said in a dot and readable as words.
      await expect
        .poll(() => page.getByRole('img', { name: 'something still running' }).isVisible())
        .toBe(true);
      // How long since each conversation did anything, and how much disk each
      // box has taken: the two rough indicators, in the units the numbers
      // above land in.
      // Seconds, by shape rather than by value: the clock keeps moving while
      // the page loads, and which second it lands on is not the point.
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
        .poll(() => page.getByText('348 MB of workspace and home').isVisible())
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
    // What a bookmark for a deleted box lands on. Nothing can connect without
    // the box's token, so a composer would be an invitation to type into
    // a void.
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
    // The digest abbreviated the way Docker abbreviates an id, then the build
    // time and the size. The clock is asserted by shape rather than by value:
    // it is rendered in the browser's own timezone, which is the machine's.
    //
    // All three, including the orchestrator's own, which it reads off the
    // container it is in: the fake daemon stands this process in one.
    await expect
      .poll(() =>
        page
          .getByText(/^orchestrator 1a2b3c4d5e6f · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 400 MB$/)
          .isVisible(),
      )
      .toBe(true);
    const proxy = page.getByText(/^proxy 9f8e7d6c5b4a · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 180 MB$/);
    await expect.poll(() => proxy.isVisible()).toBe(true);
    // In gigabytes, which is the size a box image is and the reason the
    // line carries one at all.
    await expect.poll(() => page.getByText(/^box 001122334455 · .* · 4.2 GB$/).isVisible())
      .toBe(true);
    // The whole digest is on hover: too long for the line, and the only form
    // worth pasting into a comparison.
    expect(await proxy.getAttribute('title')).toBe(
      'sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
    );
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a box busy with work no conversation claims offers to stop all of it', async () => {
  // The case the box-level kill exists for: the box says it is busy, no
  // thread of it has a task, and so nothing in the thread's own bar can stop
  // what is running. After a respawn that is every orphaned build in the box,
  // because an adapter knows nothing about the shells the one before it left.
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

    // Asked first: it kills work nobody is watching, and half-done work stays
    // half-done.
    await stop.click();
    // And asked in front of what it is about to kill, because nothing else in
    // the dashboard can name these: no thread claims them, so no bar lists
    // them, and a person deciding has only the reading to go on. With the age,
    // which is what separates a build somebody is waiting on from something
    // left behind hours ago.
    await expect
      .poll(() => page.getByText('james -config conf/james.yaml').isVisible())
      .toBe(true);
    expect(await page.getByText('4h 39m').count()).toBe(2);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => stub.boxStops).toEqual(['orphan01']);

    // And the offer goes when the box stops being busy, which is the next
    // reading rather than anything this browser decided.
    await expect.poll(() => stop.isVisible()).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a box whose own conversation is running the work offers no box-wide kill', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    // 'nightly bench' is busy, and its first thread says the work is its own:
    // that one is stopped by name from its own bar, with the adapter, rather
    // than by signalling every process in the box.
    await expect.poll(() => page.getByText('nightly bench').isVisible()).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Stop everything running in this box' }).count(),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the info view lists what the box is running, whoever left it there', async () => {
  // The ops side of the same question, for looking rather than for deciding:
  // the card's offer is behind a confirmation, and a reader who only wants to
  // know what is holding a box awake should not have to open a kill to see it.
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

    // Straight into the conversation of the box that was just made, which is
    // the point of creating one.
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
    // The box the fixture left down, which is why the control offered is the
    // one that brings it up.
    await expect.poll(() => page.getByText('stopped').isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: 'Start' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Start' }).click();

    // The container really is running now: the view is redrawn from the
    // box the orchestrator answers with, not from anything optimistic.
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
