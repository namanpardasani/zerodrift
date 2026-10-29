import { mergeConfig } from 'vitest/config';
import integration from './vitest.integration.mjs';

// Integration tests that also need a real Kafka broker AND a real Redis.
export default mergeConfig(integration, {
  test: { globalSetup: ['../../packages/testing/src/global-setup-kafka.ts', '../../packages/testing/src/global-setup-redis.ts'] },
});
