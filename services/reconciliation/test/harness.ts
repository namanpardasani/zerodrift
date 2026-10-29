import { randomUUID } from 'node:crypto';
import { startLedger, type RunningLedger } from '@zerodrift/ledger/app';
import { startGateway, type RunningGateway } from '@zerodrift/mock-gateway/app';
import { startPayments, type RunningPayments } from '@zerodrift/payments/app';
import { createTestDatabase } from '@zerodrift/testing';
import { type ReconAppOptions, type RunningRecon, startReconciliation } from '../src/app.js';
import type { ReconConfig } from '../src/reconciler.service.js';
import { createHttpSources } from '../src/sources.js';

export interface Stack {
  ledger: RunningLedger;
  gateway: RunningGateway;
  payments: RunningPayments;
  recon: RunningRecon;
  merchant: { id: string; apiKey: string };
  uid: () => string;
  /** A funded customer wallet (via the real top-up endpoint). */
  customer(funds?: number): Promise<string>;
  pay(customerId: string, amount: number): Promise<{ status: number; body: any }>;
  refund(paymentId: string, amount?: number): Promise<{ status: number; body: any }>;
  adminRecovery(): Promise<void>;
  /** Run a reconciliation and return it with its findings. */
  reconcile(kind: 'internal' | 'external'): Promise<NonNullable<Awaited<ReturnType<RunningRecon['reconciler']['run']>>>>;
  close(): Promise<void>;
}

export async function startStack(opts: { recon?: Partial<ReconConfig>; pageSize?: number; reconOverrides?: Partial<ReconAppOptions> } = {}): Promise<Stack> {
  const [l, g, p, r] = await Promise.all([createTestDatabase(), createTestDatabase(), createTestDatabase(), createTestDatabase()]);
  const ledger = await startLedger({ databaseUrl: l.url, port: 0, holdSweepIntervalSeconds: 0, logLevel: 'silent' });
  const gateway = await startGateway({ databaseUrl: g.url, port: 0, logLevel: 'silent' });
  const payments = await startPayments({
    databaseUrl: p.url, port: 0, ledgerUrl: ledger.url, gatewayUrl: gateway.url, recoveryScheduler: false, logLevel: 'silent', ledgerTimeoutMs: 3_000,
    config: { recoveryStuckAfterSeconds: 0, leaseSeconds: 5 },
    gatewayClient: { timeoutMs: 1_000, retries: 1, retryBaseMs: 10, breaker: { resetTimeoutMs: 400, volumeThreshold: 6 } },
  });
  const recon = await startReconciliation({
    databaseUrl: r.url, port: 0, logLevel: 'silent', adminToken: 'recon-admin-token',
    sources: createHttpSources({ ledgerUrl: ledger.url, paymentsUrl: payments.url, gatewayUrl: gateway.url, paymentsAdminToken: payments.config.adminToken, pageSize: opts.pageSize }),
    config: { graceMs: 0, confirmDelayMs: 0, stuckAfterMs: 60 * 60_000, ...opts.recon },
    ...opts.reconOverrides,
  });

  const m = (await (await fetch(`${payments.url}/admin/merchants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': payments.config.adminToken }, body: JSON.stringify({ name: 'recon shop' }) })).json()) as { id: string; apiKey: string };
  const call = async (path: string, body: unknown, idem: string) => {
    const res = await fetch(`${payments.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${m.apiKey}`, 'idempotency-key': idem }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const uid = () => randomUUID().slice(0, 8);

  return {
    ledger, gateway, payments, recon, merchant: m, uid,
    customer: async (funds = 100_000) => {
      const id = `cust-${uid()}`;
      await call(`/v1/customers/${id}/topups`, { amountMinor: String(funds) }, `tu-${uid()}`);
      return id;
    },
    pay: (customerId, amount) => call('/v1/payments', { customerId, amountMinor: String(amount) }, `pay-${uid()}`),
    refund: (paymentId, amount) => call(`/v1/payments/${paymentId}/refunds`, amount ? { amountMinor: String(amount) } : {}, `ref-${uid()}`),
    adminRecovery: async () => void (await fetch(`${payments.url}/internal/recovery/run`, { method: 'POST', headers: { 'x-admin-token': payments.config.adminToken } })),
    reconcile: async (kind) => {
      const run = await recon.reconciler.run(kind, { trigger: 'manual' });
      if (!run) throw new Error('run was locked');
      return run;
    },
    close: async () => {
      await recon.close();
      await payments.close();
      await gateway.close();
      await ledger.close();
    },
  };
}
