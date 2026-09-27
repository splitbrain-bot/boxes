import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The orchestrator the dev server proxies the API, health and WebSocket
 * routes to, so the dev page has the single origin of a deployment.
 */
const orchestrator = process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:3000';

/** Vite and Vitest configuration of the dashboard. */
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
    // Stated, because the orchestrator and the service worker name this
    // directory and cache it for good. Every name in it carries a content
    // hash.
    assetsDir: 'assets',
  },
  test: {
    // The e2e project drives a real Chromium against the production bundle,
    // so its global setup builds the bundle first.
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
          // Vitest's default poll timeout of one second fails on a busy CI
          // machine. The test timeout stops a hung run.
          expect: { poll: { timeout: 15_000, interval: 50 } },
          // Parallel files would compete for Chromium for no gain.
          fileParallelism: false,
        },
      },
    ],
  },
});
