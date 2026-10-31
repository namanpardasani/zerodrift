import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool, types } from 'pg';

// Postgres BIGINT (OID 20) arrives as a string by default. Parse it to bigint so money never
// passes through a lossy JS number.
types.setTypeParser(20, (v) => BigInt(v));

/**
 * Two safety nets so one stuck request can never wedge a whole service:
 *  - waiting for a free connection fails after 10s instead of waiting forever (a starved pool becomes
 *    visible errors and 5xx, which clients retry, instead of a silent hang);
 *  - Postgres kills a session that sits "idle in transaction" for 60s, releasing its row locks.
 */
export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max, connectionTimeoutMillis: 10_000, options: '-c idle_in_transaction_session_timeout=60000' });
}

export function createDb<DB>(pool: Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Run all pending migrations from a folder of TS/JS files (each exports up/down). */
export async function migrateToLatest(db: Kysely<any>, migrationFolder: string): Promise<string[]> {
  // A service may not have migrations yet (or the folder is only present in source, not dist).
  try {
    await fs.access(migrationFolder);
  } catch {
    return [];
  }
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

export { sql } from 'kysely';
export type { Kysely, Transaction } from 'kysely';

/**
 * Create `name` if it does not exist, using an admin connection to the server. Lets a service own
 * its database even when the Postgres volume predates it (init scripts only run on an empty volume).
 */
export async function ensureDatabase(adminUrl: string, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await pool.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    // Two replicas booting together can both pass the check; the loser gets duplicate_database.
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await pool.end();
  }
}
