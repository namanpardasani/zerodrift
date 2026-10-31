import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mjs';

// The invariant-checker tests run against a real Postgres (Testcontainers), like the services' tests.
// This package sits one level up from the services, hence the different relative path.
export default mergeConfig(base, {
  test: {
    globalSetup: ['../packages/testing/src/global-setup.ts'],
    env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
    fileParallelism: false,
  },
});
