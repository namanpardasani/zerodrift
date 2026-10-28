import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Shared Vitest config. Each workspace runs `vitest run --config ../../vitest.config.ts`.
// SWC is required because NestJS relies on decorator metadata, which esbuild does not emit.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000, // Testcontainers start real Postgres/Kafka
  },
});
