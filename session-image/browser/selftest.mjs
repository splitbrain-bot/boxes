// Proves the browser in this image starts, renders and screenshots.
//
// Run at build time as the agent, and available afterwards for the same
// purpose: `node /usr/local/lib/node_modules/@boxes/browser/selftest.mjs`.
// Uses setContent rather than a URL, so it exercises the browser without
// depending on the egress path.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './index.mjs';

const PNG_MAGIC = '89504e47';

const dir = await mkdtemp(join(tmpdir(), 'boxes-browser-selftest-'));
const shot = join(dir, 'shot.png');
const { browser, page } = await launch();
let version = 'chromium';
try {
  version = `chromium ${browser.version()}`;
  await page.setContent('<h1>boxes</h1>');
  const text = await page.locator('h1').innerText();
  if (text !== 'boxes') throw new Error(`rendered the wrong content: ${text}`);
  await page.screenshot({ path: shot });
  const head = (await readFile(shot)).subarray(0, 4).toString('hex');
  if (head !== PNG_MAGIC) throw new Error(`not a PNG: magic was ${head}`);
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`ok: ${version}`);
