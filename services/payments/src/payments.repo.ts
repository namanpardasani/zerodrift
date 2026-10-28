import { Inject, Injectable } from '@nestjs/common';
import { registry } from '@zerodrift/common';
import { makeEvent } from '@zerodrift/events';
import { type Kysely, type Selectable, type Transaction, sql } from 'kysely';
import { Counter } from 'prom-client';
import type { PaymentStatus, PaymentsDB, PaymentsTable } from './db-schema.js';
import { Errors } from './errors.js';
import { emit } from './outbox.js';
import { assertTransition } from './state-machine.js';
import { DB } from './tokens.js';

export type PaymentRow = Selectable<PaymentsTable>;
export type Db = Kysely<PaymentsDB>;
export type Trx = Transaction<PaymentsDB>;

const transitions = new Counter({ name: 'payment_transitions_total', help: 'Payment status transitions', labelNames: ['to'], registers: [registry] });

export interface PaymentView {
  id: string;
  merchantId: string;
  customerId: string;
  amountMinor: string;
  currency: string;
  status: PaymentStatus;
  reference: string | null;
  description: string | null;
  failureReason: string | null;
  feeMinor: string;
  refundedMinor: string;
  createdAt: string;
  updatedAt: string;
  events?: { fromStatus: string | null; toStatus: string; reason: string | null; at: string }[];
  refunds?: RefundView[];
}

export interface RefundView {
  id: string;
  paymentId: string;
  amountMinor: string;
  feeRefundMinor: string;
  status: string;
  reason: string | null;
  failureReason: string | null;
  createdAt: string;
}

export function toView(p: PaymentRow): PaymentView {
  return {
    id: p.id,
    merchantId: p.merchant_id,
    customerId: p.customer_id,
    amountMinor: p.amount_minor.toString(),
    currency: p.currency.trim(),
    status: p.status,
    reference: p.reference,
    description: p.description,
    failureReason: p.failure_reason,
    feeMinor: p.fee_minor.toString(),
    refundedMinor: p.refunded_minor.toString(),
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}

/** Event payload fields shared by all payment.* events. */
export function paymentEventBase(p: PaymentRow) {
  return {
    paymentId: p.id,
    merchantId: p.merchant_id,
    customerId: p.customer_id,
    amountMinor: p.amount_minor.toString(),
    currency: p.currency.trim(),
  };
}

@Injectable()
export class PaymentsRepo {
  constructor(@Inject(DB) readonly db: Db) {}

  async load(id: string, q: Db | Trx = this.db): Promise<PaymentRow> {
    const p = await q.selectFrom('payments').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw Errors.notFound('Payment', id);
    return p;
  }

  /**
   * Compare-and-set status change: `UPDATE ... WHERE id = ? AND status = <what we last saw>`.
   * If someone else moved the payment meanwhile, zero rows match and we return THEIR result instead
   * of overwriting it (and if they already moved it to `to`, that is simply success). Writes the
   * timeline row and, for terminal outcomes, the outbox event in the same transaction.
   */
  async transition(p: PaymentRow, to: PaymentStatus, reason: string, patch: Partial<Pick<PaymentRow, 'failure_reason' | 'ledger_tx_id' | 'gateway_ref' | 'hold_id'>> = {}): Promise<PaymentRow> {
    assertTransition(p.status, to);
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('payments')
        .set({ ...patch, status: to, version: sql`version + 1`, updated_at: sql`now()` })
        .where('id', '=', p.id)
        .where('status', '=', p.status)
        .returningAll()
        .executeTakeFirst();
      if (!updated) return this.load(p.id, trx); // lost the race: report the winner's state
      await this.recordTransition(trx, updated, p.status, reason);
      return updated;
    });
  }

  /** Timeline row + (for succeeded/failed) the outbox event. Called inside the transition's transaction. */
  async recordTransition(trx: Trx, p: PaymentRow, from: PaymentStatus | null, reason: string): Promise<void> {
    await trx.insertInto('payment_events').values({ payment_id: p.id, from_status: from, to_status: p.status, reason }).execute();
    transitions.inc({ to: p.status });
    if (p.status === 'succeeded') {
      await emit(trx, makeEvent('payment.succeeded', 'payment', p.id, { ...paymentEventBase(p), gatewayRef: p.gateway_ref ?? p.id }));
    } else if (p.status === 'failed') {
      await emit(trx, makeEvent('payment.failed', 'payment', p.id, { ...paymentEventBase(p), reason: p.failure_reason ?? reason }));
    }
  }

  /** Non-status field update (e.g. remember the hold id). Bumps updated_at so progress counts as activity. */
  async patch(id: string, fields: Partial<Pick<PaymentRow, 'hold_id' | 'gateway_ref'>>): Promise<PaymentRow> {
    return this.db
      .updateTable('payments')
      .set({ ...fields, updated_at: sql`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Try to take the exclusive work lease. Returns null if another worker holds a live lease. */
  async acquireLease(id: string, seconds: number): Promise<PaymentRow | null> {
    const row = await this.db
      .updateTable('payments')
      .set({ lease_until: sql`now() + make_interval(secs => ${seconds})` })
      .where('id', '=', id)
      .where('status', 'in', ['created', 'processing'])
      .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', sql<Date>`now()`)]))
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }

  async releaseLease(id: string): Promise<void> {
    await this.db.updateTable('payments').set({ lease_until: null }).where('id', '=', id).execute();
  }

  async events(paymentId: string) {
    const rows = await this.db.selectFrom('payment_events').selectAll().where('payment_id', '=', paymentId).orderBy('id').execute();
    return rows.map((e) => ({ fromStatus: e.from_status, toStatus: e.to_status, reason: e.reason, at: e.created_at.toISOString() }));
  }

  async refundsFor(paymentId: string): Promise<RefundView[]> {
    const rows = await this.db.selectFrom('refunds').selectAll().where('payment_id', '=', paymentId).orderBy('created_at').orderBy('id').execute();
    return rows.map(refundView);
  }
}

export function refundView(r: { id: string; payment_id: string; amount_minor: bigint; fee_refund_minor: bigint; status: string; reason: string | null; failure_reason: string | null; created_at: Date }): RefundView {
  return {
    id: r.id,
    paymentId: r.payment_id,
    amountMinor: r.amount_minor.toString(),
    feeRefundMinor: r.fee_refund_minor.toString(),
    status: r.status,
    reason: r.reason,
    failureReason: r.failure_reason,
    createdAt: r.created_at.toISOString(),
  };
}
