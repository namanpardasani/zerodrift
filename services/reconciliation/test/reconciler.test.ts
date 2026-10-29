import { createTestDatabase } from '@zerodrift/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReconciliation, type RunningRecon } from '../src/app.js';
import type { InvariantReport } from '../src/checks/internal.js';
import { SourceUnavailable, type Sources, createHttpSources } from '../src/sources.js';
import type { FeedPayment, GatewayCharge } from '../src/types.js';

/** Reconciler behaviour (confirm pass, failure handling, locking) with scripted fake data sources. */

const CLEAN: InvariantReport = { ok: true, totalBalanceMinor: '0', unbalancedTransactions: [], balanceMismatches: [], heldMismatches: [], negativeBalances: [] };
const now = new Date();
const payment = (over: Partial<FeedPayment> = {}): FeedPayment => ({
  id: 'p-1', merchantId: 'm', customerAccountId: 'c', merchantLedgerAccountId: 'ma', amountMinor: '1000', feeMinor: '25', currency: 'INR',
  status: 'succeeded', ledgerTxId: 'tx-1', refundedMinor: '0', createdAt: new Date(now.getTime() - 3_600_000).toISOString(), updatedAt: now.toISOString(), refunds: [], ...over,
});
const charge = (over: Partial<GatewayCharge> = {}): GatewayCharge => ({ reference: 'p-1', amountMinor: '1000', currency: 'INR', status: 'succeeded', createdAt: new Date(now.getTime() - 3_600_000).toISOString(), ...over });

/** Sources whose answers can change between calls. */
function scripted(initial: { payments: FeedPayment[]; charges: GatewayCharge[] }) {
  const data = { ...initial, down: false, delayMs: 0, calls: 0 };
  const src: Sources = {
    invariants: async () => CLEAN,
    ledgerTransactions: async (type) => (type === 'payment' ? [{ id: 'tx-1', type: 'payment', referenceId: 'p-1', createdAt: data.payments[0]?.createdAt ?? now.toISOString(), entries: [{ accountId: 'c', direction: 'debit' as const, amountMinor: '1000' }, { accountId: 'ma', direction: 'credit' as const, amountMinor: '975' }, { accountId: 'fees', direction: 'credit' as const, amountMinor: '25' }] }] : []),
    payments: async () => {
      data.calls++;
      if (data.delayMs) await new Promise((r) => setTimeout(r, data.delayMs));
      if (data.down) throw new SourceUnavailable('payments unreachable (test)');
      return data.payments;
    },
    settlement: async () => data.charges,
  };
  return { src, data };
}

const recons: RunningRecon[] = [];
async function start(src: Sources, config: Record<string, number> = {}) {
  const { url } = await createTestDatabase();
  const r = await startReconciliation({ databaseUrl: url, port: 0, logLevel: 'silent', adminToken: 'tok-tok-tok', sources: src, config: { graceMs: 0, confirmDelayMs: 0, stuckAfterMs: 3_600_000 * 10, ...config } });
  recons.push(r);
  return r;
}
afterAll(async () => {
  for (const r of recons) await r.close();
});

describe('confirm pass: transient findings are not reported', () => {
  it('a mismatch that disappears between the two passes is dropped; one that persists is reported', async () => {
    const { src, data } = scripted({ payments: [payment()], charges: [] }); // bank has no charge: missing_in_gateway
    const r = await start(src, { confirmDelayMs: 50 });
    // the second pass (50ms later) sees the bank charge appear: it was only in flight
    const origSettlement = src.settlement;
    let n = 0;
    src.settlement = async (d) => (++n >= 2 ? [charge()] : origSettlement(d));
    const transient = (await r.reconciler.run('external'))!;
    expect(transient.status).toBe('clean');
    expect(transient.mismatches).toEqual([]);

    // now it persists on both passes
    src.settlement = async () => [];
    data.calls = 0;
    const persistent = (await r.reconciler.run('external'))!;
    expect(persistent.status).toBe('mismatches');
    expect(persistent.mismatches).toHaveLength(1);
    expect(persistent.mismatches![0]).toMatchObject({ kind: 'missing_in_gateway', reference: 'p-1', severity: 'critical' });
    expect(data.calls).toBe(2); // exactly two passes were made
  });
});

describe('failure handling', () => {
  it('a source being down FAILS the run with the reason: never "clean", never invented mismatches', async () => {
    const { src, data } = scripted({ payments: [payment()], charges: [charge()] });
    data.down = true;
    const r = await start(src);
    const run = (await r.reconciler.run('internal'))!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('payments unreachable');
    expect(run.mismatches).toEqual([]);
    expect(run.finishedAt).not.toBeNull();

    data.down = false; // the next run succeeds
    expect((await r.reconciler.run('internal'))!.status).toBe('clean');
  });

  it('real HTTP sources: an unreachable service surfaces as a failed run', async () => {
    const src = createHttpSources({ ledgerUrl: 'http://127.0.0.1:9', paymentsUrl: 'http://127.0.0.1:9', gatewayUrl: 'http://127.0.0.1:9', paymentsAdminToken: 'x'.repeat(8) });
    const r = await start(src);
    const run = (await r.reconciler.run('external'))!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/unreachable/);
  });
});

describe('only one run of a kind at a time', () => {
  it('a concurrent second run is refused (lock), while the other kind is unaffected', async () => {
    const { src, data } = scripted({ payments: [payment()], charges: [charge()] });
    data.delayMs = 400;
    const r = await start(src);
    const first = r.reconciler.run('internal');
    await new Promise((x) => setTimeout(x, 100));
    expect(await r.reconciler.run('internal')).toBeNull(); // locked
    const other = r.reconciler.run('external'); // different kind: allowed
    expect((await first)!.status).toBe('clean');
    expect((await other)!.status).toBe('clean');
    expect((await r.reconciler.run('internal'))!.status).toBe('clean'); // lock released afterwards
  });

  it('the lock is shared across replicas (separate processes/pools on one database)', async () => {
    const { src, data } = scripted({ payments: [payment()], charges: [charge()] });
    data.delayMs = 400;
    const { url } = await createTestDatabase();
    const mk = () => startReconciliation({ databaseUrl: url, port: 0, logLevel: 'silent', adminToken: 'tok-tok-tok', sources: src, config: { graceMs: 0, confirmDelayMs: 0 } });
    const [a, b] = [await mk(), await mk()];
    recons.push(a, b);
    const results = await Promise.all([a.reconciler.run('internal'), b.reconciler.run('internal')]);
    expect(results.filter((x) => x === null)).toHaveLength(1); // exactly one replica did the work
    const runs = await a.db.selectFrom('recon_runs').select('id').execute();
    expect(runs).toHaveLength(1);
  });
});

describe('scheduler', () => {
  it('runs internal and external reconciliations on its own', async () => {
    const { src } = scripted({ payments: [payment()], charges: [charge()] });
    const { url } = await createTestDatabase();
    const r = await startReconciliation({ databaseUrl: url, port: 0, logLevel: 'silent', adminToken: 'tok-tok-tok', sources: src, config: { graceMs: 0, confirmDelayMs: 0 }, scheduleMs: { internal: 150, external: 150 } });
    recons.push(r);
    const deadline = Date.now() + 15_000;
    let runs: { kind: string; trigger: string }[] = [];
    while (Date.now() < deadline) {
      runs = await r.db.selectFrom('recon_runs').select(['kind', 'trigger']).where('status', '!=', 'running').execute();
      if (runs.filter((x) => x.kind === 'internal').length >= 2 && runs.filter((x) => x.kind === 'external').length >= 2) break;
      await new Promise((x) => setTimeout(x, 100));
    }
    expect(runs.filter((x) => x.kind === 'internal').length).toBeGreaterThanOrEqual(2);
    expect(runs.filter((x) => x.kind === 'external').length).toBeGreaterThanOrEqual(2);
    expect(runs.every((x) => x.trigger === 'scheduled')).toBe(true);
  });
});

describe('API', () => {
  let r: RunningRecon;
  beforeAll(async () => {
    const { src } = scripted({ payments: [payment()], charges: [] }); // external run will find 1 mismatch
    r = await start(src);
  });
  const api = (path: string, init: RequestInit & { token?: string | null } = {}) =>
    fetch(`${r.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.token === null ? {} : { 'x-admin-token': init.token ?? 'tok-tok-tok' }) } }).then(async (res) => ({ status: res.status, body: (await res.json()) as any }));

  it('needs the admin token', async () => {
    expect((await api('/v1/recon/runs', { token: null })).status).toBe(401);
    expect((await api('/v1/recon/runs', { token: 'wrong-token' })).status).toBe(401);
  });

  it('manual run -> stored report with findings; list, get, latest', async () => {
    const run = await api('/v1/recon/runs', { method: 'POST', body: JSON.stringify({ kind: 'external' }) });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ kind: 'external', trigger: 'manual', status: 'mismatches' });
    expect(run.body.mismatches[0]).toMatchObject({ kind: 'missing_in_gateway', reference: 'p-1', severity: 'critical' });
    expect(run.body.summary).toMatchObject({ paymentsChecked: 1, mismatchesBySeverity: { critical: 1 }, mismatchesByKind: { missing_in_gateway: 1 } });

    const list = await api('/v1/recon/runs?kind=external');
    expect(list.body.runs.map((x: { id: string }) => x.id)).toContain(run.body.id);
    const one = await api(`/v1/recon/runs/${run.body.id}`);
    expect(one.body.mismatches).toHaveLength(1);
    expect((await api('/v1/recon/runs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const latest = await api('/v1/recon/latest');
    expect(latest.body.external.id).toBe(run.body.id);
    expect(latest.body.internal).toBeNull();
  });

  it('validates input', async () => {
    expect((await api('/v1/recon/runs', { method: 'POST', body: JSON.stringify({ kind: 'nonsense' }) })).status).toBe(400);
    expect((await api('/v1/recon/runs', { method: 'POST', body: JSON.stringify({ kind: 'internal', from: 'yesterday' }) })).status).toBe(400);
  });

  it('answers 409 when that kind is already running', async () => {
    const { src, data } = scripted({ payments: [payment()], charges: [charge()] });
    data.delayMs = 500;
    const slow = await start(src);
    const post = () => fetch(`${slow.url}/v1/recon/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'tok-tok-tok' }, body: JSON.stringify({ kind: 'internal' }) });
    const first = post();
    await new Promise((x) => setTimeout(x, 150));
    const second = await post();
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });
});
