import { defineConfig } from 'vitest/config';

/**
 * Build and test configuration of the file service. It builds as one Node
 * bundle in Vite's SSR mode, with its npm dependencies inside, so the box
 * image needs only the bundle.
 */
export default defineConfig({
  ssr: { noExternal: true },
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
