import { defineConfig } from 'vitest/config';

/**
 * Build and test configuration of the proxy.
 *
 * Vite builds the proxy as a Node bundle in SSR mode. SSR mode keeps the npm
 * dependencies external, so the runtime image must install them.
 */
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'main.js', format: 'esm' },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
