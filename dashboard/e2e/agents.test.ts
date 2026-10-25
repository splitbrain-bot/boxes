/** Browser tests for the agent set pages and the global and named set model. */

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/** The orchestrator that the tests in this file share. */
let stub: TestOrchestrator;

beforeAll(async () => {
  stub = await startOrchestrator();
});

beforeEach(async () => {
  // One test writes a skill, which would change what the next test is offered.
  await stub.agentSets(
    {
      agentsMd: '# House rules\n\nRun the tests.\n',
      items: [
        { name: 'review', content: '---\nname: review\n---\n' },
        { name: 'ship', content: '---\nname: ship\n---\n' },
      ],
      mcpServers: [
        { name: 'docs', url: 'https://docs.example.com/mcp', auth: 'none', headers: [] },
        { name: 'search', url: 'https://search.example.com/mcp', auth: 'none', headers: [] },
      ],
    },
    [
      {
        id: 'as1',
        name: 'Go projects',
        agentsMd: 'Use table-driven tests.\n',
        items: [{ name: 'review', content: '---\nname: review\n---\ngo\n' }],
        repos: [
          { url: 'https://github.com/example/go-skills', skills: ['bench', 'fuzz'] },
          { url: 'https://github.com/example/gone', skills: [], error: 'repository not found' },
        ],
        mcpServers: [
          { name: 'docs', url: 'https://docs.example.org/mcp', auth: 'none', headers: [] },
        ],
      },
    ],
  );
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
      await expect.poll(() => page.getByText('Skills').first().isVisible()).toBe(true);
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
    // Only the named set has a delete button.
    expect(await page.getByRole('button', { name: 'Delete' }).count()).toBe(1);
  } finally {
    await close();
  }
});

test('the editor shows the merge, and which of its items replaces a global one', async () => {
  const { page, close } = await openPage(stub.url, '/agents/as1');
  try {
    await expect.poll(() => page.getByText('Merged result').isVisible()).toBe(true);
    // Both sets define the review skill. The named set wins and says so.
    await expect
      .poll(() => page.getByText('replaces the global one').first().isVisible())
      .toBe(true);
    // The ship skill comes only from the global set.
    await expect.poll(() => page.getByText('review, ship').isVisible()).toBe(true);
  } finally {
    await close();
  }
});

test('the global editor offers no merge panel, because there is nothing to merge', async () => {
  const { page, close } = await openPage(stub.url, '/agents/global');
  try {
    await expect
      .poll(() => page.getByText('Everything here goes into every box.').isVisible())
      .toBe(true);
    expect(await page.getByText('Merged result').count()).toBe(0);
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
    const global = await stub.agentSet('global');
    expect(global.items.some((i) => i.name === 'bench')).toBe(true);
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
    // The agent ignores such a file without an error, so the editor is the
    // only place to catch the problem.
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
    // The global set always applies, so it is not an option.
    expect(await page.getByRole('option').allInnerTexts()).toEqual([
      'Global set only',
      'Go projects',
    ]);
  } finally {
    await close();
  }
});

test('the editor lists the repositories, their skills and a failed pull', async () => {
  const { page, close } = await openPage(stub.url, '/agents/as1');
  try {
    await expect
      .poll(() => page.getByText('https://github.com/example/go-skills').isVisible())
      .toBe(true);
    await expect.poll(() => page.getByText('bench, fuzz', { exact: true }).isVisible()).toBe(true);
    await expect.poll(() => page.getByText('repository not found').isVisible()).toBe(true);
    // The repository skills are part of what a box gets.
    await expect.poll(() => page.getByText('bench, fuzz, review, ship').isVisible()).toBe(true);
  } finally {
    await close();
  }
});

test('a repository URL that is not HTTPS is refused with the reason', async () => {
  const { page, close } = await openPage(stub.url, '/agents/as1');
  try {
    await page.getByLabel('Repository URL').fill('git@github.com:example/skills.git');
    await page
      .getByLabel('Repository URL')
      .locator('..')
      .getByRole('button', { name: 'Add' })
      .click();
    await expect.poll(() => page.getByText('url must be an HTTPS URL').isVisible()).toBe(true);
    expect((await stub.agentSet('as1')).repos).toHaveLength(2);
  } finally {
    await close();
  }
});

test('the editor lists the MCP servers, and the merge names the servers of the box', async () => {
  const { page, close } = await openPage(stub.url, '/agents/as1');
  try {
    await expect.poll(() => page.getByText('https://docs.example.org/mcp').isVisible()).toBe(true);
    // The skill review and the server docs both replace a global one.
    await expect.poll(() => page.getByText('replaces the global one').count()).toBe(2);
    await expect.poll(() => page.getByText('docs, search', { exact: true }).isVisible()).toBe(true);
  } finally {
    await close();
  }
});

test('an MCP server with a bearer token is written through the dialog, and the token stays secret', async () => {
  const { page, close } = await openPage(stub.url, '/agents/global');
  try {
    await expect.poll(() => page.getByText('MCP servers').first().isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Add' }).last().click();
    await page.getByLabel('Name').last().fill('tracker');
    await page.getByLabel('URL', { exact: true }).fill('https://mcp.example.com:8443/mcp');
    await page.getByRole('combobox', { name: 'Authentication' }).click();
    await page.getByRole('option', { name: 'Bearer token' }).click();
    expect(await page.getByRole('button', { name: 'Save' }).isDisabled()).toBe(true);
    await page.getByLabel('Token').fill('trk_0123456789abcdef');
    await shoot(page, 'mcp-server-dialog');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect
      .poll(() => page.getByText('https://mcp.example.com:8443/mcp').isVisible())
      .toBe(true);
    const tracker = (await stub.agentSet('global')).mcpServers.find((s) => s.name === 'tracker');
    expect(tracker?.auth).toBe('bearer');
    expect(tracker?.headers).toEqual([{ name: 'Authorization', value: '', secret: true }]);

    // The URL and the auth mode are fixed, and a save with an empty token field works.
    await page.getByRole('button', { name: 'Edit tracker' }).click();
    expect(await page.getByLabel('URL', { exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('combobox', { name: 'Authentication' }).isDisabled()).toBe(true);
    expect(await page.getByLabel('Token').inputValue()).toBe('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
  } finally {
    await close();
  }
});

test('custom headers of an MCP server are literal or secret', async () => {
  const { page, close } = await openPage(stub.url, '/agents/global');
  try {
    await expect.poll(() => page.getByText('MCP servers').first().isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Add' }).last().click();
    await page.getByLabel('Name').last().fill('internal');
    await page.getByLabel('URL', { exact: true }).fill('https://internal.example.com/mcp');
    await page.getByRole('combobox', { name: 'Authentication' }).click();
    await page.getByRole('option', { name: 'Custom headers' }).click();
    await page.getByLabel('Header 1 name').fill('X-Tenant');
    await page.getByLabel('Header 1 value').fill('engineering');
    await page.getByRole('button', { name: 'Add header' }).click();
    await page.getByLabel('Header 2 name').fill('X-Api-Key');
    await page.getByLabel('Header 2 value').fill('key-0123456789');
    await page.getByLabel('Header 2 is secret').check();
    await shoot(page, 'mcp-headers-dialog');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect
      .poll(() => page.getByText('https://internal.example.com/mcp').isVisible())
      .toBe(true);
    const internal = (await stub.agentSet('global')).mcpServers.find((s) => s.name === 'internal');
    expect(internal?.headers).toEqual([
      { name: 'X-Tenant', value: 'engineering', secret: false },
      { name: 'X-Api-Key', value: '', secret: true },
    ]);
  } finally {
    await close();
  }
});

test('an OAuth MCP server connects through the authorization server and shows its status', async () => {
  const { page, errors, close } = await openPage(stub.url, '/agents/global');
  try {
    // The route answers for the authorization server. It accepts the login at
    // once and redirects the browser to the dashboard.
    await page.route(`${stub.oauth.issuer}/authorize**`, async (route) => {
      const params = stub.oauth.authorize(route.request().url());
      await route.fulfill({
        status: 302,
        headers: { location: `${stub.url}/oauth/callback?${params}` },
      });
    });
    await expect.poll(() => page.getByText('MCP servers').first().isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Add' }).last().click();
    await page.getByLabel('Name').last().fill('remote');
    await page.getByLabel('URL', { exact: true }).fill(stub.oauth.mcpUrl);
    await page.getByRole('combobox', { name: 'Authentication' }).click();
    await page.getByRole('option', { name: 'OAuth' }).click();
    await expect.poll(() => page.getByText('Not connected').isVisible()).toBe(true);
    await shoot(page, 'mcp-oauth-dialog');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect.poll(() => new URL(page.url()).pathname).toBe('/agents/global');
    await expect.poll(() => page.getByText('Connected', { exact: true }).isVisible()).toBe(true);
    const remote = (await stub.agentSet('global')).mcpServers.find((s) => s.name === 'remote');
    expect(remote?.status).toBe('ok');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the callback page shows the error of a login that is not known', async () => {
  const { page, close } = await openPage(stub.url, '/oauth/callback?state=nope&code=x');
  try {
    await expect.poll(() => page.getByText('The login is unknown').isVisible()).toBe(true);
  } finally {
    await close();
  }
});
