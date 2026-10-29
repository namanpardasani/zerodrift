import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpSources } from '../src/sources.js';
import { type Stack, startStack } from './harness.js';

/**
 * The feeds are paged by (created_at, id). Postgres timestamps have MICROsecond precision while a
 * JS Date only has milliseconds, so a cursor built from a Date would re-return the row it came from
 * (and could loop forever). Rows created in the same millisecond are the nasty case: force many.
 */
let s: Stack;
beforeAll(async () => {
  s = await startStack({ pageSize: 1 });
});
afterAll(() => s.close());

describe('keyset paging', () => {
  it('paging one row at a time yields every payment and ledger transaction exactly once', async () => {
    const customers = await Promise.all(Array.from({ length: 8 }, () => s.customer(50_000)));
    const paid = await Promise.all(customers.map((c) => s.pay(c, 1_000))); // concurrent => near-identical timestamps
    expect(paid.every((p) => p.body.status === 'succeeded')).toBe(true);

    const window = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) };
    const src = createHttpSources({ ledgerUrl: s.ledger.url, paymentsUrl: s.payments.url, gatewayUrl: s.gateway.url, paymentsAdminToken: s.payments.config.adminToken, pageSize: 1 });

    const payments = await src.payments(window.from, window.to);
    expect(payments).toHaveLength(8);
    expect(new Set(payments.map((p) => p.id)).size).toBe(8); // no duplicates
    expect(new Set(payments.map((p) => p.id))).toEqual(new Set(paid.map((p) => p.body.id))); // no omissions

    const txs = await src.ledgerTransactions('payment', window.from, window.to);
    expect(txs).toHaveLength(8);
    expect(new Set(txs.map((t) => t.id)).size).toBe(8);

    // ordered by (created_at, id) as promised
    const times = payments.map((p) => p.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('a one-row page size reconciles to the same result as the default page size', async () => {
    const run = await s.reconcile('internal');
    expect(run.status, JSON.stringify(run.mismatches)).toBe('clean');
    expect(run.summary!.paymentsChecked).toBe(8);
    expect(run.summary!.ledgerTransactionsChecked).toBe(8);
  });

  it('rejects malformed cursors and timestamps instead of misbehaving', async () => {
    const bad = await fetch(`${s.payments.url}/internal/reconciliation/payments?after=garbage`, { headers: { 'x-admin-token': s.payments.config.adminToken } });
    expect(bad.status).toBe(400);
    const badTime = await fetch(`${s.payments.url}/internal/reconciliation/payments?from=yesterday`, { headers: { 'x-admin-token': s.payments.config.adminToken } });
    expect(badTime.status).toBe(400);
    expect((await fetch(`${s.payments.url}/internal/reconciliation/payments`)).status).toBe(401); // feed is operator-only
    expect((await fetch(`${s.ledger.url}/internal/transactions?after=garbage`)).status).toBe(400);
  });
});
