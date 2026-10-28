import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.mjs';

export default mergeConfig(base, {
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // The Ryuk reaper image is not needed: global-setup stops the container itself.
    env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
  },
});
