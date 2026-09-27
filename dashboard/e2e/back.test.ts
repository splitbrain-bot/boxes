import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { Page } from 'playwright';
import { closeBrowser, openPage, VIEWPORTS } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/**
 * Browser tests for the back button, the navigation control on a phone.
 *
 * Places push, drill-downs pop, and modal surfaces are history entries of
 * their own.
 */

/** The box every test here drives. */
const BOX = DEFAULT_BOX.id;

let stub: TestOrchestrator;

beforeAll(async () => {
  stub = await startOrchestrator();
});

beforeEach(() => {
  // One test deletes the box, and another writes a comment the next would count.
  stub.resetBoxes();
  stub.createBox();
  stub.review(BOX);
  stub.reviewCalls.length = 0;
});

afterAll(async () => {
  await closeBrowser();
  await stub?.close();
});

/**
 * The page's position in the history stack, as the router records it.
 *
 * A push that shows the right screen looks the same as a pop. Only this index
 * tells them apart.
 */
function stackIndex(page: Page): Promise<number> {
  return page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx ?? 0);
}

// --- places -----------------------------------------------------------------

test('the thread header pops the thread rather than pushing the list over it', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
    expect(await stackIndex(page)).toBe(0);

    await page.getByRole('link', { name: 'Thread 1' }).click();
    await page.waitForURL(`**/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
    expect(await stackIndex(page)).toBe(1);

    await page.getByLabel('Back to boxes').click();
    await page.waitForURL(`${stub.url}/`);
    // The list it left, not a second copy of it: one entry, not three.
    await expect.poll(() => stackIndex(page)).toBe(0);

    // And the thread is where forward goes, which is only true of a pop.
    await page.goForward();
    await page.waitForURL(`**/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file is a step on a phone: back to the tree, then to the thread', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await page.getByLabel("Review this box's code").click();
    await page.waitForURL(`**/boxes/${BOX}/review`);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: /boot\.ts/ }).click();
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);

    // Thread, review, file: three entries, and the browser's own button walks
    // back out of them one at a time.
    expect(await stackIndex(page)).toBe(2);

    await page.goBack();
    await expect.poll(() => new URL(page.url()).search).not.toContain('path=');
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);

    await page.goBack();
    await page.waitForURL(`**/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file is not a step on a pointer, where the tree never left', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`,
    'dark',
    'desktop',
  );
  try {
    await page.getByLabel("Review this box's code").click();
    await page.waitForURL(`**/boxes/${BOX}/review`);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: /boot\.ts/ }).click();
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    await page.getByRole('button', { name: /app\.ts/ }).click();
    await expect.poll(() => page.getByText('import { boot }').isVisible()).toBe(true);

    // The tree stays beside the files, so picking one adds no entry. Back
    // leaves the review.
    expect(await stackIndex(page)).toBe(1);
    await page.goBack();
    await page.waitForURL(`**/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('leaving the review leaves none of its files behind to fall into', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await page.getByLabel("Review this box's code").click();
    await page.waitForURL(`**/boxes/${BOX}/review`);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: /boot\.ts/ }).click();
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    expect(await stackIndex(page)).toBe(2);

    // A phone turned to landscape with a file open: the header's control is
    // now the one that leaves the review, and the file's entry is still on
    // the stack under it. Leaving is one press either way.
    await page.setViewportSize(VIEWPORTS.desktop);
    await expect.poll(() => page.getByLabel('Back to the thread').isVisible()).toBe(true);
    await page.getByLabel('Back to the thread').click();

    await page.waitForURL(`**/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
    await expect.poll(() => stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a pasted link with nothing beneath it steps up instead of out of the app', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    // One entry, and it is the file: there is nothing of the app's below it.
    expect(await stackIndex(page)).toBe(0);

    await page.getByLabel('Back to the file list').click();
    await expect.poll(() => new URL(page.url()).search).not.toContain('path=');
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);
    // Rewritten in place rather than pushed: a step out must not add a step.
    expect(await stackIndex(page)).toBe(0);

    await page.getByLabel('Back to boxes').click();
    await page.waitForURL(`${stub.url}/`);
    // Still the one entry. The parent took this one's place, so the browser's
    // own back button still leads out of the app, which is what it is for.
    expect(await stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- modal surfaces ---------------------------------------------------------

test('back closes the hunk sheet and leaves the file where it was', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.getByLabel('Show the change at line 2').isVisible()).toBe(true);
    await page.getByLabel('Show the change at line 2').click();
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    // The sheet is an entry of its own, at the same URL as the file under it.
    await expect.poll(() => stackIndex(page)).toBe(1);

    await page.goBack();

    // Only the sheet closed: the file is still open and still in the URL.
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    expect(new URL(page.url()).search).toContain('path=app%2Fsrc%2Fboot.ts');
    expect(await stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('closing a sheet by hand takes its entry back out with it', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await page.getByLabel('Show the change at line 2').click();
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);

    // A spent entry is not left on the stack: the next back press has to be
    // the one that leaves the file, not one that appears to do nothing.
    await expect.poll(() => stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('back closes the comment composer without closing the file under it', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await page.locator('[data-line="2"] code').click();
    await expect.poll(() => page.getByText('Comment on line 2').isVisible()).toBe(true);
    await page.getByRole('textbox', { name: 'Comment on line 2' }).fill('half a thought');
    await expect.poll(() => stackIndex(page)).toBe(1);

    await page.goBack();

    // One press, one thing closed.
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    // Cancelled, not saved: nothing was written on the way out.
    expect(stub.reviewCalls).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('back cancels a confirmation instead of confirming it', async () => {
  await stub.comment(BOX, 'app/src/app.ts', 2, 'to be kept');

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/review`);
  try {
    await expect.poll(() => page.getByLabel('Start a new review').isVisible()).toBe(true);
    await page.getByLabel('Start a new review').click();
    await expect.poll(() => page.getByText('Start a new review?').isVisible()).toBe(true);
    await expect.poll(() => stackIndex(page)).toBe(1);

    await page.goBack();

    // Dismissed, and the review still there. A back press is not an answer to
    // a question, and it must never be read as the destructive one.
    await expect.poll(() => page.locator('[data-slot="dialog-content"]').count()).toBe(0);
    await expect.poll(() => page.getByLabel('Start a new review').isVisible()).toBe(true);
    expect(stub.reviewCalls).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- terminal actions -------------------------------------------------------

test('a deleted box is not what the entry left behind leads to', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
    await page.getByLabel('Details and controls for refactor auth').click();
    await page.waitForURL(`**/boxes/${BOX}/info`);

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => page.getByText('Delete refactor auth?').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();

    // The list, in place of the view that acted rather than on top of it.
    await page.waitForURL(`${stub.url}/`);
    await expect.poll(() => page.getByText('No boxes yet').isVisible()).toBe(true);

    // And it stays there. The dialog was still mounted during the navigation,
    // which replaced the entry the dialog had pushed. Popping that entry now
    // would land on the deleted box.
    await new Promise((done) => setTimeout(done, 250));
    expect(new URL(page.url()).pathname).toBe('/');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the handoff prompt is staged once, not replayed by back and forward', async () => {
  await stub.comment(BOX, 'app/src/app.ts', 2, 'please fix');

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
  try {
    await page.getByLabel("Review this box's code").click();
    // Icon-only at this width, so the title is what names it.
    const handoff = page.getByTitle('Open the thread with a prompt to address these comments');
    await expect.poll(() => handoff.isVisible()).toBe(true);
    await handoff.click();

    // Back to the entry the review was opened from, not a new one.
    await page.waitForURL(`${stub.url}/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
    await expect
      .poll(() => page.getByLabel('Message input').inputValue())
      .toContain('Read REVIEW.md');
    await expect.poll(() => stackIndex(page)).toBe(0);

    // Forward into the review and back out again. The prompt is not in the
    // entry's state, so the browser cannot replay it.
    await page.goForward();
    await expect.poll(() => handoff.isVisible()).toBe(true);
    await page.goBack();
    await page.waitForURL(`${stub.url}/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`);
    await expect.poll(() => page.getByLabel('Message input').isVisible()).toBe(true);
    expect(await page.getByLabel('Message input').inputValue()).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
