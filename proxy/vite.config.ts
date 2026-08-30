import { defineConfig } from 'vitest/config';

/**
 * The egress proxy has no dependencies beyond the standard library, so its
 * SSR bundle is the same single self-contained file the previous toolchain
 * produced.
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
