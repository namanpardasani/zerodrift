import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { Errors } from './errors.js';
import type { Db } from './payments.repo.js';
import { DB } from './tokens.js';

export interface FeedPayment {
  id: string;
  merchantId: string;
  customerAccountId: string;
  merchantLedgerAccountId: string;
  amountMinor: string;
  feeMinor: string;
  currency: string;
  status: string;
  ledgerTxId: string | null;
  refundedMinor: string;
  createdAt: string;
  updatedAt: string;
  refunds: { id: string; amountMinor: string; feeRefundMinor: string; status: string; ledgerTxId: string | null; updatedAt: string }[];
}

/**
 * Read-only export for reconciliation. Services never read each other's tables, so the payments
 * service offers its own view of the data over an admin-protected internal endpoint.
 * Keyset-paged by (created_at, id).
 */
@Injectable()
export class ReconciliationFeed {
  constructor(@Inject(DB) private readonly db: Db) {}

  async payments(q: { from?: string; to?: string; after?: string; limit?: number }): Promise<{ payments: FeedPayment[]; nextCursor: string | null }> {
    const limit = Math.min(q.limit ?? 500, 2_000);
    const valid = (v?: string) => !v || !Number.isNaN(Date.parse(v));
    if (!valid(q.from) || !valid(q.to)) throw Errors.validation('from/to must be ISO timestamps');
    let query = this.db
      .selectFrom('payments as p')
      .innerJoin('merchants as m', 'm.id', 'p.merchant_id')
      .select(['p.id', 'p.merchant_id', 'p.customer_account_id', 'm.ledger_account_id', 'p.amount_minor', 'p.fee_minor', 'p.currency', 'p.status', 'p.ledger_tx_id', 'p.refunded_minor', 'p.created_at', 'p.updated_at', sql<string>`to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('ts')])
      .orderBy('p.created_at')
      .orderBy('p.id')
      .limit(limit + 1);
    if (q.from) query = query.where('p.created_at', '>=', new Date(q.from));
    if (q.to) query = query.where('p.created_at', '<', new Date(q.to));
    if (q.after) {
      const [ts, id] = q.after.split('|');
      if (!ts || !id) throw Errors.validation('bad cursor');
      // exact-text timestamp in the cursor: Postgres has microseconds, a JS Date only milliseconds
      query = query.where(sql<boolean>`(p.created_at, p.id) > (${ts}::timestamptz, ${id}::uuid)`);
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.id);
    const refunds = ids.length
      ? await this.db.selectFrom('refunds').select(['id', 'payment_id', 'amount_minor', 'fee_refund_minor', 'status', 'ledger_tx_id', 'updated_at']).where('payment_id', 'in', ids).execute()
      : [];
    const last = page[page.length - 1];
    return {
      payments: page.map((p) => ({
        id: p.id,
        merchantId: p.merchant_id,
        customerAccountId: p.customer_account_id,
        merchantLedgerAccountId: p.ledger_account_id,
        amountMinor: p.amount_minor.toString(),
        feeMinor: p.fee_minor.toString(),
        currency: p.currency.trim(),
        status: p.status,
        ledgerTxId: p.ledger_tx_id,
        refundedMinor: p.refunded_minor.toString(),
        createdAt: p.created_at.toISOString(),
        updatedAt: p.updated_at.toISOString(),
        refunds: refunds
          .filter((r) => r.payment_id === p.id)
          .map((r) => ({ id: r.id, amountMinor: r.amount_minor.toString(), feeRefundMinor: r.fee_refund_minor.toString(), status: r.status, ledgerTxId: r.ledger_tx_id, updatedAt: r.updated_at.toISOString() })),
      })),
      nextCursor: rows.length > limit && last ? `${last.ts}|${last.id}` : null,
    };
  }
}

