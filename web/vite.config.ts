import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

// Serve the web app locally and proxy room APIs and live audio WebSockets to the API
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5185,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3110', ws: true } }
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: [...configDefaults.exclude, 'e2e/**']
  }
});
