import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@server': fileURLToPath(new URL('./src/server', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
});
