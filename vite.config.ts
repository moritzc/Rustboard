import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'esnext', chunkSizeWarningLimit: 5000 },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
