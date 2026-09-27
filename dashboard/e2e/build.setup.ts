import { resolve } from 'node:path';
import { build } from 'vite';

/** The build output the suite drives. */
export const DIST = resolve(import.meta.dirname, '../dist');

/** Builds the production bundle before any test runs, so the suite tests what ships. */
export default async function setup(): Promise<void> {
  await build({ logLevel: 'warn' });
}
