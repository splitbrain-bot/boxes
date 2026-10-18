import { defineConfig } from 'vitest/config';

/**
 * Build and test configuration of the file service. The build puts the service and its npm dependencies into one Node
 * bundle, so the box image needs only the bundle.
 */
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: 'src/main.ts',
    target: 'node26',
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
