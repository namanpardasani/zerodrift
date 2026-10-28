import { mergeConfig } from 'vitest/config';
import base from './vitest.config.mjs';

// For services whose tests need a real Postgres (Testcontainers) and run several services in-process.
export default mergeConfig(base, {
  test: {
    globalSetup: ['../../packages/testing/src/global-setup.ts'],
    // Ryuk (the container reaper image) is not needed: global-setup stops the container itself.
    env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
    // Services share one Postgres; run files one after another to keep timing-sensitive tests stable.
    fileParallelism: false,
  },
});
