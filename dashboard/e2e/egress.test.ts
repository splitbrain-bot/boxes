/** Browser tests for the egress profile pages, the profile select of the box form and the box details page. */

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { BoxDetail, EgressProfileDetail, EgressProfileSummary } from '../../shared/types.ts';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';

/** The id of the box that the tests drive. */
const ID = DEFAULT_BOX.id;

/** The orchestrator that the tests in this file share. */
let stub: TestOrchestrator;

/**
 * Sends one request to the API of the orchestrator, as the setup of a test.
 *
 * @param method The HTTP method.
 * @param path The path of the API endpoint.
 * @param body The JSON body, if any.
 * @returns The decoded JSON answer, or undefined for an empty answer.
 */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${stub.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * Lists the egress profiles.
 *
 * @returns The profiles, the default profile first.
 */
function profiles(): Promise<EgressProfileSummary[]> {
  return call('GET', '/api/egress-profiles');
}

/**
 * Creates an egress profile.
 *
 * @param name The name of the profile.
 * @param hosts The host patterns of the profile.
 * @returns The new profile.
 */
function createProfile(name: string, hosts: string[] = []): Promise<EgressProfileDetail> {
  return call('POST', '/api/egress-profiles', { name, hosts });
}

/**
 * Reads the id of the default profile.
 *
 * @returns The id.
 */
async function defaultId(): Promise<string> {
  const found = (await profiles()).find((p) => p.isDefault);
  if (!found) throw new Error('no default profile');
  return found.id;
}

beforeAll(async () => {
  stub = await startOrchestrator();
});

beforeEach(async () => {
  // Each test starts with only the default profile. A delete moves the boxes to the default profile.
  for (const profile of await profiles()) {
    if (!profile.isDefault) await call('DELETE', `/api/egress-profiles/${profile.id}`);
  }
  stub.denials.clear();
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the profile list renders in ${scheme}`, async () => {
    await createProfile('Package registries', ['registry.npmjs.org']);
    const { page, errors, close } = await openPage(stub.url, '/egress', scheme);
    try {
      await expect.poll(() => page.getByText('Package registries').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('open · default · 1 box').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('closed · 0 boxes').isVisible()).toBe(true);
      await shoot(page, `egress-profiles-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`the profile editor renders in ${scheme}`, async () => {
    const created = await createProfile('Package registries', [
      'registry.npmjs.org',
      '*.pythonhosted.org',
    ]);
    const { page, errors, close } = await openPage(stub.url, `/egress/${created.id}`, scheme);
    try {
      await expect
        .poll(() => page.getByRole('textbox', { name: 'Hosts' }).inputValue())
        .toBe('registry.npmjs.org\n*.pythonhosted.org');
      await shoot(page, `egress-profile-editor-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`the egress card of the box details renders in ${scheme}`, async () => {
    stub.denials.set(ID, [
      { host: 'evil.example.com', port: 443, category: 'allowlist', count: 3, lastAt: Date.now() },
      { host: '2001:db8::1', port: 22, category: 'port', count: 1, lastAt: Date.now() },
    ]);
    const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/info`, scheme);
    try {
      await expect.poll(() => page.getByText('evil.example.com:443').isVisible()).toBe(true);
      await shoot(page, `egress-info-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}

test('the default profile cannot be deleted, and a created one can', async () => {
  const { page, errors, close } = await openPage(stub.url, '/egress');
  try {
    await expect.poll(() => page.getByText('Default', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Delete' }).count()).toBe(0);

    await page.getByRole('button', { name: 'New profile' }).click();
    await page.getByLabel('Name of the new profile').fill('Closed for tests');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/egress\/ep[0-9a-f]+$/);
    await expect.poll(() => page.getByLabel('Name').inputValue()).toBe('Closed for tests');

    await page.getByRole('link', { name: 'Egress profiles' }).click();
    await page.waitForURL('**/egress');
    await expect.poll(() => page.getByText('Closed for tests').isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Delete' }).count()).toBe(1);

    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => page.getByText('Closed for tests').count()).toBe(0);
    expect((await profiles()).map((p) => p.name)).toEqual(['Default']);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the editor saves the name, the mode and the hosts', async () => {
  const created = await createProfile('Draft');
  const { page, errors, close } = await openPage(stub.url, `/egress/${created.id}`);
  try {
    await expect.poll(() => page.getByLabel('Name').inputValue()).toBe('Draft');
    expect(await page.getByRole('button', { name: 'Saved' }).isDisabled()).toBe(true);

    await page.getByLabel('Name').fill('Registries');
    await page.getByRole('combobox', { name: 'Mode' }).click();
    await page.getByRole('option', { name: /^Open/ }).click();
    await page
      .getByRole('textbox', { name: 'Hosts' })
      .fill('Registry.npmjs.org\n\n*.pythonhosted.org\n');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => page.getByRole('button', { name: 'Saved' }).isVisible()).toBe(true);
    // The fields show what the orchestrator stored.
    expect(await page.getByRole('textbox', { name: 'Hosts' }).inputValue()).toBe(
      'registry.npmjs.org\n*.pythonhosted.org',
    );
    expect(await page.getByRole('heading', { name: 'Registries' }).isVisible()).toBe(true);
    const stored = await call<EgressProfileDetail>('GET', `/api/egress-profiles/${created.id}`);
    expect(stored).toMatchObject({
      name: 'Registries',
      open: true,
      hosts: ['registry.npmjs.org', '*.pythonhosted.org'],
    });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the editor shows the reason when the orchestrator refuses a host', async () => {
  const created = await createProfile('Draft', ['registry.npmjs.org']);
  const { page, close } = await openPage(stub.url, `/egress/${created.id}`);
  try {
    await expect
      .poll(() => page.getByRole('textbox', { name: 'Hosts' }).inputValue())
      .toBe('registry.npmjs.org');
    await page.getByRole('textbox', { name: 'Hosts' }).fill('api.*.com');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect
      .poll(() => page.getByText('api.*.com may only use a leading *. wildcard').isVisible())
      .toBe(true);
    // The typed text stays, so the user can correct it.
    expect(await page.getByRole('textbox', { name: 'Hosts' }).inputValue()).toBe('api.*.com');
    const stored = await call<EgressProfileDetail>('GET', `/api/egress-profiles/${created.id}`);
    expect(stored.hosts).toEqual(['registry.npmjs.org']);
  } finally {
    await close();
  }
});

test('the box form preselects the default profile and sends it with the box', async () => {
  await createProfile('Closed for tests');
  const { page, errors, close } = await openPage(stub.url, '/new');
  try {
    const select = page.getByRole('combobox', { name: 'Egress profile' });
    await expect.poll(() => select.textContent()).toBe('Default');
    await select.click();
    expect(await page.getByRole('option').allInnerTexts()).toEqual(['Default', 'Closed for tests']);
    await page.getByRole('option', { name: 'Default' }).click();

    await page.getByLabel('Name').fill('box with a profile');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect.poll(() => stub.boxCalls.length).toBe(1);
    expect(stub.boxCalls[0]).toMatchObject({
      name: 'box with a profile',
      egressProfile: await defaultId(),
    });
    await page.waitForURL(/\/boxes\/[0-9a-f]{8}\/threads\/[^/]+$/);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the box details page changes the profile of the box', async () => {
  const closed = await createProfile('Closed for tests');
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/info`);
  try {
    const select = page.getByRole('combobox', { name: 'Egress profile' });
    await expect.poll(() => select.textContent()).toBe('Default');

    const put = page.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().endsWith(`/api/boxes/${ID}/egress-profile`),
    );
    await select.click();
    await page.getByRole('option', { name: 'Closed for tests' }).click();
    expect((await put).postDataJSON()).toEqual({ egressProfile: closed.id });

    await expect.poll(() => select.textContent()).toBe('Closed for tests');
    const box = await call<BoxDetail>('GET', `/api/boxes/${ID}`);
    expect(box).toMatchObject({
      egressProfileId: closed.id,
      egressProfileName: 'Closed for tests',
    });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the box details page lists the hosts that the profile refused', async () => {
  stub.denials.set(ID, [
    { host: 'evil.example.com', port: 443, category: 'allowlist', count: 3, lastAt: Date.now() },
    { host: '2001:db8::1', port: 22, category: 'port', count: 1, lastAt: Date.now() },
  ]);
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/info`);
  try {
    await expect.poll(() => page.getByText('evil.example.com:443').isVisible()).toBe(true);
    // An IPv6 address is in brackets, so the port stays apart from it.
    await expect.poll(() => page.getByText('[2001:db8::1]:22').isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/^3× · /).isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/^1× · /).isVisible()).toBe(true);
    expect(await page.getByText('None.').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the box details page says when the profile refused no host', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/info`);
  try {
    await expect.poll(() => page.getByText('Refused hosts').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('None.').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
