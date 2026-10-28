import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUri: string;
  }
}

/**
 * Start ONE real Postgres for the whole run (each test file then creates its own database in it).
 * Set TEST_PG_ADMIN_URI to reuse an existing server instead (handy when Docker pulls are slow).
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
    .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
    .start();
  project.provide('pgAdminUri', container.getConnectionUri());
}

export async function teardown() {
  await container?.stop();
}
