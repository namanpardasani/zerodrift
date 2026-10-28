import { type Kysely, sql } from 'kysely';

/**
 * The publisher reads the outbox in `seq` order. created_at is the TRANSACTION start time, so two
 * concurrent transactions can commit in the opposite order of their created_at; a serial gives a
 * stable, gap-tolerant ordering to read by (per-aggregate order is guaranteed because one
 * aggregate's events are written by sequential transactions).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE outbox ADD COLUMN seq bigserial`.execute(db);
  await sql`DROP INDEX IF EXISTS outbox_unpublished_idx`.execute(db);
  await sql`CREATE INDEX outbox_unpublished_seq_idx ON outbox (seq) WHERE published_at IS NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS outbox_unpublished_seq_idx`.execute(db);
  await sql`ALTER TABLE outbox DROP COLUMN seq`.execute(db);
  await sql`CREATE INDEX outbox_unpublished_idx ON outbox (created_at, id) WHERE published_at IS NULL`.execute(db);
}
