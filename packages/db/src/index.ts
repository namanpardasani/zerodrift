import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool, types } from 'pg';

// Postgres BIGINT (OID 20) arrives as a string by default. Parse it to bigint so money never
// passes through a lossy JS number.
types.setTypeParser(20, (v) => BigInt(v));

export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max });
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
