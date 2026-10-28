import { Inject, Injectable, Logger } from '@nestjs/common';
import { registry } from '@zerodrift/common';
import { sql } from 'kysely';
import { Counter } from 'prom-client';
import { type Db, PaymentsRepo, refundView, toView } from './payments.repo.js';
import { RefundsService } from './refunds.service.js';
import { SagaService } from './saga.service.js';
import { isSettled } from './state-machine.js';
import { CONFIG, DB, type PaymentsConfig } from './tokens.js';

export interface RecoverySummary {
  paymentsExamined: number;
  paymentsSettled: number;
  refundsExamined: number;
  refundsSettled: number;
  idempotencyKeysClosed: number;
}

const recovered = new Counter({ name: 'payments_recovered_total', help: 'Stuck payments settled by the recovery job', labelNames: ['outcome'], registers: [registry] });

/**
 * Recovery job: finds work the live request path could not finish (crash, timeout, ledger/gateway
 * outage) and resumes it. It is safe to run any time, on any number of replicas, because every
 * saga step is idempotent and each payment is protected by a short lease.
 *
 *  - payments stuck in created/processing -> saga in RECOVERY mode (query the bank first)
 *  - refunds stuck pending                -> re-run the (idempotent) ledger posting
 *  - idempotency keys still `in_progress` whose resource has settled -> close them
 *  - expired idempotency keys             -> delete
 */
@Injectable()
export class RecoveryService {
  private readonly log = new Logger('Recovery');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: PaymentsConfig,
    private readonly saga: SagaService,
    private readonly refunds: RefundsService,
    private readonly repo: PaymentsRepo,
  ) {}

  async runOnce(): Promise<RecoverySummary> {
    const stuckAfter = this.config.recoveryStuckAfterSeconds;
    const summary: RecoverySummary = { paymentsExamined: 0, paymentsSettled: 0, refundsExamined: 0, refundsSettled: 0, idempotencyKeysClosed: 0 };

    const stuck = await this.db
      .selectFrom('payments')
      .select('id')
      .where('status', 'in', ['created', 'processing'])
      .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', sql<Date>`now()`)]))
      .where('updated_at', '<=', sql<Date>`now() - make_interval(secs => ${stuckAfter})`)
      .orderBy('updated_at')
      .limit(100)
      .execute();
    summary.paymentsExamined = stuck.length;
    await this.inBatches(stuck.map((s) => s.id), 5, async (id) => {
      try {
        const p = await this.saga.run(id, 'recovery');
        if (isSettled(p.status)) {
          summary.paymentsSettled++;
          recovered.inc({ outcome: p.status });
        }
      } catch (err) {
        this.log.error(`recovery of payment ${id} failed: ${(err as Error).message}`);
      }
    });

    const pending = await this.db
      .selectFrom('refunds')
      .select('id')
      .where('status', '=', 'pending')
      .where('updated_at', '<=', sql<Date>`now() - make_interval(secs => ${stuckAfter})`)
      .orderBy('updated_at')
      .limit(100)
      .execute();
    summary.refundsExamined = pending.length;
    await this.inBatches(pending.map((s) => s.id), 5, async (id) => {
      try {
        const r = await this.refunds.execute(id);
        if (r.status !== 'pending') summary.refundsSettled++;
      } catch (err) {
        this.log.error(`recovery of refund ${id} failed: ${(err as Error).message}`);
      }
    });

    summary.idempotencyKeysClosed = await this.closeOrphanKeys();
    await this.db.deleteFrom('idempotency_keys').where('expires_at', '<', sql<Date>`now()`).where('status', '=', 'completed').execute();
    return summary;
  }

  /** `in_progress` keys whose payment/refund already settled (the requester died before answering). */
  private async closeOrphanKeys(): Promise<number> {
    let closed = 0;
    const payments = await sql<{ merchant_id: string; key: string; id: string }>`
      SELECT k.merchant_id, k.key, p.id FROM idempotency_keys k
      JOIN payments p ON p.id = k.resource_id
      WHERE k.status = 'in_progress' AND k.resource_type = 'payment' AND p.status NOT IN ('created','processing')
      LIMIT 200`.execute(this.db);
    for (const row of payments.rows) {
      const p = await this.repo.load(row.id);
      await this.db.updateTable('idempotency_keys').set({ status: 'completed', response_status: 201, response_snapshot: JSON.stringify(toView(p)) }).where('merchant_id', '=', row.merchant_id).where('key', '=', row.key).where('status', '=', 'in_progress').execute();
      closed++;
    }
    const refunds = await sql<{ merchant_id: string; key: string; id: string }>`
      SELECT k.merchant_id, k.key, r.id FROM idempotency_keys k
      JOIN refunds r ON r.id = k.resource_id
      WHERE k.status = 'in_progress' AND k.resource_type = 'refund' AND r.status <> 'pending'
      LIMIT 200`.execute(this.db);
    for (const row of refunds.rows) {
      const r = await this.db.selectFrom('refunds').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
      await this.db.updateTable('idempotency_keys').set({ status: 'completed', response_status: 201, response_snapshot: JSON.stringify(refundView(r)) }).where('merchant_id', '=', row.merchant_id).where('key', '=', row.key).where('status', '=', 'in_progress').execute();
      closed++;
    }
    return closed;
  }

  private async inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
  }
}
