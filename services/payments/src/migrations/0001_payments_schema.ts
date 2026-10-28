import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE merchants (
      id                uuid PRIMARY KEY,
      name              text NOT NULL,
      -- SHA-256 of the API key. Keys are 256 random bits, so a fast hash is safe (unlike passwords);
      -- the plaintext key is shown once at creation and never stored.
      api_key_hash      text NOT NULL UNIQUE,
      api_key_prefix    text NOT NULL,
      rate_limit_per_min integer NOT NULL DEFAULT 600 CHECK (rate_limit_per_min > 0),
      fee_bps           integer NOT NULL DEFAULT 250 CHECK (fee_bps BETWEEN 0 AND 10000),
      ledger_account_id uuid NOT NULL,
      status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at        timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE payments (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      merchant_id        uuid NOT NULL REFERENCES merchants(id),
      customer_id        text NOT NULL,
      customer_account_id uuid NOT NULL,
      amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
      currency           char(3) NOT NULL DEFAULT 'INR',
      status             text NOT NULL CHECK (status IN ('created','processing','succeeded','failed','partially_refunded','refunded')),
      reference          text,
      description        text,
      gateway_ref        text,
      idempotency_key    text NOT NULL,
      failure_reason     text,
      hold_id            uuid,
      ledger_tx_id       uuid,
      fee_bps            integer NOT NULL,
      fee_minor          bigint NOT NULL CHECK (fee_minor >= 0),
      -- refunds: "reserved" counts pending + succeeded (guards against over-refunding under
      -- concurrency); "refunded" counts only succeeded ones.
      refund_reserved_minor     bigint NOT NULL DEFAULT 0,
      fee_refund_reserved_minor bigint NOT NULL DEFAULT 0,
      refunded_minor            bigint NOT NULL DEFAULT 0,
      -- short exclusive lease so the request path and the recovery job do not work on the same
      -- payment at once (all steps are idempotent anyway; the lease just avoids wasted calls)
      lease_until        timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      version            bigint NOT NULL DEFAULT 0,
      UNIQUE (merchant_id, idempotency_key),
      CHECK (refund_reserved_minor <= amount_minor AND refunded_minor <= refund_reserved_minor)
    )`.execute(db);
  await sql`CREATE INDEX payments_stuck_idx ON payments (updated_at) WHERE status IN ('created','processing')`.execute(db);
  await sql`CREATE INDEX payments_merchant_idx ON payments (merchant_id, created_at DESC, id)`.execute(db);

  await sql`
    CREATE TABLE payment_events (
      id          bigserial PRIMARY KEY,
      payment_id  uuid NOT NULL REFERENCES payments(id),
      from_status text,
      to_status   text NOT NULL,
      reason      text,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, id)`.execute(db);

  await sql`
    CREATE TABLE idempotency_keys (
      merchant_id       uuid NOT NULL REFERENCES merchants(id),
      key               text NOT NULL,
      request_hash      text NOT NULL,
      status            text NOT NULL CHECK (status IN ('in_progress','completed')),
      resource_type     text,
      resource_id       uuid,
      response_status   integer,
      response_snapshot jsonb,
      created_at        timestamptz NOT NULL DEFAULT now(),
      expires_at        timestamptz NOT NULL,
      PRIMARY KEY (merchant_id, key)
    )`.execute(db);
  await sql`CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at)`.execute(db);

  await sql`
    CREATE TABLE refunds (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id       uuid NOT NULL REFERENCES payments(id),
      amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
      fee_refund_minor bigint NOT NULL CHECK (fee_refund_minor >= 0),
      status           text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
      reason           text,
      failure_reason   text,
      idempotency_key  text NOT NULL,
      ledger_tx_id     uuid,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX refunds_payment_idx ON refunds (payment_id)`.execute(db);
  await sql`CREATE INDEX refunds_pending_idx ON refunds (updated_at) WHERE status = 'pending'`.execute(db);

  // Transactional outbox: rows are written in the SAME transaction as the state change, and a
  // publisher (Phase 4) relays them to Kafka. `payload` holds the complete event envelope.
  await sql`
    CREATE TABLE outbox (
      id             uuid PRIMARY KEY,
      aggregate_type text NOT NULL,
      aggregate_id   text NOT NULL,
      event_type     text NOT NULL,
      payload        jsonb NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      published_at   timestamptz
    )`.execute(db);
  await sql`CREATE INDEX outbox_unpublished_idx ON outbox (created_at, id) WHERE published_at IS NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ['outbox', 'refunds', 'idempotency_keys', 'payment_events', 'payments', 'merchants']) {
    await sql`DROP TABLE IF EXISTS ${sql.raw(t)} CASCADE`.execute(db);
  }
}
