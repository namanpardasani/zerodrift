import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | undefined;

/**
 * Vitest globalSetup: start ONE real Postgres for the whole test run; each test file then creates
 * its own database inside it (see createTestDatabase). Set TEST_PG_ADMIN_URI to reuse an existing
 * server instead of starting a container (handy when image pulls are slow).
 */
export async function setup(project: TestProject) {
  if (process.env.TEST_PG_ADMIN_URI) {
    project.provide('pgAdminUri', process.env.TEST_PG_ADMIN_URI);
    return;
  }
  container = await new PostgreSqlContainer('postgres:17-bookworm')
    .withUsername('test')
    .withPassword('test')
    .withDatabase('postgres')
    .withCommand(['postgres', '-c', 'max_connections=400', '-c', 'fsync=off'])
    .start();
  project.provide('pgAdminUri', container.getConnectionUri());
}

export async function teardown() {
  await container?.stop();
}
