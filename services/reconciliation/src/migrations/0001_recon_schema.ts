import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // One row per reconciliation run: what was checked, the time window, and how it ended.
  await sql`
    CREATE TABLE recon_runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind        text NOT NULL CHECK (kind IN ('internal','external')),
      trigger     text NOT NULL CHECK (trigger IN ('scheduled','manual')),
      window_from timestamptz NOT NULL,
      window_to   timestamptz NOT NULL,
      -- clean: nothing found. mismatches: at least one finding. failed: could not read a data source
      -- (we never invent mismatches, or a clean bill of health, when we could not look).
      status      text NOT NULL CHECK (status IN ('running','clean','mismatches','failed')),
      summary     jsonb,
      error       text,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX recon_runs_kind_idx ON recon_runs (kind, started_at DESC)`.execute(db);

  await sql`
    CREATE TABLE recon_mismatches (
      id         bigserial PRIMARY KEY,
      run_id     uuid NOT NULL REFERENCES recon_runs(id),
      kind       text NOT NULL,
      severity   text NOT NULL CHECK (severity IN ('critical','warning','info')),
      reference  text NOT NULL,
      message    text NOT NULL,
      expected   jsonb,
      actual     jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX recon_mismatches_run_idx ON recon_mismatches (run_id)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS recon_mismatches`.execute(db);
  await sql`DROP TABLE IF EXISTS recon_runs`.execute(db);
}
