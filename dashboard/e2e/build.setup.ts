import { build } from 'vite';

/**
 * The e2e suite drives the production bundle, so it builds one before any
 * test runs. Testing the dev server instead would leave the shipped output
 * unproven.
 */
export default async function setup(): Promise<void> {
  await build({ logLevel: 'warn' });
}
