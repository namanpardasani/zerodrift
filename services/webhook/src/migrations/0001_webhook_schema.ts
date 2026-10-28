import { createInboxTable } from '@zerodrift/kafka';
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE webhook_endpoints (
      id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      merchant_id                uuid NOT NULL,
      url                        text NOT NULL,
      description                text,
      -- which event types this endpoint wants; '*' means all
      event_types                text[] NOT NULL DEFAULT ARRAY['*'],
      -- AES-256-GCM encrypted signing secret (we must read it back to sign, so not hashed)
      secret_encrypted           text NOT NULL,
      -- after a rotation the old secret keeps signing alongside the new one until it expires
      previous_secret_encrypted  text,
      previous_secret_expires_at timestamptz,
      active                     boolean NOT NULL DEFAULT true,
      created_at                 timestamptz NOT NULL DEFAULT now(),
      updated_at                 timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX webhook_endpoints_merchant_idx ON webhook_endpoints (merchant_id)`.execute(db);

  // The event as received from Kafka, kept so deliveries can be replayed long after the fact.
  await sql`
    CREATE TABLE webhook_events (
      event_id    uuid PRIMARY KEY,
      merchant_id uuid NOT NULL,
      event_type  text NOT NULL,
      payload     jsonb NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX webhook_events_merchant_idx ON webhook_events (merchant_id, created_at DESC)`.execute(db);

  // One row per (event, endpoint): the UNIQUE constraint is what guarantees we plan exactly ONE
  // delivery per endpoint however many times the event is redelivered by Kafka.
  //   pending   = waiting for its next attempt (next_attempt_at; also the crash-recovery lease)
  //   succeeded = a 2xx was received
  //   dead      = retries exhausted (the dead-letter state); replayable by hand
  await sql`
    CREATE TABLE webhook_deliveries (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id           uuid NOT NULL REFERENCES webhook_events(event_id),
      endpoint_id        uuid NOT NULL REFERENCES webhook_endpoints(id),
      status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','dead')),
      attempt_count      integer NOT NULL DEFAULT 0,
      -- attempts since creation or the last manual replay; the dead-letter limit applies to this
      cycle_attempts     integer NOT NULL DEFAULT 0,
      replay_count       integer NOT NULL DEFAULT 0,
      next_attempt_at    timestamptz NOT NULL DEFAULT now(),
      last_response_code integer,
      last_error         text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (event_id, endpoint_id)
    )`.execute(db);
  await sql`CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending'`.execute(db);
  await sql`CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC)`.execute(db);

  // The delivery log: every single HTTP attempt.
  await sql`
    CREATE TABLE webhook_attempts (
      id               bigserial PRIMARY KEY,
      delivery_id      uuid NOT NULL REFERENCES webhook_deliveries(id),
      attempt_no       integer NOT NULL,
      started_at       timestamptz NOT NULL,
      duration_ms      integer NOT NULL,
      response_code    integer,
      error            text,
      response_snippet text,
      UNIQUE (delivery_id, attempt_no)
    )`.execute(db);

  await createInboxTable(db); // processed_events: makes the Kafka consumer idempotent
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ['webhook_attempts', 'webhook_deliveries', 'webhook_events', 'webhook_endpoints', 'processed_events']) {
    await sql`DROP TABLE IF EXISTS ${sql.raw(t)} CASCADE`.execute(db);
  }
}
