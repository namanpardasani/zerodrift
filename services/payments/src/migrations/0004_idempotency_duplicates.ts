import { type Kysely, sql } from 'kysely';

/**
 * Count the duplicate requests an idempotency key absorbed. Pure observability (the operator console shows
 * "a duplicate request was absorbed" on the payment): it changes no behaviour of the key.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE idempotency_keys ADD COLUMN duplicates_absorbed integer NOT NULL DEFAULT 0`.execute(db);
  await sql`ALTER TABLE idempotency_keys ADD COLUMN last_duplicate_at timestamptz`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE idempotency_keys DROP COLUMN last_duplicate_at`.execute(db);
  await sql`ALTER TABLE idempotency_keys DROP COLUMN duplicates_absorbed`.execute(db);
}
