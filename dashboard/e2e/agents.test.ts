import { afterAll, beforeAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { closeBrowser, openPage, shoot } from './browser.ts';
import {
  startStubOrchestrator,
  stubAgentSet,
  stubSession,
  type StubOrchestrator,
} from './stub-orchestrator.ts';

/**
 * Managing what the agent is configured with, in a real browser.
 *
 * The thing worth proving here is the two-set model, because it is the part a
 * screenshot cannot check: that the global set is offered to nobody as a
 * choice, that a named set can be picked when a box is created, and that the
 * editor shows the merge rather than only the half being edited.
 */

const DIST = resolve(import.meta.dirname, '../dist');

let stub: StubOrchestrator;

beforeAll(async () => {
  stub = await startStubOrchestrator(DIST, [stubSession()]);
  stub.state.agentSets = [
    stubAgentSet({
      agentsMd: '# House rules\n\nRun the tests.\n',
      items: [
        { kind: 'skill', name: 'review', content: '---\nname: review\n---\n', updatedAt: 0 },
        { kind: 'command', name: 'ship', content: 'Open a PR.\n', updatedAt: 0 },
      ],
    }),
    stubAgentSet({
      id: 'as1',
      name: 'Go projects',
      global: false,
      agentsMd: 'Use table-driven tests.\n',
      items: [
        { kind: 'skill', name: 'review', content: '---\nname: review\n---\ngo\n', updatedAt: 0 },
      ],
    }),
  ];
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the set list renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/agents', scheme);
    try {
      await expect.poll(() => page.getByText('Global').first().isVisible()).toBe(true);
      await expect.poll(() => page.getByText('applied to every box').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('Go projects').isVisible()).toBe(true);
      await shoot(page, `agent-sets-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`the set editor renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/agents/as1', scheme);
    try {
      await expect.poll(() => page.getByText('AGENTS.md').first().isVisible()).toBe(true);
      await expect.poll(() => page.getByText('Slash commands').isVisible()).toBe(true);
      await shoot(page, `agent-set-editor-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}

test('the global set cannot be deleted, and a named one can', async () => {
  const { page, close } = await openPage(stub.url, '/agents');
  try {
    await expect.poll(() => page.getByText('Go projects').isVisible()).toBe(true);
    // One delete button, next to the only set that has one.
    expect(await page.getByRole('button', { name: 'Delete' }).count()).toBe(1);
  } finally {
    await close();
  }
});

test('the editor shows the merge, and which of its items replaces a global one', async () => {
  const { page, close } = await openPage(stub.url, '/agents/as1');
  try {
    await expect.poll(() => page.getByText('What a box using this set gets').isVisible()).toBe(
      true,
    );
    // `review` is defined in both sets; the named one wins, and says so.
    await expect.poll(() => page.getByText('replaces the global one').isVisible()).toBe(true);
    // The merged commands come from the global set, which this one adds none to.
    await expect.poll(() => page.getByText('/ship').isVisible()).toBe(true);
  } finally {
    await close();
  }
});

test('the global editor offers no merge panel, because there is nothing to merge', async () => {
  const { page, close } = await openPage(stub.url, '/agents/global');
  try {
    await expect.poll(() => page.getByText('Everything here goes into every box.').isVisible()).toBe(
      true,
    );
    expect(await page.getByText('What a box using this set gets').count()).toBe(0);
  } finally {
    await close();
  }
});

test('a skill is written through the dialog and appears in the set', async () => {
  const { page, close } = await openPage(stub.url, '/agents/global');
  try {
    await expect.poll(() => page.getByText('Skills').first().isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Add' }).first().click();
    await page.getByLabel('Name').last().fill('bench');
    await page.getByLabel('SKILL.md').fill('---\nname: bench\ndescription: Benchmark.\n---\n');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => page.getByText('bench').first().isVisible()).toBe(true);
    expect(
      stub.state.agentSets[0]!.items.some((i) => i.kind === 'skill' && i.name === 'bench'),
    ).toBe(true);
  } finally {
    await close();
  }
});

test('a SKILL.md with no front matter is called out before it is saved', async () => {
  const { page, close } = await openPage(stub.url, '/agents/global');
  try {
    await expect.poll(() => page.getByText('Skills').first().isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Add' }).first().click();
    await page.getByLabel('SKILL.md').fill('Just some prose.');
    // The failure is silent inside the box, so the editor is the only place
    // it can be caught.
    await expect.poll(() => page.getByText('is not loaded at all').isVisible()).toBe(true);
  } finally {
    await close();
  }
});

test('a box is created against a named set, and the global one is not offered', async () => {
  const { page, close } = await openPage(stub.url, '/new');
  try {
    await expect.poll(() => page.getByLabel('Agent set').isVisible()).toBe(true);
    await page.getByLabel('Name').fill('a new box');
    await page.getByLabel('Agent set').click();
    // The global set applies either way, so listing it would suggest it were
    // a choice. Only "global only" and the named sets are offered.
    expect(await page.getByRole('option').allInnerTexts()).toEqual([
      'Global set only',
      'Go projects',
    ]);
  } finally {
    await close();
  }
});
