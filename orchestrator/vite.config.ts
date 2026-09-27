import { defineConfig } from 'vitest/config';

/**
 * Vite and Vitest configuration of the orchestrator, built as a Node bundle in
 * SSR mode.
 *
 * SSR mode keeps every npm dependency external. The native better-sqlite3
 * binding needs that, because the runtime image installs it against its own
 * libc.
 */
export default defineConfig({
  build: {
    ssr: 'src/index.ts',
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'index.js', format: 'esm' },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
