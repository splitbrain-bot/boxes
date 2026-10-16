import type { DeploymentImages } from '../../shared/types.ts';
import { runtime } from './runtime/runtime.ts';

/** Reports which build of each of the deployment's three images is running. */

/** How long one reading is served before the runtime is asked again, in ms. */
const CACHE_MS = 60_000;

/** The last reading and when it was taken, or null before the first. */
let cached: { at: number; images: DeploymentImages } | null = null;

/** Test seam: forget the cached reading. */
export function resetImagesForTests(): void {
  cached = null;
}

/**
 * Returns all three images, from a cache that lasts CACHE_MS. Every open tab
 * polls the health probe that calls this, hence the cache.
 */
export async function deploymentImages(): Promise<DeploymentImages> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.images;
  cached = { at: now, images: await runtime().deploymentImages() };
  return cached.images;
}
