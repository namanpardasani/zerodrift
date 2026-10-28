import { type Kysely, sql } from 'kysely';

/** Transactional outbox for ledger events (transfer.completed). See @zerodrift/kafka. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE outbox (
      id             uuid PRIMARY KEY,
      aggregate_type text NOT NULL,
      aggregate_id   text NOT NULL,
      event_type     text NOT NULL,
      payload        jsonb NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      published_at   timestamptz,
      seq            bigserial
    )`.execute(db);
  await sql`CREATE INDEX outbox_unpublished_seq_idx ON outbox (seq) WHERE published_at IS NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS outbox`.execute(db);
}
