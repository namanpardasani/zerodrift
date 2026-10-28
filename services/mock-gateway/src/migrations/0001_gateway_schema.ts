import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // One row per charge `reference` (the payment id). The reference is the gateway-side idempotency
  // key: asking twice never charges twice, and the outcome is decided exactly once.
  await sql`
    CREATE TABLE gateway_charges (
      reference     text PRIMARY KEY,
      amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
      currency      char(3) NOT NULL,
      status        text NOT NULL CHECK (status IN ('succeeded','failed','cancelled','voided')),
      failure_code  text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX gateway_charges_created_idx ON gateway_charges (created_at)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS gateway_charges`.execute(db);
}
