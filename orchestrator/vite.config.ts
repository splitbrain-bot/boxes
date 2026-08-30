import { defineConfig } from 'vitest/config';

/**
 * One build system for the whole repository: the orchestrator is a Node
 * bundle, so it builds through Vite's SSR mode rather than a second tool.
 *
 * `ssr` leaves node builtins and every npm dependency external, which is what
 * a server bundle wants and what the native better-sqlite3 binding requires:
 * the runtime image installs production dependencies against its own libc and
 * the bundle resolves them from node_modules at boot.
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
