import { Inject, Injectable } from '@nestjs/common';
import { feeFor } from '@zerodrift/money';
import { sql } from 'kysely';
import type { HoldStatus } from './db-schema.js';
import { Errors } from './errors.js';
import { LedgerService, paymentEntries } from './ledger.service.js';
import {
  type Db,
  type Trx,
  type TransactionView,
  hashRequest,
  inTransaction,
  lockBalances,
  post,
} from './posting.js';
import { DB } from './tokens.js';

export interface HoldView {
  id: string;
  accountId: string;
  amountMinor: string;
  capturedMinor: string | null;
  status: HoldStatus;
  referenceId: string | null;
  expiresAt: string;
  captureTransactionId: string | null;
  createdAt: string;
}

export const DEFAULT_HOLD_TTL_SECONDS = 15 * 60;
export const MAX_HOLD_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Holds reserve funds (authorize) without moving them. Lifecycle:
 *   active --capture--> captured   (full or partial; any unused remainder is released)
 *   active --release--> released
 *   active --expiry---> expired    (sweeper, so a crashed caller never locks money forever)
 *
 * Balance effect: create: available -= a, held += a. Release/expire: reverse of that. Capture: a
 * journal transaction debits the payer FROM HELD funds; the remainder returns to available.
 * Invariant: available + held == credits - debits for every account.
 *
 * LOCK ORDER everywhere: hold row first, then balance rows (ascending id). Never the reverse.
 */
@Injectable()
export class HoldsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  async createHold(input: {
    accountId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    referenceId?: string;
    ttlSeconds?: number;
  }): Promise<{ hold: HoldView; replayed: boolean }> {
    const ttl = input.ttlSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_HOLD_TTL_SECONDS) {
      throw Errors.validation(`ttlSeconds must be an integer between 1 and ${MAX_HOLD_TTL_SECONDS}`);
    }
    const requestHash = hashRequest('hold', {
      a: input.accountId,
      m: input.amountMinor,
      r: input.referenceId,
      t: ttl,
    });
    return inTransaction(this.db, async (trx) => {
      // Claim the idempotency key first (blocks on a concurrent duplicate, see posting.post).
      const claimed = await trx
        .insertInto('holds')
        .values({
          account_id: input.accountId,
          amount_minor: input.amountMinor,
          reference_id: input.referenceId ?? null,
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          expires_at: sql<Date>`now() + make_interval(secs => ${ttl})`,
          capture_transaction_id: null,
        })
        .onConflict((oc) => oc.column('idempotency_key').doNothing())
        .returningAll()
        .executeTakeFirst();

      if (!claimed) {
        const existing = await trx
          .selectFrom('holds')
          .selectAll()
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirstOrThrow();
        if (existing.request_hash !== requestHash) throw Errors.idempotencyMismatch(input.idempotencyKey);
        return { hold: toView(existing), replayed: true };
      }

      const balances = await lockBalances(trx, [input.accountId]);
      const b = balances.get(input.accountId)!;
      if (b.status !== 'active') throw Errors.accountNotActive(input.accountId);
      if (b.available_minor < input.amountMinor) {
        // Throwing rolls back the claimed hold row too: a failed hold leaves no trace.
        throw Errors.insufficientFunds(input.accountId, b.available_minor, input.amountMinor);
      }
      await this.moveBalance(trx, input.accountId, -input.amountMinor, input.amountMinor);
      return { hold: toView(claimed), replayed: false };
    });
  }

  /**
   * Capture a hold into a payment: payer -> `toAccountId` (minus optional platform fee).
   * `amountMinor` may be less than the hold (partial capture); the remainder is released at once.
   */
  async captureHold(input: {
    holdId: string;
    toAccountId: string;
    amountMinor?: bigint;
    feeBps?: number;
    feeAccountId?: string;
    idempotencyKey: string;
    referenceId?: string;
  }): Promise<{ hold: HoldView; transaction: TransactionView; replayed: boolean }> {
    return inTransaction(this.db, async (trx) => {
      const hold = await this.lockHold(trx, input.holdId);
      const amount = input.amountMinor ?? hold.amount_minor;
      const requestHash = hashRequest('capture', {
        h: input.holdId,
        t: input.toAccountId,
        m: amount,
        b: input.feeBps ?? 0,
        fa: input.feeAccountId,
        r: input.referenceId,
      });

      if (hold.status === 'captured') {
        // Replay of the same capture returns the stored result; anything else is a conflict.
        const prior = await trx
          .selectFrom('ledger_transactions')
          .select(['request_hash', 'response'])
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (!prior) throw Errors.holdState(hold.id, hold.status, 'capture');
        if (prior.request_hash !== requestHash) throw Errors.idempotencyMismatch(input.idempotencyKey);
        return { hold: toView(hold), transaction: prior.response as TransactionView, replayed: true };
      }
      if (hold.status !== 'active') throw Errors.holdState(hold.id, hold.status, 'capture');
      if (hold.expires_at.getTime() <= (await this.ledger.dbNow()).getTime()) throw Errors.holdExpired(hold.id);
      if (amount <= 0n || amount > hold.amount_minor) {
        throw Errors.validation(`Capture amount must be between 1 and ${hold.amount_minor}`);
      }
      if (input.toAccountId === hold.account_id) throw Errors.validation('Cannot capture a hold to its own account');

      const fee = input.feeBps ? feeFor(amount, input.feeBps) : 0n;
      const feeAccountId = fee > 0n ? (input.feeAccountId ?? (await this.ledger.systemAccountId(trx, 'fees'))) : undefined;
      const posted = await post(trx, {
        type: 'payment',
        referenceId: input.referenceId ?? hold.reference_id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        entries: paymentEntries({
          fromAccountId: hold.account_id,
          toAccountId: input.toAccountId,
          amountMinor: amount,
          fromHold: true, // pays out of held funds, not available funds
          feeAmount: fee,
          feeAccountId,
        }),
      });

      // `post` consumed `amount` from held. Whatever was not captured goes back to available.
      const remainder = hold.amount_minor - amount;
      if (remainder > 0n) await this.moveBalance(trx, hold.account_id, remainder, -remainder);

      const updated = await trx
        .updateTable('holds')
        .set({
          status: 'captured',
          captured_minor: amount,
          capture_transaction_id: posted.transaction.id,
          updated_at: sql`now()`,
        })
        .where('id', '=', hold.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { hold: toView(updated), transaction: posted.transaction, replayed: posted.replayed };
    });
  }

  /** Release an active hold. Naturally idempotent: releasing a released/expired hold is a no-op. */
  async releaseHold(holdId: string): Promise<{ hold: HoldView; replayed: boolean }> {
    return inTransaction(this.db, async (trx) => {
      const hold = await this.lockHold(trx, holdId);
      if (hold.status === 'released' || hold.status === 'expired') return { hold: toView(hold), replayed: true };
      if (hold.status !== 'active') throw Errors.holdState(hold.id, hold.status, 'release');
      return { hold: await this.finishHold(trx, hold.id, hold.account_id, hold.amount_minor, 'released'), replayed: false };
    });
  }

  /**
   * Expire holds whose time is up, returning their funds. Each hold is handled in its own short
   * transaction and `FOR UPDATE SKIP LOCKED` lets several sweepers (or replicas) run side by side
   * without blocking each other or touching the same hold twice.
   */
  async expireDueHolds(max = 500): Promise<number> {
    let expired = 0;
    while (expired < max) {
      const did = await inTransaction(this.db, async (trx) => {
        const due = await trx
          .selectFrom('holds')
          .select(['id', 'account_id', 'amount_minor'])
          .where('status', '=', 'active')
          .where('expires_at', '<=', sql<Date>`now()`)
          .orderBy('expires_at')
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!due) return false;
        await this.finishHold(trx, due.id, due.account_id, due.amount_minor, 'expired');
        return true;
      });
      if (!did) break;
      expired++;
    }
    return expired;
  }

  async getHold(id: string): Promise<HoldView> {
    const r = await this.db.selectFrom('holds').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw Errors.notFound('Hold', id);
    return toView(r);
  }

  // ------------------------------------------------------------------ helpers

  private async lockHold(trx: Trx, id: string) {
    const hold = await trx.selectFrom('holds').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!hold) throw Errors.notFound('Hold', id);
    return hold;
  }

  /** Return a hold's funds (held -> available) and mark it released/expired. Hold is already locked. */
  private async finishHold(trx: Trx, holdId: string, accountId: string, amount: bigint, status: 'released' | 'expired') {
    await lockBalances(trx, [accountId]);
    await this.moveBalance(trx, accountId, amount, -amount);
    const row = await trx
      .updateTable('holds')
      .set({ status, updated_at: sql`now()` })
      .where('id', '=', holdId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toView(row);
  }

  /** Apply deltas to a balance row the caller has already locked. */
  private async moveBalance(trx: Trx, accountId: string, availableDelta: bigint, heldDelta: bigint) {
    await trx
      .updateTable('account_balances')
      .set({
        available_minor: sql`available_minor + ${availableDelta}`,
        held_minor: sql`held_minor + ${heldDelta}`,
        version: sql`version + 1`,
      })
      .where('account_id', '=', accountId)
      .execute();
  }
}

function toView(r: {
  id: string;
  account_id: string;
  amount_minor: bigint;
  captured_minor: bigint | null;
  status: HoldStatus;
  reference_id: string | null;
  expires_at: Date;
  capture_transaction_id: string | null;
  created_at: Date;
}): HoldView {
  return {
    id: r.id,
    accountId: r.account_id,
    amountMinor: r.amount_minor.toString(),
    capturedMinor: r.captured_minor?.toString() ?? null,
    status: r.status,
    referenceId: r.reference_id,
    expiresAt: r.expires_at.toISOString(),
    captureTransactionId: r.capture_transaction_id,
    createdAt: r.created_at.toISOString(),
  };
}
