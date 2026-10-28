import { Inject, Injectable } from '@nestjs/common';
import { makeEvent } from '@zerodrift/events';
import { proportionalFee } from '@zerodrift/money';
import { sql } from 'kysely';
import { LedgerClient, LedgerRejected, LedgerUnavailable } from './clients/ledger.client.js';
import { Errors } from './errors.js';
import { IdempotencyService, hashRequest } from './idempotency.service.js';
import { type Merchant, MerchantsService } from './merchants.service.js';
import { emit } from './outbox.js';
import type { ApiResult } from './payments.service.js';
import { type Db, PaymentsRepo, type RefundView, refundView } from './payments.repo.js';
import { assertTransition } from './state-machine.js';
import { DB, LEDGER } from './tokens.js';

/**
 * Refunds (full or partial, possibly several per payment).
 *
 * Step 1 (one DB transaction, payment row LOCKED): validate, RESERVE the amount on the payment and
 *   insert a `pending` refund. Reserving under the row lock is what makes concurrent refunds safe:
 *   they serialise here, so the sum of refunds can never exceed the payment.
 * Step 2 (ledger call, idempotent key `refund:<id>`): post ONE balanced ledger transaction:
 *     credit customer `amount`; debit merchant `amount - feeShare`; debit fees account `feeShare`.
 *   (a REVERSING movement of money: no existing journal row is touched.)
 * Step 3: mark the refund succeeded and move the payment to partially_refunded / refunded; or, if
 *   the ledger definitively refuses (merchant has already spent the money), mark it failed and
 *   release the reservation. A ledger timeout leaves it `pending` for the recovery job.
 *
 * Fee policy: the platform returns its fee proportionally. Cumulative rounding means the fee shares
 * of all refunds add up to exactly the fee once the payment is fully refunded.
 */
@Injectable()
export class RefundsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LEDGER) private readonly ledger: LedgerClient,
    private readonly repo: PaymentsRepo,
    private readonly idempotency: IdempotencyService,
    private readonly merchants: MerchantsService,
  ) {}

  async create(merchant: Merchant, paymentId: string, input: { amountMinor?: bigint; reason?: string }, key: string): Promise<ApiResult<RefundView>> {
    const requestHash = hashRequest('refund.create', { p: paymentId, a: input.amountMinor, r: input.reason });

    const created = await this.db.transaction().execute(async (trx) => {
      const begin = await this.idempotency.begin(trx, merchant.id, key, requestHash, 'refund');
      if (begin.kind === 'replay') return { kind: 'replay' as const, replay: begin };

      // Lock the payment: all refunds of one payment serialise on this row.
      const p = await trx.selectFrom('payments').selectAll().where('id', '=', paymentId).where('merchant_id', '=', merchant.id).forUpdate().executeTakeFirst();
      if (!p) throw Errors.notFound('Payment', paymentId);
      if (p.status !== 'succeeded' && p.status !== 'partially_refunded') throw Errors.paymentNotRefundable(p.id, p.status);

      const refundable = p.amount_minor - p.refund_reserved_minor;
      const amount = input.amountMinor ?? refundable;
      if (amount <= 0n || amount > refundable) throw Errors.refundExceedsPayment(refundable);

      const reservedAfter = p.refund_reserved_minor + amount;
      const feeShare = proportionalFee(p.fee_minor, reservedAfter, p.amount_minor) - p.fee_refund_reserved_minor;

      const refund = await trx
        .insertInto('refunds')
        .values({ payment_id: p.id, amount_minor: amount, fee_refund_minor: feeShare, status: 'pending', reason: input.reason ?? null, failure_reason: null, idempotency_key: key, ledger_tx_id: null, updated_at: new Date() })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('payments')
        .set({ refund_reserved_minor: reservedAfter, fee_refund_reserved_minor: p.fee_refund_reserved_minor + feeShare, updated_at: sql`now()` })
        .where('id', '=', p.id)
        .execute();
      await emit(trx, makeEvent('refund.created', 'refund', refund.id, { refundId: refund.id, paymentId: p.id, merchantId: p.merchant_id, amountMinor: amount.toString(), currency: p.currency.trim() }));
      await this.idempotency.attach(trx, merchant.id, key, refund.id);
      return { kind: 'created' as const, refund };
    });

    if (created.kind === 'replay') {
      const stored = created.replay.body as RefundView;
      if (stored.status === 'pending') {
        const fresh = await this.get(stored.id);
        return { status: 200, body: fresh, replayed: true };
      }
      return { status: created.replay.status, body: stored, replayed: true };
    }

    const done = await this.execute(created.refund.id);
    const status = done.status === 'pending' ? 202 : 201;
    await this.idempotency.complete(merchant.id, key, status, done);
    return { status, body: done, replayed: false };
  }

  /** Perform the ledger movement for a pending refund. Idempotent and resumable (also used by recovery). */
  async execute(refundId: string): Promise<RefundView> {
    const r = await this.db.selectFrom('refunds').selectAll().where('id', '=', refundId).executeTakeFirstOrThrow();
    if (r.status !== 'pending') return refundView(r);
    const p = await this.repo.load(r.payment_id);
    const merchant = await this.merchants.get(p.merchant_id);

    try {
      const feesAccount = await this.ledger.systemAccountId('fees');
      const entries: { accountId: string; direction: 'debit' | 'credit'; amountMinor: bigint }[] = [{ accountId: p.customer_account_id, direction: 'credit', amountMinor: r.amount_minor }];
      const fromMerchant = r.amount_minor - r.fee_refund_minor;
      if (fromMerchant > 0n) entries.push({ accountId: merchant.ledger_account_id, direction: 'debit', amountMinor: fromMerchant });
      if (r.fee_refund_minor > 0n) entries.push({ accountId: feesAccount, direction: 'debit', amountMinor: r.fee_refund_minor });
      const tx = await this.ledger.postTransaction({ type: 'refund', referenceId: r.id, idempotencyKey: `refund:${r.id}`, entries });
      const view = await this.markSucceeded(r.id, tx.id);
      await this.idempotency.complete(merchant.id, r.idempotency_key, 201, view);
      return view;
    } catch (err) {
      if (err instanceof LedgerUnavailable) return refundView(r); // UNKNOWN: stays pending, recovery retries
      if (err instanceof LedgerRejected) {
        const view = await this.markFailed(r.id, err.code);
        await this.idempotency.complete(merchant.id, r.idempotency_key, 201, view);
        return view;
      }
      throw err;
    }
  }

  private async markSucceeded(refundId: string, ledgerTxId: string): Promise<RefundView> {
    return this.db.transaction().execute(async (trx) => {
      const r = await trx.updateTable('refunds').set({ status: 'succeeded', ledger_tx_id: ledgerTxId, updated_at: sql`now()` }).where('id', '=', refundId).where('status', '=', 'pending').returningAll().executeTakeFirst();
      if (!r) return refundView(await trx.selectFrom('refunds').selectAll().where('id', '=', refundId).executeTakeFirstOrThrow()); // someone else finished it

      const p = await trx.selectFrom('payments').selectAll().where('id', '=', r.payment_id).forUpdate().executeTakeFirstOrThrow();
      const refundedAfter = p.refunded_minor + r.amount_minor;
      const to = refundedAfter === p.amount_minor ? 'refunded' : 'partially_refunded';
      assertTransition(p.status, to);
      const updated = await trx.updateTable('payments').set({ refunded_minor: refundedAfter, status: to, version: sql`version + 1`, updated_at: sql`now()` }).where('id', '=', p.id).returningAll().executeTakeFirstOrThrow();
      await this.repo.recordTransition(trx, updated, p.status, `refund_${r.id}`);
      return refundView(r);
    });
  }

  private async markFailed(refundId: string, reason: string): Promise<RefundView> {
    return this.db.transaction().execute(async (trx) => {
      const r = await trx.updateTable('refunds').set({ status: 'failed', failure_reason: reason, updated_at: sql`now()` }).where('id', '=', refundId).where('status', '=', 'pending').returningAll().executeTakeFirst();
      if (!r) return refundView(await trx.selectFrom('refunds').selectAll().where('id', '=', refundId).executeTakeFirstOrThrow());
      // give the reservation back so the amount can be refunded again
      await trx
        .updateTable('payments')
        .set({ refund_reserved_minor: sql`refund_reserved_minor - ${r.amount_minor}`, fee_refund_reserved_minor: sql`fee_refund_reserved_minor - ${r.fee_refund_minor}`, updated_at: sql`now()` })
        .where('id', '=', r.payment_id)
        .execute();
      return refundView(r);
    });
  }

  async get(id: string): Promise<RefundView> {
    const r = await this.db.selectFrom('refunds').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw Errors.notFound('Refund', id);
    return refundView(r);
  }
}
