import { defineConfig } from 'vitest/config';

/**
 * One build system for the whole repository: the proxy is a Node bundle, so it
 * builds through Vite's SSR mode rather than a second tool.
 *
 * `ssr` leaves node builtins and every npm dependency external. The proxy's
 * one dependency is mockttp, which drags in native and wasm-backed modules
 * that a bundler has no business flattening, so the runtime image installs
 * production dependencies and the bundle resolves them at boot.
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
