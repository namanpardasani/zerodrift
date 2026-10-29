import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dev: :5174, API calls proxied to the demo-shop backend on :3009. Prod: the backend serves the built files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, proxy: { '/api': 'http://localhost:3009' } },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom', globals: false },
});
