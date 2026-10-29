import { type Kysely, sql } from 'kysely';

/** Reconciliation reads transactions by time window with keyset paging on (created_at, id). */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX ledger_transactions_created_idx ON ledger_transactions (created_at, id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS ledger_transactions_created_idx`.execute(db);
}
