import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import type { ThreadUpdate } from '../src/stores/thread/acp-types.ts';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';
import { reply, type GatewayScript } from './stub-gateway.ts';

/**
 * Browser tests for the live thread, against a stub gateway that answers ACP
 * the way the real gateway does.
 */

/** The box every test here drives. */
const BOX = DEFAULT_BOX;

/**
 * A real 200 by 120 PNG with two bands and a diagonal, so a screenshot shows a
 * recognisable image.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAB4CAIAAAA48Cq8AAAB4UlEQVR42u3WwUkDARRF0SklpaVcS7GGrBRcGzIDF316ws02hJnD4x+Pbz63+5t0uePx9OMBKYGFl0JYbKmChZfOwfr8sqUE1llbeOlVWHgphMWWKlh4KYR1gZdHqVdhmS5VsPBSCIstVbDwUgjLUa8QlulSBQsvhbDYUgULL4WwHPUKYZkuVbDwUgiLLR3pr+MF1m/h5ZWAZbr007DwAostDcLCCyxHvTZhmS6w8NIgLLbAwkuDsBz1YJkuDcLCCyy2NAgLL7Ac9dqEZbrAwguszf/NFlh4gfUPeHnlYJkusPDSH4bFFlh4geWoF1imCyy8wGJLYOEFlqMeLNMlsPACiy2w8MLrdVjv95u+OmXL43oeWNdt4QUWXmCxBRZeeIHlqAfLdIGFF15gsQUWXmDhxRZYpgssvMASW2DhBZajHiyZLrDwAostsIQXWI56sEwXWMILLLbAwmuNF1iOerDY2uEFFl5gsbVjCyy8wMJrxxZYpgssvHZ4gcUWWHjt8ALLUQ+WdqYLLLzA0o4tsPACSztHPVimCyzt8AKLrcQWWHglvMDCK7EFFlsJL7DwSniBxVZiCyy8El5g4ZXYAouthBdYSniBpcQWWEp4gaXkqAdLyXSBpYQXWEpsgaWE1wex055aMLbECwAAAABJRU5ErkJggg==';

let stub: TestOrchestrator;

/** Starts a deployment whose agent behaves as the script says. */
async function start(script?: Partial<GatewayScript>): Promise<void> {
  stub = await startOrchestrator([{}], script);
}

beforeEach(() => {
  stub = undefined as unknown as TestOrchestrator;
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

test('a prompt streams back and renders as it arrives', async () => {
  await start({
    prompts: [
      {
        match: (t) => t.includes('summarise'),
        gapMs: 120,
        updates: reply('The proxy ', '**vets** every ', 'resolved address.'),
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const input = page.getByLabel('Message input');
    await input.fill('summarise the proxy');
    await input.press('Control+Enter');

    // The first chunk shows before the last has been sent.
    await expect.poll(() => page.getByText('The proxy').isVisible()).toBe(true);
    expect(stub.gateway.prompts).toEqual(['summarise the proxy']);

    await expect
      .poll(() => page.getByText('resolved address.', { exact: false }).isVisible())
      .toBe(true);
    // Markdown, not literal asterisks.
    expect(await page.locator('strong', { hasText: 'vets' }).count()).toBe(1);

    // The prompt itself is in the thread too.
    await expect.poll(() => page.getByText('summarise the proxy').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an attached image is uploaded, named in the prompt, and shown from the workspace', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('The margin is wrong.') }] });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The button builds its own file input, so the file goes through the chooser.
    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('Add Attachment').click();
    await (
      await chooser
    ).setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });

    const input = page.getByLabel('Message input');
    await input.fill('what is wrong here?');
    await input.press('Control+Enter');

    // Uploaded into the box's workspace, before the prompt that names it.
    await expect.poll(() => stub.attachmentUploads.length).toBe(1);
    expect(stub.attachmentUploads[0]!.name).toBe('shot.png');
    expect(stub.attachmentUploads[0]!.boxId).toBe(BOX.id);

    // The note saying where it was saved, then what was typed. No bytes: the
    // picture is in the workspace, and the prompt carries the path to it.
    await expect.poll(() => stub.gateway.promptBlocks.length).toBe(1);
    const blocks = stub.gateway.promptBlocks[0]!;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toContain('.boxes/attachments/shot.png');
    expect(blocks[0]!.text).toContain('image/png');
    expect(blocks[1]!.text).toBe('what is wrong here?');

    // The thread shows the picture, fetched from the workspace, not the note.
    const picture = page.locator('[data-slot="aui_user-message-image"] img').first();
    await expect.poll(() => picture.count()).toBe(1);
    expect(await picture.getAttribute('src')).toBe(
      `/api/boxes/${BOX.id}/attachments/shot.png`,
    );
    // Loaded, not only linked.
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    expect(await page.getByText('<attachments>').count()).toBe(0);
    await shoot(page, 'thread-attached-image');

    // And the same after a reload, from the replayed transcript: the note is
    // plain text that survives the replay.
    await page.reload();
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => page.locator('[data-slot="aui_user-message-image"]').count()).toBe(1);
    expect(await page.getByText('<attachments>').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an attached SVG is shown as the drawing it is', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('A box and an arrow.') }] });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('Add Attachment').click();
    await (
      await chooser
    ).setFiles({
      name: 'diagram.svg',
      mimeType: 'image/svg+xml',
      // With a script in it: an <img> runs no script, and the response's CSP
      // covers opening the file directly.
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
          '<script>window.parent.alert(1)</script><rect width="80" height="40" fill="teal"/></svg>',
      ),
    });

    const input = page.getByLabel('Message input');
    await input.fill('what does this show?');
    await input.press('Control+Enter');

    await expect.poll(() => stub.gateway.promptBlocks.length).toBe(1);
    expect(stub.gateway.promptBlocks[0]![0]!.text).toContain('image/svg+xml');

    const picture = page.locator('[data-slot="aui_user-message-image"] img').first();
    await expect.poll(() => picture.count()).toBe(1);
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(80);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an attached file that is not an image travels as a path, and reads as a chip', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('It is a receipt.') }] });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('Add Attachment').click();
    await (
      await chooser
    ).setFiles({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 not really'),
    });

    const input = page.getByLabel('Message input');
    await input.fill('what does this say?');
    await input.press('Control+Enter');

    await expect.poll(() => stub.gateway.promptBlocks.length).toBe(1);
    const blocks = stub.gateway.promptBlocks[0]!;
    // A PDF travels as a path for the agent's own tools, and the thread shows
    // it as a chip.
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toContain('.boxes/attachments/report.pdf');
    expect(blocks[0]!.text).toContain('application/pdf');

    // The chip replaces the note that carried it, and opens the file in a tab.
    // It is served as application/pdf, so the tab shows it.
    await expect.poll(() => page.getByText('report.pdf').isVisible()).toBe(true);
    const link = page.locator('[data-slot="aui_user-message-file"] a').first();
    const href = await link.getAttribute('href');
    expect(href).toBe(`/api/boxes/${BOX.id}/attachments/report.pdf`);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');

    const served = await page.request.get(`${stub.url}${href}`);
    expect(served.headers()['content-type']).toBe('application/pdf');
    expect(await page.getByText('<attachments>').count()).toBe(0);
    await shoot(page, 'thread-attached-file');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a turn with nothing to show yet shows the spinner, and stops once it has', async () => {
  await start({
    // Long enough to read the spinner's style before the answer replaces it.
    prompts: [{ match: () => true, gapMs: 2500, updates: reply('Eventually.') }],
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('think about it');
    await input.press('Control+Enter');

    // Before the first chunk the spinner is often all there is, so it has to
    // animate.
    const spinner = page.getByRole('img', { name: 'Assistant is working' });
    await expect.poll(() => spinner.isVisible()).toBe(true);
    await expect.poll(() => spinner.locator('rect').count()).toBe(9);
    await expect
      .poll(() =>
        spinner
          .locator('rect')
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
      )
      .toBe('spinner-block');

    // And it is gone as soon as there is something to read instead.
    await expect
      .poll(() => page.getByText('Eventually.').isVisible(), { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => spinner.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('reloading mid-conversation replays the whole thread', async () => {
  await start({
    prompts: [{ match: () => true, updates: reply('First answer.') }],
  });

  const first = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => first.page.getByText('connected').isVisible()).toBe(true);
    const input = first.page.getByLabel('Message input');
    await input.fill('question one');
    await input.press('Control+Enter');
    await expect.poll(() => first.page.getByText('First answer.').isVisible()).toBe(true);
  } finally {
    await first.close();
  }

  // A fresh browser gets the same thread back, because session/load replays
  // it as notifications.
  const second = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => second.page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => second.page.getByText('question one').isVisible()).toBe(true);
    // Replayed once, not twice.
    expect(await second.page.getByText('First answer.').count()).toBe(1);
    expect(second.errors).toEqual([]);
  } finally {
    await second.close();
  }
});

test('a second tab sees updates live', async () => {
  await start({
    prompts: [{ match: () => true, updates: reply('Shared answer.') }],
  });

  const a = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  const b = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => a.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => b.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => stub.gateway.attached()).toBe(2);

    const input = a.page.getByLabel('Message input');
    await input.fill('ask once');
    await input.press('Control+Enter');

    // The gateway sends every update to every browser watching the thread.
    await expect.poll(() => a.page.getByText('Shared answer.').isVisible()).toBe(true);
    await expect.poll(() => b.page.getByText('Shared answer.').isVisible()).toBe(true);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test('cancelling stops the run state', async () => {
  await start({
    prompts: [
      { match: () => true, updates: reply('Working on it…'), hold: true },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('take your time');
    await input.press('Control+Enter');

    // While the turn runs the composer offers a stop instead of a send.
    const cancel = page.getByLabel('Stop generating');
    await expect.poll(() => cancel.isVisible()).toBe(true);

    await cancel.click();
    // The cancel reaches the gateway as an ACP notification and ends the turn.
    // The composer takes prompts again once the turn state says idle.
    await expect
      .poll(() => stub.gateway.notifications.some((n) => n.method === 'session/cancel'))
      .toBe(true);
    await expect.poll(() => cancel.isVisible()).toBe(false);
    await expect.poll(() => page.getByLabel('Send message').isVisible()).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a turn held open for background work still hands the composer back', async () => {
  // As the adapter does it: the agent answers, spawns work that runs on, and
  // the prompt stays open until the work settles.
  await start({
    prompts: [
      {
        match: () => true,
        updates: reply('Started the build. I will report back.'),
        hold: true,
        background: true,
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('build it');
    await input.press('Control+Enter');

    await expect.poll(() => page.getByText('I will report back').isVisible()).toBe(true);

    // The composer takes prompts again, though the prompt upstream is still open.
    await expect
      .poll(() => page.getByLabel('Send message').isVisible(), { timeout: 10_000 })
      .toBe(true);
    expect(await page.getByLabel('Stop generating').count()).toBe(0);

    // A bar above the composer names the running work, by the command the
    // adapter announced for the task.
    const bar = page.locator('[data-slot="boxes_background-bar"]');
    await expect.poll(() => bar.isVisible()).toBe(true);
    await expect.poll(() => page.getByText('1 command still running').isVisible()).toBe(true);
    await page.getByText('1 command still running').click();
    await expect.poll(() => bar.getByText('npm run build').isVisible()).toBe(true);

    // A browser that arrives later gets the bar from the thread state.
    await page.reload();
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => bar.isVisible()).toBe(true);

    // Stopping everything targets all of the thread's work. A session/cancel
    // would interrupt the conversation and leave the command running.
    await bar.getByLabel('Stop everything still running').click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => stub.backgroundStops.length).toBe(1);
    assert.deepEqual(stub.backgroundStops[0], {
      boxId: BOX.id,
      threadId: BOX.threadId,
    });

    // The bar goes once the gateway's turn state reports no work left.
    stub.gateway.finishTasks();
    await expect.poll(() => bar.isVisible()).toBe(false);

    stub.gateway.release();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the bar names the work by kind, and offers no stop for a task that says it cannot be', async () => {
  // A task's kind says what a name like "watch the deploy log" is. A task
  // whose `stoppable` is false gets no stop button.
  await start({
    prompts: [
      {
        match: () => true,
        updates: reply('Watching the deploy, and building meanwhile.'),
        hold: true,
        background: true,
      },
    ],
    backgroundTasks: [
      {
        id: 'bg-1',
        command: 'watch the deploy log',
        kind: 'monitor',
        stoppable: false,
        startedAt: Date.now() - 90_000,
      },
      {
        id: 'bg-2',
        command: 'npm run build',
        kind: 'shell',
        stoppable: true,
        startedAt: Date.now() - 30_000,
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('watch it');
    await input.press('Control+Enter');

    const bar = page.locator('[data-slot="boxes_background-bar"]');
    await expect.poll(() => bar.isVisible()).toBe(true);
    await page.getByText('2 commands still running').click();

    // The kind, for the one whose name is a description rather than a command.
    await expect.poll(() => bar.getByText('Monitor').isVisible()).toBe(true);
    await expect.poll(() => bar.getByText('watch the deploy log').isVisible()).toBe(true);
    expect(await bar.getByLabel('Stop watch the deploy log').count()).toBe(0);

    // And the one that can be stopped is stopped by name, not by thread.
    await bar.getByLabel('Stop npm run build').click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => stub.backgroundStops.length).toBe(1);
    assert.deepEqual(stub.backgroundStops[0], {
      boxId: BOX.id,
      threadId: BOX.threadId,
      processId: 'bg-2',
    });

    stub.gateway.finishTasks();
    stub.gateway.release();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a thread that has not been read yet shows a placeholder, then all of it at once', async () => {
  // Long enough to scroll, so where the reading starts is a real question.
  const said = Array.from({ length: 12 }, (_, i) => `exchange number ${i}`);
  await start({ holdLoad: true });
  for (const text of said) {
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `asking about ${text}` },
    } as ThreadUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `answering about ${text}` },
    } as ThreadUpdate);
  }

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    // Wait for the load to park, because a release frees only parked loads.
    await expect.poll(() => stub.gateway.loadsHeld()).toBe(1);

    // No history has arrived yet, so the placeholder shows.
    await expect.poll(() => page.locator('[data-slot="thread-loading"]').isVisible()).toBe(true);

    // No composer, and no greeting that claims the thread is empty.
    expect(await page.getByLabel('Message input').count()).toBe(0);
    expect(await page.getByText('How can I help you today?').count()).toBe(0);

    stub.gateway.releaseLoad();

    // The placeholder goes when the conversation arrives, and what arrives is
    // the whole of it: the first exchange and the last are on screen in the
    // same breath, not one render apart.
    await expect.poll(() => page.locator('[data-slot="thread-loading"]').count()).toBe(0);
    expect(await page.getByText('asking about exchange number 0').count()).toBe(1);
    expect(await page.getByText('answering about exchange number 11').count()).toBe(1);
    // And now there is somewhere to type.
    await expect.poll(() => page.getByLabel('Message input').isVisible()).toBe(true);

    // Opened at the end of the conversation.
    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    await expect
      .poll(() =>
        viewport.evaluate((el) =>
          Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
        ),
      )
      .toBeLessThanOrEqual(4);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the thread sits inside the dashboard chrome rather than over it', async () => {
  await start({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The header is the dashboard's, and the thread must not cover it: the
    // back link, the mode switcher and the review link all have to be
    // clickable, not painted over by a floating panel.
    const header = (await page.locator('header').boundingBox())!;
    const thread = (await page.locator('.aui-thread-root').boundingBox())!;
    expect(header.height).toBeGreaterThan(0);
    expect(thread.y).toBeGreaterThanOrEqual(header.y + header.height);
    await expect.poll(() => page.getByLabel('Back to boxes').isVisible()).toBe(true);
    await expect.poll(() => page.getByLabel("Review this box's code").isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a hovered message that runs under the composer stays under it', async () => {
  await start();

  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${BOX.id}/threads/${BOX.threadId}`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // Prose and then rows: the shape whose action bar leaves the flow, and
    // which the stylesheet raises on hover so the bar paints over the next
    // message. Enough rows that the message runs under the composer.
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Some prose first.\n\n' },
    } as ThreadUpdate);
    for (let i = 0; i < 40; i++) {
      stub.gateway.emit({
        sessionUpdate: 'tool_call',
        toolCallId: `tc-${i}`,
        title: `Read file-${i}.ts`,
        kind: 'read',
        status: 'completed',
      } as ThreadUpdate);
    }
    const trigger = page.locator('[data-slot="tool-group-trigger"]').first();
    await expect.poll(() => trigger.isVisible()).toBe(true);
    await trigger.click();
    await expect.poll(() => page.getByText('Read file-39.ts').isVisible()).toBe(true);

    await page.locator('[data-slot="aui_thread-viewport"]').evaluate((el) => {
      el.scrollTop = 0;
    });
    const row = page.getByText('Read file-2.ts').first();
    await expect.poll(() => row.isVisible()).toBe(true);
    await row.hover();

    // The raised message must not paint over the composer's textarea.
    const box = (await page.getByRole('textbox').last().boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.tagName ?? null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit).toBe('TEXTAREA');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an update the dashboard does not know about does not break the thread', async () => {
  await start({
    prompts: [
      {
        match: () => true,
        updates: [
          { sessionUpdate: 'usage_update', tokens: 42 } as unknown as ThreadUpdate,
          ...reply('Still fine.'),
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('anything');
    await input.press('Control+Enter');
    await expect.poll(() => page.getByText('Still fine.').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an image renders wherever it arrives — a tool result, or what the agent said', async () => {
  await start();

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // How a screenshot actually arrives: the agent reads the file back, and
    // the adapter carries the image inline as the tool's result.
    stub.gateway.emit({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-shot',
      title: 'Read .playwright-cli/page.png',
      kind: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: PNG } }],
    } as ThreadUpdate);
    // And the other way one can arrive: in the message itself.
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Here is the page:' },
    } as ThreadUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', mimeType: 'image/png', data: PNG },
    } as ThreadUpdate);

    // Both of them, as loaded images rather than as parts that merely exist:
    // a broken src renders an <img> too.
    const images = page.locator(`img[src="data:image/png;base64,${PNG}"]`);
    await expect.poll(() => images.count()).toBe(2);
    await expect
      .poll(() =>
        images.evaluateAll((nodes) =>
          nodes.every((n) => (n as HTMLImageElement).naturalWidth === 200),
        ),
      )
      .toBe(true);

    // The prose it was said with is still prose, on its own line.
    await expect.poll(() => page.getByText('Here is the page:').isVisible()).toBe(true);
    await shoot(page, 'thread-images');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a background task reporting in is a row of its own, not the user talking', async () => {
  await start();

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // A background task reports in as a user-role message carrying XML for
    // the model. First a monitor's event, then a subagent's answer.
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      messageId: 'note-1',
      content: {
        type: 'text',
        text: [
          '<task-notification>',
          '<task-id>bnztwmmw5</task-id>',
          '<summary>Monitor event: "Atlas Obscura crawl progress"</summary>',
          '<event>2200/30321 ok=2193 bad=7 0.9/s eta 528m</event>',
          '</task-notification>',
        ].join('\n'),
      },
    } as ThreadUpdate);
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      messageId: 'note-2',
      content: {
        type: 'text',
        text: [
          '<task-notification>',
          '<task-id>agent-a1b</task-id>',
          '<status>completed</status>',
          '<summary>Agent "Check the crawler logs" finished</summary>',
          '<result>The 429s are all from one host, and the backoff is holding.</result>',
          '<usage><subagent_tokens>48200</subagent_tokens><tool_uses>6</tool_uses>',
          '<duration_ms>184000</duration_ms></usage>',
          '</task-notification>',
        ].join('\n'),
      },
    } as ThreadUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The crawl is being rate limited; the backoff is holding.' },
    } as ThreadUpdate);

    // Two rows, neither of them a message on the user's side of the thread.
    const rows = page.locator('[data-role="task-notification"]');
    await expect.poll(() => rows.count()).toBe(2);
    expect(await page.locator('[data-role="user"]').count()).toBe(0);
    expect(await page.getByText('<task-notification>').count()).toBe(0);
    expect(await page.getByText('<task-id>').count()).toBe(0);

    // A monitor exists to report its event, so the event is what is shown.
    await expect.poll(() => page.getByText('Monitor event:', { exact: false }).isVisible()).toBe(true);
    await expect.poll(() => page.getByText('2200/30321', { exact: false }).isVisible()).toBe(true);

    // A finished task's row folds its whole answer, which a click opens.
    const answer = page.getByText('The 429s are all from one host', { exact: false });
    expect(await answer.isVisible()).toBe(false);
    await expect.poll(() => page.getByText('48.2k tokens · 6 tool calls · 3m 4s').isVisible()).toBe(true);
    await page.getByText('Agent "Check the crawler logs" finished').click();
    await expect.poll(() => answer.isVisible()).toBe(true);
    await shoot(page, 'task-notification');

    // And the same after a reload, because the block replays as the same text.
    await page.reload();
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => rows.count()).toBe(2);
    expect(await page.getByText('<task-notification>').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a cut thread offers its full history at the top, and loads it in place', async () => {
  const said = Array.from({ length: 12 }, (_, i) => `exchange number ${i}`);
  // The gateway's log has lost the first two exchanges.
  await start({ dropped: 4 });
  for (const text of said) {
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `asking about ${text}` },
    } as ThreadUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `answering about ${text}` },
    } as ThreadUpdate);
  }

  const { page, errors, close } = await openPage(stub.url, `/boxes/${BOX.id}/threads/${BOX.threadId}`);
  try {
    // "exchange number 1" is also part of "exchange number 10".
    const exactly = (text: string) => page.getByText(text, { exact: true });
    const button = page.getByRole('button', { name: 'Load full history' });
    await expect.poll(() => button.isVisible()).toBe(true);
    expect(await exactly('asking about exchange number 1').count()).toBe(0);
    expect(await exactly('asking about exchange number 2').count()).toBe(1);

    // Up to the top by hand, where the reader finds the button.
    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    await viewport.hover();
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -2000);
        return viewport.evaluate((el) => el.scrollTop);
      })
      .toBe(0);
    await shoot(page, 'thread-cut', 'viewport');
    await button.click();

    await expect.poll(() => exactly('asking about exchange number 0').count()).toBe(1);
    expect(await button.count()).toBe(0);
    expect(await exactly('answering about exchange number 11').count()).toBe(1);
    // The view stays with the oldest messages.
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeLessThan(
      await viewport.evaluate((el) => el.clientHeight),
    );
    // The messages shown before are gone, not kept as a second branch.
    expect(await page.locator('.aui-branch-picker-root').count()).toBe(0);
    await shoot(page, 'thread-full', 'viewport');

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
