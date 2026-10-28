import { mergeConfig } from 'vitest/config';
import integration from './vitest.integration.mjs';

// Integration tests that also need a real Kafka broker.
export default mergeConfig(integration, {
  test: { globalSetup: ['../../packages/testing/src/global-setup-kafka.ts'] },
});
