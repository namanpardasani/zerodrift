import { type Kysely, sql } from 'kysely';

/**
 * Ledger schema. Balance convention for EVERY account: balance = credits - debits.
 * So a customer wallet with money in it has a positive balance, and the "gateway_clearing" system
 * account (the outside world that money came from) goes NEGATIVE as users top up. Because every
 * transaction has debits == credits, the sum of all balances in the system is always exactly 0.
 * That single number is the strongest "no money created or destroyed" check we have.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE accounts (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type     text NOT NULL CHECK (owner_type IN ('customer','merchant','system')),
      owner_id       text NOT NULL,
      currency       char(3) NOT NULL DEFAULT 'INR',
      type           text NOT NULL CHECK (type IN ('wallet','gateway_clearing','fees','suspense')),
      status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
      allow_negative boolean NOT NULL DEFAULT false,
      created_at     timestamptz NOT NULL DEFAULT now(),
      -- get-or-create semantics: one account per (owner, type, currency)
      UNIQUE (owner_type, owner_id, type, currency),
      -- target of the composite FK from journal_entries: an entry's currency must match its account
      UNIQUE (id, currency)
    )`.execute(db);

  // available + held = total owned; held money is reserved by active holds and cannot be spent.
  await sql`
    CREATE TABLE account_balances (
      account_id      uuid PRIMARY KEY REFERENCES accounts(id),
      available_minor bigint NOT NULL DEFAULT 0,
      held_minor      bigint NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
      version         bigint NOT NULL DEFAULT 0
    )`.execute(db);

  // Last line of defence for "no negative balances": even a buggy code path cannot overdraw a
  // normal account because the UPDATE itself is rejected.
  await sql`
    CREATE FUNCTION enforce_non_negative_balance() RETURNS trigger AS $$
    BEGIN
      IF NEW.available_minor < 0 AND NOT (SELECT allow_negative FROM accounts WHERE id = NEW.account_id) THEN
        RAISE EXCEPTION 'account % would go below zero', NEW.account_id USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`.execute(db);
  await sql`
    CREATE TRIGGER account_balances_non_negative
      BEFORE INSERT OR UPDATE ON account_balances
      FOR EACH ROW EXECUTE FUNCTION enforce_non_negative_balance()`.execute(db);

  await sql`
    CREATE TABLE ledger_transactions (
      id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type                    text NOT NULL CHECK (type IN ('payment','transfer','refund','topup','fee','reversal')),
      reference_id            text,
      idempotency_key         text NOT NULL UNIQUE,
      request_hash            text NOT NULL,
      status                  text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
      -- at most one reversal per transaction; the UNIQUE index makes double refunds impossible
      reverses_transaction_id uuid UNIQUE REFERENCES ledger_transactions(id),
      response                jsonb,
      created_at              timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE journal_entries (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
      account_id     uuid NOT NULL,
      direction      text NOT NULL CHECK (direction IN ('debit','credit')),
      amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
      currency       char(3) NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (account_id, currency) REFERENCES accounts(id, currency)
    )`.execute(db);
  await sql`CREATE INDEX journal_entries_account_idx ON journal_entries (account_id, created_at DESC, id)`.execute(db);
  await sql`CREATE INDEX journal_entries_tx_idx ON journal_entries (transaction_id)`.execute(db);

  // Append-only: corrections are reversing entries, never UPDATE/DELETE.
  await sql`
    CREATE FUNCTION journal_entries_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'journal_entries is append-only (% not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
    END $$ LANGUAGE plpgsql`.execute(db);
  await sql`
    CREATE TRIGGER journal_entries_no_update_delete
      BEFORE UPDATE OR DELETE ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION journal_entries_immutable()`.execute(db);
  await sql`
    CREATE TRIGGER journal_entries_no_truncate
      BEFORE TRUNCATE ON journal_entries
      FOR EACH STATEMENT EXECUTE FUNCTION journal_entries_immutable()`.execute(db);

  // debits == credits per transaction, checked by the DATABASE at COMMIT time.
  // Why a DEFERRED constraint trigger: entries of one transaction are inserted one by one, so the
  // books are only balanced once all rows are in. Deferring the check to commit lets us insert
  // freely inside the transaction but makes it impossible to COMMIT an unbalanced one, no matter
  // which code path (or manual SQL) wrote the rows. The application validates first for good error
  // messages; this is the safety net.
  await sql`
    CREATE FUNCTION assert_transaction_balanced() RETURNS trigger AS $$
    DECLARE diff numeric;
    BEGIN
      SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END), 0)
        INTO diff FROM journal_entries WHERE transaction_id = NEW.transaction_id;
      IF diff <> 0 THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced by %', NEW.transaction_id, diff
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql`.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER journal_entries_balanced
      AFTER INSERT ON journal_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced()`.execute(db);

  await sql`
    CREATE TABLE holds (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id             uuid NOT NULL REFERENCES accounts(id),
      amount_minor           bigint NOT NULL CHECK (amount_minor > 0),
      captured_minor         bigint,
      status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','captured','released','expired')),
      reference_id           text,
      idempotency_key        text NOT NULL UNIQUE,
      request_hash           text NOT NULL,
      expires_at             timestamptz NOT NULL,
      capture_transaction_id uuid REFERENCES ledger_transactions(id),
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX holds_expiry_idx ON holds (expires_at) WHERE status = 'active'`.execute(db);
  await sql`CREATE INDEX holds_account_idx ON holds (account_id, status)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ['holds', 'journal_entries', 'ledger_transactions', 'account_balances', 'accounts']) {
    await sql`DROP TABLE IF EXISTS ${sql.raw(t)} CASCADE`.execute(db);
  }
  await sql`DROP FUNCTION IF EXISTS assert_transaction_balanced, journal_entries_immutable, enforce_non_negative_balance`.execute(db);
}
