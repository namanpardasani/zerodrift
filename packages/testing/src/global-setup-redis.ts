import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

let container: StartedTestContainer | undefined;

/** Vitest globalSetup: one real Redis for the run (TEST_REDIS_URL reuses an existing one). */
export async function setup(project: TestProject) {
  if (process.env.TEST_REDIS_URL) {
    project.provide('redisUrl', process.env.TEST_REDIS_URL);
    return;
  }
  container = await new GenericContainer('redis:7').withExposedPorts(6379).withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/)).start();
  project.provide('redisUrl', `redis://${container.getHost()}:${container.getMappedPort(6379)}`);
}

export async function teardown() {
  await container?.stop();
}
