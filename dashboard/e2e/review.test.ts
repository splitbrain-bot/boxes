import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';
import { reviewWorkspace } from './workspace.ts';

/**
 * Browser tests for the review pages, over a workspace with real git
 * repositories in it.
 *
 * The tests use both viewports, because the phone and desktop layouts differ
 * too much for one to vouch for the other.
 */

/** The box every test here drives. */
const BOX = DEFAULT_BOX.id;

let stub: TestOrchestrator;

beforeAll(async () => {
  stub = await startOrchestrator();
});

beforeEach(() => {
  // Tests write comments and replace the workspace, which would change the
  // next test's counts.
  stub.resetBoxes();
  stub.createBox();
  stub.review(BOX);
  stub.reviewCalls.length = 0;
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

// --- browsing ---------------------------------------------------------------

test('the tree is the whole screen on a phone, and a file replaces it', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/review`);
  try {
    // The workspace's top level: two repositories and a directory in neither.
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: 'lib a git repository' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: /^notes/ }).isVisible()).toBe(true);
    // A repository root is labelled, so the boundaries stay visible.
    expect(await page.getByLabel('a git repository').count()).toBe(2);

    // Directories start closed unless they are a single-child chain from the
    // top, which this fixture's three top-level entries are not.
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await expect.poll(() => page.getByRole('button', { name: /app\.ts/ }).isVisible()).toBe(true);
    // Status marks come with the tree, from the repository that owns the path.
    await expect.poll(() => page.getByLabel('modified').isVisible()).toBe(true);

    await page.getByRole('button', { name: /app\.ts/ }).click();

    // The file is in the URL, so it is linkable and the back button works.
    await expect.poll(() => new URL(page.url()).search).toContain('path=app%2Fsrc%2Fapp.ts');
    await expect.poll(() => page.getByText('import { boot }').isVisible()).toBe(true);
    await shoot(page, 'review-file-phone');

    // Back steps from the file to the file list, through the header's button.
    await page.getByLabel('Back to the file list').click();
    await expect.poll(() => new URL(page.url()).search).not.toContain('path=');
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);

    // From the list, back leads to the boxes: a review opened by a link names
    // no thread to go back to.
    await expect.poll(() => page.getByLabel('Back to boxes').isVisible()).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the tree is a column beside the pane on a desktop', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    // Tree and file at once, unlike on a phone.
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await expect.poll(() => page.getByRole('button', { name: /boot\.ts/ }).isVisible()).toBe(true);
    // The header names the repository the open file belongs to.
    await expect.poll(() => page.getByText(/· app/).isVisible()).toBe(true);
    // The list and the file are one view here, so there is no step between
    // the review and what opened it: back leaves, with a file open or without.
    expect(await page.getByLabel('Back to the file list').count()).toBe(0);
    await expect.poll(() => page.getByLabel('Back to boxes').isVisible()).toBe(true);
    await shoot(page, 'review-file-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a pasted link opens straight to its file', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2FREADME.md`,
  );
  try {
    await expect.poll(() => page.getByText('A project the agent cloned.').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the code is highlighted, and a line is addressable', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.locator('[data-line="1"]').isVisible()).toBe(true);
    // Every line is its own element, which is what makes tapping one possible.
    expect(await page.locator('[data-line]').count()).toBe(3);
    // Tokens arrive after the grammar has loaded, so this is polled.
    await expect
      .poll(() => page.locator('[data-line="1"] code span').count(), { timeout: 15_000 })
      .toBeGreaterThan(1);
    // Coloured by a custom property, so light and dark need no re-tokenize.
    const colour = await page
      .locator('[data-line="1"] code span')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(colour).not.toBe('');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a gutter marker opens the hunk, deleted lines included', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.getByText('lines deleted here').isVisible()).toBe(true);
    await page.getByText('lines deleted here').click();

    // The hunk is the only place that shows the removed lines.
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('console.log("boot")').isVisible()).toBe(true);
    await shoot(page, 'review-hunk-phone', 'viewport');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the gutter opens the hunk, and the code opens the comment', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.getByLabel('Show the change at line 2').isVisible()).toBe(true);
    await page.getByLabel('Show the change at line 2').click();
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('console.log("boot")').isVisible()).toBe(true);
    await page.keyboard.press('Escape');

    // And the code half of the same line still starts a comment.
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);
    await page.locator('[data-line="2"] code').click();
    await expect.poll(() => page.getByText('Comment on line 2').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a line with no hunk behind it has no gutter button', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fapp.ts`,
  );
  try {
    // An unchanged file has no hunk to show.
    await expect.poll(() => page.locator('[data-line="1"] code').isVisible()).toBe(true);
    expect(await page.getByLabel('Show the change at line 1').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file the change deleted is listed, and says it is gone', async () => {
  // Listed by its git status alone, because it is not on disk and not in ls-files.
  stub.review(BOX, reviewWorkspace({ deleted: ['app/src/old.ts'] }));
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fold.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect
      .poll(() => page.getByText('This file was deleted, so there is nothing left to read.').isVisible())
      .toBe(true);
    // And it is in the tree, under the directory it was in.
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await expect.poll(() => page.getByRole('button', { name: /old\.ts/ }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a binary is listed, and opens in a tab of its own with its own type', async () => {
  const base = reviewWorkspace();
  stub.review(BOX, reviewWorkspace({ files: { ...base.files, 'notes/chart.png': 'PNG\0bytes' } }));
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=notes%2Fchart.png`,
    'dark',
    'desktop',
  );
  try {
    await expect
      .poll(() => page.getByText('This file is binary, so it cannot be shown here.').isVisible())
      .toBe(true);
    await page.getByRole('button', { name: /^notes/ }).click();
    await expect.poll(() => page.getByRole('button', { name: /chart\.png/ }).isVisible()).toBe(true);
    await shoot(page, 'review-binary-desktop');

    // A real link, so the tab is the browser's and the type is the server's.
    const link = page.getByRole('link', { name: 'Open in a new tab' });
    const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
    await expect.poll(() => tab.url()).toContain('/review/raw?path=notes%2Fchart.png');
    const res = await page.request.get(new URL((await link.getAttribute('href'))!, stub.url).href);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(await res.body()).toEqual(Buffer.from('PNG\0bytes'));
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file past the line limit is one plain block with nothing to tap', async () => {
  // Long enough that a row per line is tens of thousands of elements, which is
  // what freezes a phone — and one line of it changed, so the toolbar has
  // something to count.
  const body = Array.from({ length: 9000 }, (_, i) => `const line${i} = ${i};`).join('\n');
  const workspace = reviewWorkspace();
  workspace.files['app/long.ts'] = `const first = false;\n${body}\n`;
  workspace.committed!['app/long.ts'] = `const first = true;\n${body}\n`;
  stub.review(BOX, workspace);

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Flong.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect
      .poll(() => page.getByText('too long to review line by line').isVisible())
      .toBe(true);
    // The file is still there to read, as one block of text.
    await expect.poll(() => page.getByText('const line8999 = 8999;').isVisible()).toBe(true);

    // No row per line, so no gutter to tap, no line to comment on and no way
    // into edit mode.
    expect(await page.locator('[data-line]').count()).toBe(0);
    expect(await page.getByLabel(/^Show the change at line/).count()).toBe(0);
    expect(await page.getByLabel('Edit this file').count()).toBe(0);

    // The change is still counted, because it is still a fact about the file.
    // There is just no row to step to.
    await expect.poll(() => page.getByLabel('1 change').isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Next change' }).isDisabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('prev/next steps through the changes', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
    'dark',
    'desktop',
  );
  try {
    // Two changed lines and one deleted block at the end make three places to
    // step through. A deletion counts at the line its marker sits under.
    await expect.poll(() => page.getByLabel('3 changes').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Next change' }).click();
    // The comment buttons stay disabled until there are comments.
    expect(await page.getByRole('button', { name: 'Next comment' }).isDisabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- commenting -------------------------------------------------------------

test('commenting a line on a phone writes it through the API', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    // The code half of the row is the comment target. It has no label, so the
    // test finds it by its line.
    await expect.poll(() => page.locator('[data-line="2"] code').isVisible()).toBe(true);
    await page.locator('[data-line="2"] code').click();

    // On touch the composer is a bottom sheet, so the keyboard has somewhere
    // to be that is not on top of it.
    await expect.poll(() => page.getByText('Comment on line 2').isVisible()).toBe(true);
    await shoot(page, 'review-composer-phone', 'viewport');

    await page.getByRole('textbox', { name: 'Comment on line 2' }).fill('this TODO needs an owner');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();

    // Written where the agent will read it.
    await expect.poll(() => stub.reviewCalls.length).toBe(1);
    expect(stub.reviewCalls[0]).toMatchObject({
      method: 'PUT',
      boxId: BOX,
      body: { path: 'app/src/boot.ts', line: 2, comment: 'this TODO needs an owner' },
    });
    expect((await stub.comments(BOX, 'app/src/boot.ts'))[0]?.comment).toBe(
      'this TODO needs an owner',
    );

    // And shown inline under its line, on this size as on the other.
    await expect.poll(() => page.getByText('this TODO needs an owner').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('commenting a line on a desktop uses the inline composer', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.locator('[data-line="3"] code').isVisible()).toBe(true);
    await page.locator('[data-line="3"] code').click();

    // Inline, so nothing was put in a sheet.
    await expect
      .poll(() => page.getByRole('textbox', { name: 'Comment on line 3' }).isVisible())
      .toBe(true);
    expect(await page.locator('[data-slot="sheet-content"]').count()).toBe(0);

    await page.getByRole('textbox', { name: 'Comment on line 3' }).fill('call this in main');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();

    await expect.poll(() => stub.reviewCalls.length).toBe(1);
    await expect.poll(() => page.getByText('call this in main').isVisible()).toBe(true);
    // The tree's badge follows without a tree refetch.
    await expect.poll(() => page.getByLabel('1 comment').first().isVisible()).toBe(true);
    await shoot(page, 'review-comment-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a comment can be edited and deleted', async () => {
  await stub.comment(BOX, 'app/src/app.ts', 2, 'first thoughts');

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('first thoughts').isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Edit the comment on line 2' }).click();
    const field = page.getByRole('textbox', { name: 'Comment on line 2' });
    await expect.poll(() => field.isVisible()).toBe(true);
    // Editing starts from what is there, rather than from an empty box.
    expect(await field.inputValue()).toBe('first thoughts');
    await field.fill('second thoughts');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.getByText('second thoughts').isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Delete the comment on line 2' }).click();
    // Confirmed first, because a delete has no undo.
    await expect
      .poll(() => page.getByText('Delete the comment on line 2?').isVisible())
      .toBe(true);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => page.getByText('second thoughts').isVisible()).toBe(false);
    expect(await stub.comments(BOX, 'app/src/app.ts')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an outdated comment says the code moved', async () => {
  await stub.comment(BOX, 'app/src/app.ts', 1, 'about the old import');
  // The agent rewrites the file, so the commented lines are gone.
  stub.write(BOX, 'app/src/app.ts', 'import { start } from "./start";\n\nstart();\n');

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('about the old import').isVisible()).toBe(true);
    // In words, because a symbol for "outdated" is not guessable.
    expect(
      await page.getByText('The code this was written about has changed').isVisible(),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('handing the review to the agent stages a prompt, unsent', async () => {
  await stub.comment(BOX, 'app/src/app.ts', 2, 'please fix');

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`,
    'dark',
    'desktop',
  );
  try {
    await page.getByLabel("Review this box's code").click();
    await expect.poll(() => page.getByRole('button', { name: /Hand to agent/ }).isVisible()).toBe(
      true,
    );
    await page.getByRole('button', { name: /Hand to agent/ }).click();

    // Lands in the thread with the prompt in the composer and no turn started.
    // The prompt is one line for any number of repositories, because the
    // workspace has one REVIEW.md at its top.
    await expect.poll(() => page.url()).toContain(`/boxes/${BOX}/threads/th1`);
    await expect
      .poll(() => page.getByText('Read REVIEW.md and address the comments in it.').isVisible())
      .toBe(true);
    await shoot(page, 'review-handoff-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a review opened from the box list offers no thread to hand it to', async () => {
  await stub.comment(BOX, 'app/src/app.ts', 2, 'please fix');

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review`,
    'dark',
    'desktop',
  );
  try {
    // The comments are there, and so is the rest of the toolbar.
    await expect.poll(() => page.getByLabel('Start a new review').isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: /Hand to agent/ }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a new review clears every comment, behind a confirmation', async () => {
  await stub.comment(BOX, 'app/src/app.ts', 2, 'to be discarded');

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('to be discarded').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Start a new review' }).click();

    await expect.poll(() => page.getByText('Start a new review?').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Delete the review' }).click();

    await expect.poll(() => page.getByText('to be discarded').isVisible()).toBe(false);
    expect(stub.hasReview(BOX)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- editing ----------------------------------------------------------------

test('a line can be fixed in place, and the save reaches the workspace', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.locator('[data-line="2"] code').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Edit this file' }).click();

    // A textarea over the same rows, which keep their line numbers and highlighting.
    const editor = page.getByRole('textbox', { name: 'File contents' });
    await expect.poll(() => editor.isVisible()).toBe(true);
    await expect.poll(() => page.locator('[data-line="2"]').isVisible()).toBe(true);
    await shoot(page, 'review-edit-phone');

    // Nothing to save until something is typed.
    expect(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true);

    await editor.fill(
      'export function boot(): void {\n  wireTheRouter();\n  console.log("up");\n}\n',
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(() => stub.reviewCalls.length).toBe(1);
    expect(stub.reviewCalls[0]).toMatchObject({
      method: 'PUT file',
      boxId: BOX,
      body: { path: 'app/src/boot.ts' },
    });
    // The save lands in the workspace the agent works in.
    await expect
      .poll(() => stub.read(BOX, 'app/src/boot.ts'))
      .toContain('wireTheRouter();');
    // Nothing left to save.
    await expect
      .poll(() => page.getByRole('button', { name: 'Save', exact: true }).isDisabled())
      .toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the line being read stays put across a switch into editing', async () => {
  // A comment high up, so folding its card away in edit mode moves every row below it.
  stub.review(BOX, {
    files: { 'long.ts': Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n') },
    repos: [''],
  });
  await stub.comment(BOX, 'long.ts', 3, 'a card tall enough to push the rest down');

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=long.ts`,
  );
  try {
    const pane = page.locator('[data-slot="review-code-pane"]');
    await expect.poll(() => pane.isVisible()).toBe(true);
    await expect.poll(() => page.getByText('a card tall enough').isVisible()).toBe(true);

    await pane.evaluate((el) => {
      el.scrollTop = 2000;
    });
    /** The line at the top of the pane, which is what must not move. */
    const topLine = (): Promise<number | null> =>
      pane.evaluate((el) => {
        for (const row of el.querySelectorAll<HTMLElement>('[data-line]')) {
          if (row.offsetTop + row.offsetHeight > el.scrollTop) return Number(row.dataset.line);
        }
        return null;
      });
    const before = await topLine();
    expect(before).toBeGreaterThan(1);

    await page.getByRole('button', { name: 'Edit this file' }).click();
    await expect
      .poll(() => page.getByRole('textbox', { name: 'File contents' }).isVisible())
      .toBe(true);
    // The card folded away and shifted every row, yet the top line is the same.
    expect(await topLine()).toBe(before);

    // And back again, with the card between the rows once more.
    await page.getByRole('button', { name: 'Stop editing and go back to commenting' }).click();
    await expect.poll(() => page.getByText('a card tall enough').isVisible()).toBe(true);
    expect(await topLine()).toBe(before);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a save the agent got in first is refused, and the choice is offered', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=lib%2Findex.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.locator('[data-line="1"] code').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Edit this file' }).click();
    const editor = page.getByRole('textbox', { name: 'File contents' });
    await expect.poll(() => editor.isVisible()).toBe(true);
    await editor.fill('export const version = "2.0.0";\n');

    // The agent writes the same file while the review is open.
    stub.write(BOX, 'lib/index.ts', 'export const version = "9.9.9";\n');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => page.getByText('The agent changed this file while you were editing it.').isVisible())
      .toBe(true);
    // Refused rather than applied, and the buffer is still there to save.
    expect(stub.read(BOX, 'lib/index.ts')).toBe('export const version = "9.9.9";\n');
    await shoot(page, 'review-edit-conflict-desktop');

    await page.getByRole('button', { name: 'Save anyway' }).click();
    await expect
      .poll(() => stub.read(BOX, 'lib/index.ts'))
      .toBe('export const version = "2.0.0";\n');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('walking away from unsaved edits asks first', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2FREADME.md`,
  );
  try {
    await expect.poll(() => page.locator('[data-line="1"] code').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Edit this file' }).click();
    const editor = page.getByRole('textbox', { name: 'File contents' });
    await expect.poll(() => editor.isVisible()).toBe(true);
    await editor.fill('# demo\n\nRewritten by hand.\n');

    await page.getByRole('button', { name: 'Back to the file list' }).click();
    await expect.poll(() => page.getByText('Leave without saving?').isVisible()).toBe(true);
    // Cancelling leaves the buffer exactly where it was.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => editor.inputValue()).toContain('Rewritten by hand.');

    await page.getByRole('button', { name: 'Back to the file list' }).click();
    await page.getByRole('button', { name: 'Discard the edits' }).click();
    await expect.poll(() => new URL(page.url()).search).not.toContain('path=');
    // Nothing was written.
    expect(stub.read(BOX, 'app/README.md')).toBe('# demo\n\nA project the agent cloned.\n');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the rows and the editor over them wrap in the same places', async () => {
  // Line shapes that decide where a line breaks, repeated so any difference
  // adds up. Typing lands at the caret only while the rows behind the textarea
  // wrap exactly as it does.
  const shapes = [
    'The review starts with a file browser over the whole workspace, which is where reading one begins.',
    'The format is the desktop [review](https://github.com/splitbrain/review/blob/main/README.md) tool of the same name.',
    '\t\tconst deeplyIndented = somethingWithAPrettyLongNameIndeed(first, second, third, fourth);',
    'const blob = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
    'A line that ends in two spaces, which markdown reads as a break.  ',
  ];
  const lines = Array.from({ length: 25 }, (_, i) => shapes[i % shapes.length]!);
  stub.write(BOX, 'readme.md', `${lines.join('\n')}\n`);

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=readme.md`,
  );
  try {
    await expect.poll(() => page.locator('[data-line="1"] code').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Edit this file' }).click();
    const editor = page.getByRole('textbox', { name: 'File contents' });
    await expect.poll(() => editor.isVisible()).toBe(true);

    // The textarea is exactly as tall as the rows it covers, so both wrapped
    // the file into the same number of visual lines.
    const heights = await page.evaluate(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement;
      return { box: ta.clientHeight, content: ta.scrollHeight };
    });
    expect(heights.content).toBe(heights.box);

    // Far enough down for any drift to show: text typed into the last visual
    // row of a wrapped line lands in that line.
    await page.locator('[data-slot="review-code-pane"]').evaluate((pane) => {
      const target = pane.querySelector('[data-line="22"]') as HTMLElement;
      pane.scrollTop = target.offsetTop - 120;
    });
    const row = (await page.locator('[data-line="22"]').boundingBox())!;
    const code = (await page.locator('[data-line="22"] code').boundingBox())!;
    expect(row.height).toBeGreaterThan(code.height / 2);
    await page.mouse.click(code.x + 60, row.y + row.height - 8);
    await page.keyboard.type('INSERTED');

    const typed = (await editor.inputValue()).split('\n');
    expect(typed[21]).toContain('INSERTED');
    expect(typed[20]).not.toContain('INSERTED');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file the pane cannot show whole cannot be edited', async () => {
  stub.review(BOX, reviewWorkspace({ deleted: ['app/gone.ts'] }));
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=app%2Fgone.ts`,
  );
  try {
    await expect.poll(() => page.getByText('This file was deleted').isVisible()).toBe(true);
    // No control at all, because there is nothing to edit.
    expect(await page.getByRole('button', { name: 'Edit this file' }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- the base revision ------------------------------------------------------

test('the base picker sets a revision and says which one is active', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review`,
    'dark',
    'desktop',
  );
  try {
    // The status line without a base.
    await expect.poll(() => page.getByText(/vs working tree/).isVisible()).toBe(true);

    await page.getByRole('button', { name: /HEAD/ }).click();
    await page.getByRole('textbox', { name: 'Base revision' }).fill('main');
    await page.getByRole('button', { name: 'Compare' }).click();

    // The status line names the base, because it decides what every colour and
    // gutter marker means.
    await expect.poll(() => page.getByText(/vs main/).isVisible()).toBe(true);
    expect(stub.reviewCalls.at(-1)).toMatchObject({ method: 'PUT base', body: { rev: 'main' } });

    // The picker shows what the revision resolved to in each repository.
    await page.getByRole('button', { name: /main/ }).click();
    // The commit ids differ per fixture run, so the test matches their shape.
    await expect.poll(() => page.getByText(/^[0-9a-f]{8}$/).first().isVisible()).toBe(true);
    await shoot(page, 'review-base-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a revision that names nothing in one repository is reported, not refused', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review`,
    'dark',
    'desktop',
  );
  try {
    await page.getByRole('button', { name: /HEAD/ }).click();
    await page.getByRole('textbox', { name: 'Base revision' }).fill('only-app');
    await page.getByRole('button', { name: 'Compare' }).click();

    // Resolved in one repository and not in the other, which is no error. The
    // header counts it, and the picker names the one that fell back to its HEAD.
    await expect.poll(() => page.getByText(/vs only-app \(1 of 2\)/).isVisible()).toBe(true);
    await page.getByRole('button', { name: /only-app/ }).click();
    await expect.poll(() => page.getByText('working tree').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a revision that is not one anywhere is reported, not swallowed', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review`,
    'dark',
    'desktop',
  );
  try {
    await page.getByRole('button', { name: /HEAD/ }).click();
    await page.getByRole('textbox', { name: 'Base revision' }).fill('nope');
    await page.getByRole('button', { name: 'Compare' }).click();

    await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/unknown revision: nope/).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- degraded shapes --------------------------------------------------------

test('a workspace with no repository still browses and comments', async () => {
  stub.review(BOX, { files: { 'notes.txt': 'just some notes\nnothing tracked\n' }, repos: [] });

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review?path=notes.txt`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('just some notes').isVisible()).toBe(true);
    // The git features are off, and the page says so.
    await expect.poll(() => page.getByText(/no git/).isVisible()).toBe(true);
    // No base to pick when there is no repository to pick one in.
    expect(await page.getByRole('button', { name: /HEAD/ }).isVisible()).toBe(false);
    // Commenting still works.
    await page.locator('[data-line="1"] code').click();
    await page.getByRole('textbox', { name: 'Comment on line 1' }).fill('still reviewable');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => stub.reviewCalls.length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a box whose workspace cannot be read says what to do', async () => {
  // A legacy box keeps its files in a named volume, which this process cannot read.
  stub.resetBoxes();
  stub.createBox({ legacy: true });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/review`);
  try {
    // Its next start migrates it, and the message has to name that fix.
    await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/Start the box once to migrate it/).isVisible()).toBe(true);
    await shoot(page, 'review-legacy-phone');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an empty workspace says so rather than showing nothing', async () => {
  stub.review(BOX, { files: {}, repos: [] });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/review`);
  try {
    await expect.poll(() => page.getByText(/This workspace is empty/).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- reading position -------------------------------------------------------

test('each file remembers how far it was read, and a new one starts at the top', async () => {
  // Long enough to scroll, which the small fixture files are not.
  stub.review(BOX, {
    files: {
      'long.ts': Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n'),
      'short.ts': 'const one = 1;\n',
    },
    repos: [''],
  });

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review`,
    'dark',
    'desktop',
  );
  try {
    const pane = page.locator('[data-slot="review-code-pane"]');
    const offset = (): Promise<number> => pane.evaluate((el) => el.scrollTop);

    await page.getByRole('button', { name: /long\.ts/ }).click();
    await expect.poll(() => pane.isVisible()).toBe(true);
    await pane.evaluate((el) => {
      el.scrollTop = 1200;
    });
    await expect.poll(offset).toBe(1200);

    // One pane serves every file, so the next file must be scrolled to the top.
    await page.getByRole('button', { name: /short\.ts/ }).click();
    await expect.poll(() => page.getByText('const one = 1;').isVisible()).toBe(true);
    await expect.poll(offset).toBe(0);

    // And coming back picks up where the reading stopped.
    await page.getByRole('button', { name: /long\.ts/ }).click();
    await expect.poll(offset).toBe(1200);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the review header gives way to reading the file, and returns', async () => {
  // Long enough to scroll, which the small fixture files are not.
  stub.review(BOX, {
    files: {
      'long.ts': Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n'),
    },
    repos: [''],
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX}/review`);
  try {
    const pane = page.locator('[data-slot="review-code-pane"]');
    const shelf = page.locator('[data-slot="shelf"]');
    const away = (): Promise<boolean> => shelf.evaluate((el) => el.hasAttribute('data-away'));
    /** Whether the header is where a thumb reaches for it. */
    const inReach = (): Promise<boolean> =>
      page.evaluate(() => !!document.elementFromPoint(20, 10)?.closest('header'));

    /**
     * Scrolls the pane by `dy` pixels per frame, for `steps` frames.
     *
     * It sets the position instead of using the wheel. A wheel notch starts an
     * animation whose frames depend on how busy the machine is.
     */
    const read = (dy: number, steps: number): Promise<void> =>
      pane.evaluate(
        (el, [by, count]) =>
          new Promise<void>((done) => {
            let left = count;
            const step = (): void => {
              if (left-- <= 0) return done();
              el.scrollTop += by;
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }),
        [dy, steps] as [number, number],
      );

    await page.getByRole('button', { name: /long\.ts/ }).click();
    await expect.poll(() => pane.isVisible()).toBe(true);
    expect(await away()).toBe(false);

    await read(100, 4);
    await expect.poll(away).toBe(true);
    // Nothing in the header is reachable while it is away. Polled, because the
    // collapse is a transition that follows the state change.
    await expect.poll(inReach).toBe(false);

    await read(-100, 2);
    await expect.poll(away).toBe(false);
    await expect.poll(inReach).toBe(true);

    // Back from a file while the header is away brings the header back over
    // the file list. Otherwise the list would have no way out.
    await read(100, 4);
    await expect.poll(away).toBe(true);
    await page.goBack();
    await expect.poll(away).toBe(false);
    await expect.poll(inReach).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the review header stays where it is on a wide screen', async () => {
  stub.review(BOX, {
    files: {
      'long.ts': Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n'),
    },
    repos: [''],
  });

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX}/review`,
    'dark',
    'desktop',
  );
  try {
    const pane = page.locator('[data-slot="review-code-pane"]');
    const shelf = page.locator('[data-slot="shelf"]');

    await page.getByRole('button', { name: /long\.ts/ }).click();
    await expect.poll(() => pane.isVisible()).toBe(true);

    // The same scrolling that puts the header away on a phone.
    await pane.evaluate(
      (el) =>
        new Promise<void>((done) => {
          let left = 4;
          const step = (): void => {
            if (left-- <= 0) return done();
            el.scrollTop += 100;
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    expect(await shelf.evaluate((el) => el.hasAttribute('data-away'))).toBe(false);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- the entry points -------------------------------------------------------

test('the review is reachable from the box card and the thread header', async () => {
  const list = await openPage(stub.url, '/', 'dark', 'desktop');
  try {
    await expect.poll(() => list.page.getByRole('link', { name: 'Review' }).isVisible()).toBe(true);
    await list.page.getByRole('link', { name: 'Review' }).click();
    await expect.poll(() => list.page.url()).toContain(`/boxes/${BOX}/review`);
    expect(list.errors).toEqual([]);
  } finally {
    await list.close();
  }

  const thread = await openPage(stub.url, `/boxes/${BOX}/threads/${DEFAULT_BOX.threadId}`, 'dark', 'desktop');
  try {
    const link = thread.page.getByRole('link', { name: "Review this box's code" });
    await expect.poll(() => link.isVisible()).toBe(true);
    await link.click();
    await expect.poll(() => thread.page.url()).toContain(`/boxes/${BOX}/review`);
    expect(thread.errors).toEqual([]);
  } finally {
    await thread.close();
  }
});
