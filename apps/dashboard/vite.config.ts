import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dev: the app runs on :5173 and proxies API calls to the dashboard-api on :3008 (same origin => no CORS).
// Prod: dashboard-api serves the built files itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3008', '/auth': 'http://localhost:3008' } },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom', globals: false },
});
