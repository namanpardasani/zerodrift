import { randomUUID } from 'node:crypto';
import { createPool } from '@zerodrift/db';
import { inject } from 'vitest';

// Values the global setups hand to tests (see global-setup.ts / global-setup-kafka.ts).
declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUri: string;
    kafkaBrokers: string;
  }
}

/** Create a fresh empty database in the shared test Postgres and return its connection URL. */
export async function createTestDatabase(): Promise<{ url: string; name: string }> {
  const adminUri = inject('pgAdminUri');
  const name = `t_${randomUUID().replace(/-/g, '')}`;
  const admin = createPool(adminUri, 1);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUri);
  url.pathname = `/${name}`;
  return { url: url.toString(), name };
}

/** Poll `fn` until it returns a truthy value or the timeout passes. For eventually-consistent assertions. */
export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 10_000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export { inject };
