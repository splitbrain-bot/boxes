import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { SessionUpdate } from '../src/stores/thread/acp-types.ts';
import type { Page } from 'playwright';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';
import type { GatewayScript } from './stub-gateway.ts';

/**
 * The live thread against a stub gateway speaking the agent side of ACP.
 *
 * Everything asserted here is protocol behaviour, not a private arrangement:
 * the stub answers session/new, session/load, session/prompt and
 * session/cancel the way the real gateway does.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const SESSION = stubSession();

/**
 * Turns a wheel a notch at a time, the way a hand arrives: a frame's worth of
 * pixels per event, with a moment between them. One event carrying the whole
 * distance is a jump, and nothing that reads a scroller should believe it.
 */
async function wheel(page: Page, dy: number, notches: number): Promise<void> {
  for (let i = 0; i < notches; i += 1) {
    await page.mouse.wheel(0, dy);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

/** A streamed assistant reply, in the chunks an adapter would send it. */
function reply(...texts: string[]): SessionUpdate[] {
  return texts.map(
    (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as SessionUpdate,
  );
}

/**
 * A real PNG, small enough to sit in the source: two bands and a diagonal, so
 * a screenshot of this test shows an image rather than a plausible rectangle.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAB4CAIAAAA48Cq8AAAB4UlEQVR42u3WwUkDARRF0SklpaVcS7GGrBRcGzIDF316ws02hJnD4x+Pbz63+5t0uePx9OMBKYGFl0JYbKmChZfOwfr8sqUE1llbeOlVWHgphMWWKlh4KYR1gZdHqVdhmS5VsPBSCIstVbDwUgjLUa8QlulSBQsvhbDYUgULL4WwHPUKYZkuVbDwUgiLLR3pr+MF1m/h5ZWAZbr007DwAostDcLCCyxHvTZhmS6w8NIgLLbAwkuDsBz1YJkuDcLCCyy2NAgLL7Ac9dqEZbrAwguszf/NFlh4gfUPeHnlYJkusPDSH4bFFlh4geWoF1imCyy8wGJLYOEFlqMeLNMlsPACiy2w8MLrdVjv95u+OmXL43oeWNdt4QUWXmCxBRZeeIHlqAfLdIGFF15gsQUWXmDhxRZYpgssvMASW2DhBZajHiyZLrDwAostsIQXWI56sEwXWMILLLbAwmuNF1iOerDY2uEFFl5gsbVjCyy8wMJrxxZYpgssvHZ4gcUWWHjt8ALLUQ+WdqYLLLzA0o4tsPACSztHPVimCyzt8AKLrcQWWHglvMDCK7EFFlsJL7DwSniBxVZiCyy8El5g4ZXYAouthBdYSniBpcQWWEp4gaXkqAdLyXSBpYQXWEpsgaWE1wex055aMLbECwAAAABJRU5ErkJggg==';

let stub: StubOrchestrator;

/** Starts a stub with the given gateway behaviour. */
async function start(script?: Partial<GatewayScript>): Promise<void> {
  stub = await startStubOrchestrator(DIST, [SESSION], script);
}

beforeEach(() => {
  stub = undefined as unknown as StubOrchestrator;
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

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const input = page.getByLabel('Message input');
    await input.fill('summarise the proxy');
    await input.press('Enter');

    // The first chunk shows before the last has been sent, which is what
    // progressive rendering means.
    await expect.poll(() => page.getByText('The proxy').isVisible()).toBe(true);
    expect(stub.gateway.prompts).toEqual(['summarise the proxy']);

    await expect
      .poll(() => page.getByText('resolved address.', { exact: false }).isVisible(), {
        timeout: 5000,
      })
      .toBe(true);
    // Markdown, not literal asterisks.
    expect(await page.locator('strong', { hasText: 'vets' }).count()).toBe(1);

    // The prompt itself is in the thread too.
    expect(await page.getByText('summarise the proxy').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a turn with nothing to show yet shows the spinner, and stops once it has', async () => {
  await start({
    // Long enough that the spinner can be read without racing the answer:
    // a detached element has no computed style, and the assertions below
    // would then be measuring the message that replaced it.
    prompts: [{ match: () => true, gapMs: 2500, updates: reply('Eventually.') }],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('think about it');
    await input.press('Enter');

    // The gap before the first chunk is the whole point of this indicator: it
    // is often the only thing on the screen, and it has to be visibly moving
    // rather than a page that has stopped repainting.
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

  const first = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => first.page.getByText('connected').isVisible()).toBe(true);
    const input = first.page.getByLabel('Message input');
    await input.fill('question one');
    await input.press('Enter');
    await expect.poll(() => first.page.getByText('First answer.').isVisible()).toBe(true);
  } finally {
    await first.close();
  }

  // A fresh browser gets the same thread back, because session/load replays
  // it as notifications.
  const second = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => second.page.getByText('First answer.').isVisible()).toBe(true);
    expect(await second.page.getByText('question one').isVisible()).toBe(true);
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

  const a = await openPage(stub.url, `/sessions/${SESSION.id}`);
  const b = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => a.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => b.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => stub.gateway.attached()).toBe(2);

    const input = a.page.getByLabel('Message input');
    await input.fill('ask once');
    await input.press('Enter');

    // The gateway broadcasts every update to every attached browser.
    await expect.poll(() => a.page.getByText('Shared answer.').isVisible()).toBe(true);
    await expect
      .poll(() => b.page.getByText('Shared answer.').isVisible(), { timeout: 5000 })
      .toBe(true);
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

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('take your time');
    await input.press('Enter');

    // While the turn runs the composer offers a stop instead of a send.
    const cancel = page.getByLabel('Stop generating');
    await expect.poll(() => cancel.isVisible()).toBe(true);

    await cancel.click();
    await expect.poll(() => cancel.isVisible()).toBe(false);
    expect(await page.getByLabel('Send message').isVisible()).toBe(true);

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
    } as SessionUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `answering about ${text}` },
    } as SessionUpdate);
  }

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    // The load is held, which is the box still starting as far as this
    // browser can tell: no history has arrived and none of it is on screen.
    await expect.poll(() => page.locator('[data-slot="thread-loading"]').isVisible()).toBe(true);

    // Nothing to type into and nothing that claims the thread is empty. The
    // greeting was the worse of the two: it says there is nothing here to
    // read, on arrival at a conversation, moments before being replaced.
    expect(await page.getByLabel('Message input').count()).toBe(0);
    expect(await page.getByText('How can I help you today?').count()).toBe(0);

    stub.gateway.releaseLoad();

    // The placeholder goes when the conversation arrives, and what arrives is
    // the whole of it: the first exchange and the last are on screen in the
    // same breath, not one render apart.
    await expect
      .poll(() => page.locator('[data-slot="thread-loading"]').count(), { timeout: 5000 })
      .toBe(0);
    expect(await page.getByText('asking about exchange number 0').count()).toBe(1);
    expect(await page.getByText('answering about exchange number 11').count()).toBe(1);
    // And now there is somewhere to type.
    expect(await page.getByLabel('Message input').isVisible()).toBe(true);

    // Opened at the end of the conversation, which is where a thread is read
    // from — not at whichever message the last render happened to leave.
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

test('the header steps aside while reading down, and returns on the way back up', async () => {
  // Long enough to scroll: the header can only give way to a conversation
  // that has somewhere to go.
  const paragraphs = Array.from({ length: 40 }, (_, i) => `paragraph number ${i} of the answer`);
  // A chunk at a time, so the thread spends a second following its own output
  // down the viewport — which is the other way the header used to move
  // without being asked.
  await start({
    prompts: [{ match: () => true, gapMs: 30, updates: reply(...paragraphs.map((p) => `${p}\n\n`)) }],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    const top = (): Promise<number> => viewport.evaluate((el) => el.scrollTop);
    /**
     * Whether the header is where a thumb reaches for it.
     *
     * Asked of the screen rather than of the element: the row is put away by
     * a parent that collapses to nothing around it, so the header keeps a box
     * of its own the whole time and `isVisible` would never say otherwise.
     */
    const inReach = (): Promise<boolean> =>
      page.evaluate(() => !!document.elementFromPoint(20, 10)?.closest('header'));

    const input = page.getByLabel('Message input');
    await input.fill('tell me at length');
    await input.press('Enter');

    // The turn's own scrolling moves nothing: the viewport is against its
    // bottom for the whole of one, and none of that is a reader's decision
    // about chrome.
    await expect.poll(() => page.getByLabel('Stop generating').count()).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      expect(await inReach()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Counted rather than seen: an assistant message below the fold is
    // render-skipped (globals.css), so it has no box to be visible in.
    await expect
      .poll(() => page.getByText('paragraph number 39').count(), { timeout: 10000 })
      .toBe(1);
    await expect
      .poll(() => page.getByLabel('Stop generating').count(), { timeout: 5000 })
      .toBe(0);

    // Reading from the top: the header is there to begin with.
    await viewport.hover();
    await page.mouse.wheel(0, -4000);
    await expect.poll(top).toBe(0);
    expect(await inReach()).toBe(true);

    // Down through the answer, and it gives way. A notch at a time, because
    // one 600-pixel event is a jump — which the header is right to ignore, and
    // which no hand produces.
    await wheel(page, 100, 8);
    await expect.poll(inReach).toBe(false);

    // Back up — by a flick, not all the way to the top, which is the whole
    // point: the header used to be recoverable only from the very top.
    await wheel(page, -100, 2);
    await expect.poll(inReach).toBe(true);
    expect(await top()).toBeGreaterThan(100);

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

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The header is the dashboard's, and the thread must not cover it: the
    // back link, the mode switcher and the info link all have to be
    // clickable, not painted over by a floating panel.
    const header = (await page.locator('header').boundingBox())!;
    const thread = (await page.locator('.aui-thread-root').boundingBox())!;
    expect(header.height).toBeGreaterThan(0);
    expect(thread.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(await page.getByLabel('Back to sessions').isVisible()).toBe(true);
    expect(await page.getByLabel('Session details and controls').isVisible()).toBe(true);
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
          { sessionUpdate: 'usage_update', tokens: 42 } as unknown as SessionUpdate,
          ...reply('Still fine.'),
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('anything');
    await input.press('Enter');
    await expect.poll(() => page.getByText('Still fine.').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an image renders wherever it arrives — a tool result, or what the agent said', async () => {
  await start();

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
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
    } as SessionUpdate);
    // And the other way one can arrive: in the message itself.
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Here is the page:' },
    } as SessionUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', mimeType: 'image/png', data: PNG },
    } as SessionUpdate);

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
    expect(await page.getByText('Here is the page:').isVisible()).toBe(true);
    await shoot(page, 'thread-images');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
