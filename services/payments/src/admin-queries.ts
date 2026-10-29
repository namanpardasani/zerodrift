import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Errors } from './errors.js';
import { type Db, type PaymentView, PaymentsRepo, toView } from './payments.repo.js';
import { DB } from './tokens.js';

export interface AdminPaymentView extends PaymentView {
  merchantName: string;
  ledgerTxId: string | null;
  gatewayRef: string | null;
}

/** Cross-merchant, read-only queries for the operator dashboard (admin token only). */
@Injectable()
export class AdminQueries {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: PaymentsRepo,
  ) {}

  async list(q: { status?: string; merchantId?: string; limit?: number; before?: string }): Promise<AdminPaymentView[]> {
    let query = this.db
      .selectFrom('payments as p')
      .innerJoin('merchants as m', 'm.id', 'p.merchant_id')
      .selectAll('p')
      .select('m.name as merchant_name')
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(Math.min(q.limit ?? 50, 200));
    if (q.status) query = query.where('p.status', '=', q.status as never);
    if (q.merchantId) query = query.where('p.merchant_id', '=', q.merchantId);
    if (q.before) query = query.where('p.created_at', '<', new Date(q.before));
    const rows = await query.execute();
    return rows.map((r) => ({ ...toView(r), merchantName: r.merchant_name, ledgerTxId: r.ledger_tx_id, gatewayRef: r.gateway_ref }));
  }

  async get(id: string): Promise<AdminPaymentView & { events: Awaited<ReturnType<PaymentsRepo['events']>>; refunds: Awaited<ReturnType<PaymentsRepo['refundsFor']>> }> {
    const row = await this.db.selectFrom('payments as p').innerJoin('merchants as m', 'm.id', 'p.merchant_id').selectAll('p').select('m.name as merchant_name').where('p.id', '=', id).executeTakeFirst();
    if (!row) throw Errors.notFound('Payment', id);
    return { ...toView(row), merchantName: row.merchant_name, ledgerTxId: row.ledger_tx_id, gatewayRef: row.gateway_ref, events: await this.repo.events(id), refunds: await this.repo.refundsFor(id) };
  }

  /** Counts by status (all time and last 24h) and in-flight work, for the overview page. */
  async stats() {
    const all = await sql<{ status: string; n: string }>`SELECT status, count(*)::text AS n FROM payments GROUP BY status`.execute(this.db);
    const day = await sql<{ status: string; n: string }>`SELECT status, count(*)::text AS n FROM payments WHERE created_at > now() - interval '24 hours' GROUP BY status`.execute(this.db);
    const inflight = await sql<{ n: string; oldest: string | null }>`
      SELECT count(*)::text AS n, extract(epoch FROM now() - min(updated_at))::text AS oldest
      FROM payments WHERE status IN ('created','processing')`.execute(this.db);
    const toMap = (rows: { status: string; n: string }[]) => Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    return {
      byStatus: toMap(all.rows),
      last24hByStatus: toMap(day.rows),
      inFlight: { count: Number(inflight.rows[0]?.n ?? 0), oldestSeconds: inflight.rows[0]?.oldest ? Math.round(Number(inflight.rows[0].oldest)) : 0 },
    };
  }
}
