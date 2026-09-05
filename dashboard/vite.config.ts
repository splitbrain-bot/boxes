import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The dashboard is a standard Vite app: one build emits the JS and the CSS
 * together, and Tailwind compiles from source on every build rather than from
 * a committed artifact.
 *
 * The dev server proxies the orchestrator's own routes, so a browser pointed
 * at Vite sees the same single origin the deployment serves.
 */
const orchestrator = process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': { target: orchestrator, changeOrigin: true },
      '/healthz': { target: orchestrator, changeOrigin: true },
      '/ws': { target: orchestrator, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // One runner, two shapes of test. The unit project covers the
    // framework-free stores; the e2e project drives a real Chromium against
    // the real production bundle, which is why it builds first.
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['e2e/**/*.test.ts'],
          globalSetup: ['e2e/build.setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Every `expect.poll` here is waiting on a real browser doing real
          // work over a real socket, and vitest's own default for one is a
          // second. That is not a bound on "this is broken", it is a bound on
          // "this machine is busy" — which on a loaded CI box is the flake
          // these tests were reported as. The per-test timeout is what
          // actually stops a hung run.
          expect: { poll: { timeout: 15_000, interval: 50 } },
          // Chromium is a single shared resource here; parallel pages would
          // fight over it for no gain at this suite size.
          fileParallelism: false,
        },
      },
    ],
  },
});
