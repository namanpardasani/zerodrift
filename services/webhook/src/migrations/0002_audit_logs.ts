import { type Kysely, sql } from 'kysely';

/**
 * Who did what, when, from where. Written in the SAME transaction as the action it records (so an
 * action cannot succeed without its audit row), and APPEND-ONLY: a trigger rejects UPDATE/DELETE, so
 * even a compromised application account cannot quietly rewrite history.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE audit_logs (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor          text NOT NULL,            -- 'merchant:<id>' | 'admin' | 'system'
      merchant_id    uuid,
      action         text NOT NULL,            -- e.g. payment.created, refund.created
      resource_type  text NOT NULL,
      resource_id    text,
      ip             text,
      correlation_id text,
      details        jsonb,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC)`.execute(db);
  await sql`CREATE INDEX audit_logs_merchant_idx ON audit_logs (merchant_id, created_at DESC)`.execute(db);
  await sql`
    CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
    END $$ LANGUAGE plpgsql`.execute(db);
  await sql`CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable()`.execute(db);
  await sql`CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable()`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS audit_logs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS audit_logs_immutable`.execute(db);
}
