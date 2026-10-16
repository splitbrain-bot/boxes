import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration of the conformance suite of the runtimes.
 *
 * The suite runs against a real runtime with the real box image, so the
 * normal test run leaves it out. A start of a box takes seconds, and the
 * first pull of the box image takes minutes, hence the long timeouts.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.conformance.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
