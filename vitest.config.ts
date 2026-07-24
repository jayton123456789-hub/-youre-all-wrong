import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@server': fileURLToPath(new URL('./src/server', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
