import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import { randomUUID } from 'node:crypto';
import { CONFIG } from './auth.js';
import type { DashboardConfig } from './config.js';
import { Upstream } from './upstream.js';

export interface LoadResult {
  runId: string;
  startedAt: string;
  durationMs: number;
  requested: number;
  duplicatesSent: number;
  /** HTTP status -> count (201 settled, 202 outcome unknown yet, 409 in progress, 503 ledger down ...) */
  byHttpStatus: Record<string, number>;
  /** payment status in the responses that carried one */
  byPaymentStatus: Record<string, number>;
  /** the number of DISTINCT payments the responses refer to (duplicates must not add to this) */
  distinctPayments: number;
  errors: number;
}

/**
 * Generates demo traffic for the chaos panel: payments from a set of customers, with a share of
 * deliberate duplicates (same Idempotency-Key) so idempotency is visible while faults are injected.
 * It uses a throw-away merchant it creates through the admin API (the key lives only in memory).
 */
@Injectable()
export class ChaosLoadService {
  private merchantKey?: string;
  private funded = new Set<string>();
  private running = false;
  last: LoadResult | null = null;
  private readonly payments: Upstream;

  constructor(@Inject(CONFIG) private readonly config: DashboardConfig) {
    this.payments = new Upstream('payments', config.upstreams.payments, { 'x-admin-token': config.adminToken });
  }

  private async merchant(): Promise<string> {
    if (!this.merchantKey) {
      const m = await this.payments.ok<{ apiKey: string }>('POST', '/admin/merchants', { name: `chaos-load-${new Date().toISOString().slice(0, 19)}` });
      this.merchantKey = m.apiKey;
    }
    return this.merchantKey;
  }

  async run(opts: { count: number; amountMinor: number; concurrency: number; duplicateRate: number; customers: number }): Promise<LoadResult> {
    if (this.running) throw new DomainError('load_in_progress', 'A load run is already in progress', 409);
    this.running = true;
    try {
      const key = await this.merchant();
      const auth = { authorization: `Bearer ${key}` };
      const runId = randomUUID().slice(0, 8);
      const customers = Array.from({ length: opts.customers }, (_, i) => `chaos-cust-${i}`);
      for (const c of customers) {
        if (this.funded.has(c)) continue;
        await new Upstream('payments', this.config.upstreams.payments, auth).request('POST', `/v1/customers/${c}/topups`, { amountMinor: '100000000' }, { 'idempotency-key': `fund-${c}` });
        this.funded.add(c);
      }

      const result: LoadResult = { runId, startedAt: new Date().toISOString(), durationMs: 0, requested: opts.count, duplicatesSent: 0, byHttpStatus: {}, byPaymentStatus: {}, distinctPayments: 0, errors: 0 };
      const paymentIds = new Set<string>();
      const t0 = Date.now();
      const deadline = t0 + 60_000;
      const client = new Upstream('payments', this.config.upstreams.payments, auth, 15_000);

      const send = async (i: number) => {
        const customerId = customers[i % customers.length]!;
        const r = await client.request<{ id?: string; status?: string }>('POST', '/v1/payments', { customerId, amountMinor: String(opts.amountMinor) }, { 'idempotency-key': `load-${runId}-${i}` }).catch(() => null);
        if (!r) {
          result.errors++;
          return;
        }
        result.byHttpStatus[r.status] = (result.byHttpStatus[r.status] ?? 0) + 1;
        if (r.data?.id) paymentIds.add(r.data.id);
        if (r.data?.status) result.byPaymentStatus[r.data.status] = (result.byPaymentStatus[r.data.status] ?? 0) + 1;
      };

      // a simple worker pool; duplicates re-send the SAME key as an extra request
      const queue: number[] = [];
      for (let i = 0; i < opts.count; i++) {
        queue.push(i);
        if (Math.random() < opts.duplicateRate) {
          queue.push(i);
          result.duplicatesSent++;
        }
      }
      await Promise.all(
        Array.from({ length: opts.concurrency }, async () => {
          while (queue.length && Date.now() < deadline) await send(queue.shift()!);
        }),
      );
      result.durationMs = Date.now() - t0;
      result.distinctPayments = paymentIds.size;
      this.last = result;
      return result;
    } finally {
      this.running = false;
    }
  }
}
