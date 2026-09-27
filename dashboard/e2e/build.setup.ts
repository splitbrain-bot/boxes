import { build } from 'vite';

/** Builds the production bundle before any test runs, so the suite tests what ships. */
export default async function setup(): Promise<void> {
  await build({ logLevel: 'warn' });
}
