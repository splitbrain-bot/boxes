import { defineConfig } from 'vitest/config';

/**
 * Build and test configuration of the file service. It builds as one Node
 * bundle in Vite's SSR mode. It has no npm dependencies, so the box image
 * needs only the bundle.
 */
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'main.mjs', format: 'esm', banner: '#!/usr/bin/env node' },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
