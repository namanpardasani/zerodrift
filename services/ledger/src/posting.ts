import { createHash } from 'node:crypto';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { Direction, LedgerDB, TxType } from './db-schema.js';
import { DomainError, Errors } from './errors.js';

export type Db = Kysely<LedgerDB>;
export type Trx = Transaction<LedgerDB>;

export interface EntryInput {
  accountId: string;
  direction: Direction;
  amountMinor: bigint;
  /** Debit that consumes held funds (capture) instead of available funds. */
  fromHold?: boolean;
}

export interface PostInput {
  type: TxType;
  referenceId?: string | null;
  idempotencyKey: string;
  requestHash: string;
  reversesTransactionId?: string;
  entries: EntryInput[];
}

/** JSON-safe view of a posted transaction (amounts as strings). Stored as the idempotent response. */
export interface TransactionView {
  id: string;
  type: TxType;
  referenceId: string | null;
  idempotencyKey: string;
  reversesTransactionId: string | null;
  createdAt: string;
  entries: { id: string; accountId: string; direction: Direction; amountMinor: string; currency: string }[];
}

export interface PostResult {
  transaction: TransactionView;
  /** true when this idempotency key had already been processed and we returned the stored result. */
  replayed: boolean;
}

/** Stable hash of an operation + its parameters, used to detect key reuse with a different body. */
export function hashRequest(operation: string, params: unknown): string {
  const canonical = JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return createHash('sha256').update(`${operation}:${canonical}`).digest('hex');
}

/**
 * Run `fn` in a transaction, retrying on deadlock (40P01) or serialization failure (40001).
 * With ordered locking deadlocks should not happen; the retry is cheap insurance, not the plan.
 */
export async function inTransaction<T>(db: Db, fn: (trx: Trx) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await db.transaction().execute(fn);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && i < attempts) continue;
      throw mapDbError(err);
    }
  }
}

/** Translate low-level Postgres errors raised by our triggers/constraints into domain errors. */
function mapDbError(err: unknown): unknown {
  if (err instanceof DomainError) return err;
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === '23514' && e.message?.includes('below zero')) {
    return new DomainError('insufficient_funds', e.message, 409);
  }
  if (e.code === '23505' && e.constraint === 'ledger_transactions_reverses_transaction_id_key') {
    return new DomainError('already_reversed', 'Transaction was already reversed', 409);
  }
  return err;
}

interface LockedBalance {
  account_id: string;
  available_minor: bigint;
  held_minor: bigint;
  currency: string;
  status: string;
  allow_negative: boolean;
}

/**
 * Lock the balance rows of `accountIds` in ASCENDING id order and return them.
 *
 * DEADLOCK AVOIDANCE: a deadlock needs two transactions each holding a lock the other wants. If
 * every transaction acquires its locks in the same global order (sorted by account id), a cycle is
 * impossible. `ORDER BY ... FOR UPDATE` makes Postgres take the row locks in that order.
 * Callers that also lock a hold row always lock the HOLD first, then balances (hold -> balance),
 * so that order is global too.
 */
export async function lockBalances(trx: Trx, accountIds: string[]): Promise<Map<string, LockedBalance>> {
  const ids = [...new Set(accountIds)].sort();
  const rows = await trx
    .selectFrom('account_balances as b')
    .innerJoin('accounts as a', 'a.id', 'b.account_id')
    .select([
      'b.account_id',
      'b.available_minor',
      'b.held_minor',
      'a.currency',
      'a.status',
      'a.allow_negative',
    ])
    .where('b.account_id', 'in', ids)
    .orderBy('b.account_id')
    .forUpdate('b')
    .execute();
  const map = new Map<string, LockedBalance>();
  for (const r of rows) map.set(r.account_id, r as LockedBalance);
  for (const id of ids) if (!map.has(id)) throw Errors.notFound('Account', id);
  return map;
}

function validateEntries(entries: EntryInput[]) {
  if (entries.length < 2) throw Errors.validation('A transaction needs at least two entries');
  let debits = 0n;
  let credits = 0n;
  for (const e of entries) {
    if (e.amountMinor <= 0n) throw Errors.validation('Entry amounts must be positive');
    if (e.direction === 'debit') debits += e.amountMinor;
    else credits += e.amountMinor;
  }
  if (debits !== credits) {
    throw Errors.validation(`Unbalanced transaction: debits ${debits} != credits ${credits}`);
  }
}

/**
 * THE posting function: the only code path that writes journal entries and moves balances.
 * Must run inside a transaction so the idempotency record, entries and balances commit atomically.
 *
 * Steps:
 *  1. Validate balance in code (good error message).
 *  2. Claim the idempotency key with INSERT .. ON CONFLICT DO NOTHING. If a concurrent request holds
 *     the same key, Postgres BLOCKS here until that transaction commits/rolls back, so two
 *     duplicates can never both execute. If we lose the race we return the winner's stored response.
 *  3. Lock balances in id order, check funds, update balances (same transaction as the entries).
 *  4. Insert entries; the deferred DB trigger re-checks debits == credits at COMMIT.
 */
export async function post(trx: Trx, input: PostInput): Promise<PostResult> {
  validateEntries(input.entries);

  const claimed = await trx
    .insertInto('ledger_transactions')
    .values({
      type: input.type,
      reference_id: input.referenceId ?? null,
      idempotency_key: input.idempotencyKey,
      request_hash: input.requestHash,
      reverses_transaction_id: input.reversesTransactionId ?? null,
      response: null,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning(['id', 'created_at'])
    .executeTakeFirst();

  if (!claimed) {
    const existing = await trx
      .selectFrom('ledger_transactions')
      .select(['request_hash', 'response'])
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirstOrThrow();
    if (existing.request_hash !== input.requestHash) throw Errors.idempotencyMismatch(input.idempotencyKey);
    return { transaction: existing.response as TransactionView, replayed: true };
  }

  const balances = await lockBalances(trx, input.entries.map((e) => e.accountId));

  // Every account in one transaction must share one currency, and be active.
  const currencies = new Set([...balances.values()].map((b) => b.currency));
  if (currencies.size > 1) throw Errors.currencyMismatch('All accounts in a transaction must share a currency');
  for (const b of balances.values()) if (b.status !== 'active') throw Errors.accountNotActive(b.account_id);

  // Net effect per account.
  const deltas = new Map<string, { available: bigint; held: bigint }>();
  for (const e of input.entries) {
    const d = deltas.get(e.accountId) ?? { available: 0n, held: 0n };
    if (e.direction === 'credit') d.available += e.amountMinor;
    else if (e.fromHold) d.held -= e.amountMinor;
    else d.available -= e.amountMinor;
    deltas.set(e.accountId, d);
  }

  for (const [accountId, d] of deltas) {
    const b = balances.get(accountId)!;
    const newAvailable = b.available_minor + d.available;
    const newHeld = b.held_minor + d.held;
    if (newHeld < 0n) throw Errors.insufficientFunds(accountId, b.held_minor, -d.held);
    if (newAvailable < 0n && !b.allow_negative) {
      throw Errors.insufficientFunds(accountId, b.available_minor, -d.available);
    }
    await trx
      .updateTable('account_balances')
      .set({ available_minor: newAvailable, held_minor: newHeld, version: sql`version + 1` })
      .where('account_id', '=', accountId)
      .execute();
  }

  const currency = [...currencies][0]!;
  const rows = await trx
    .insertInto('journal_entries')
    .values(
      input.entries.map((e) => ({
        transaction_id: claimed.id,
        account_id: e.accountId,
        direction: e.direction,
        amount_minor: e.amountMinor,
        currency,
      })),
    )
    .returning(['id', 'account_id', 'direction', 'amount_minor', 'currency'])
    .execute();

  const view: TransactionView = {
    id: claimed.id,
    type: input.type,
    referenceId: input.referenceId ?? null,
    idempotencyKey: input.idempotencyKey,
    reversesTransactionId: input.reversesTransactionId ?? null,
    createdAt: claimed.created_at.toISOString(),
    entries: rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      direction: r.direction,
      amountMinor: r.amount_minor.toString(),
      currency: r.currency.trim(),
    })),
  };
  await trx
    .updateTable('ledger_transactions')
    .set({ response: JSON.stringify(view) })
    .where('id', '=', claimed.id)
    .execute();

  return { transaction: view, replayed: false };
}
