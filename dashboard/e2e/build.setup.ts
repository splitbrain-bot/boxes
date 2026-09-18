import { resolve } from 'node:path';
import { build } from 'vite';

/**
 * The e2e suite drives the production bundle, so it builds one before any
 * test runs. Testing the dev server instead would leave the shipped output
 * unproven.
 *
 * The suite serves it through the real orchestrator, which is told where the
 * bundle is when the app is built; see `bundleDir` in `orchestrator.ts`.
 */

/** The build output the suite drives. */
export const DIST = resolve(import.meta.dirname, '../dist');

export default async function setup(): Promise<void> {
  await build({ logLevel: 'warn' });
}
