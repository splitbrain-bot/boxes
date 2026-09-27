import { defineConfig } from 'vitest/config';

/**
 * Build and test configuration of the proxy. The proxy builds as a Node bundle
 * in Vite's SSR mode, which keeps npm dependencies external, so the runtime
 * image installs them and the bundle loads them at boot.
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
