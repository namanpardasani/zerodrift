import { randomUUID } from 'node:crypto';
import { waitFor } from '@zerodrift/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './harness.js';

let s: Stack;
/** A fresh merchant per test, so one test's leftovers can never change another test's balances. */
let M: Stack['merchant'];
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());
beforeEach(async () => {
  s.gateway.faults.reset();
  s.ledgerProxy.down = false;
  s.ledgerProxy.dropPaths = [];
  s.payments.config.recoveryAbandonAfterSeconds = 300;
  s.payments.gateway.resetCircuit(); // the breaker is shared state; give every test a closed circuit
  await recover(); // settle anything a previous test left in flight, for a clean slate
  M = await s.newMerchant();
});

const uid = () => randomUUID().slice(0, 8);

/** A funded customer wallet (via the real top-up endpoint). */
async function customer(funds = 100_000n) {
  const customerId = `cust-${uid()}`;
  if (funds > 0n) {
    const r = await s.api(`/v1/customers/${customerId}/topups`, { key: M.apiKey, idempotencyKey: `topup-${uid()}`, body: { amountMinor: funds.toString() } });
    expect(r.status).toBe(201);
  }
  return customerId;
}

const pay = (customerId: string, amount: bigint | number, idempotencyKey = `pay-${uid()}`, key = M.apiKey) =>
  s.api('/v1/payments', { key, idempotencyKey, body: { customerId, amountMinor: amount.toString() } });

const wallet = async (id: string) => (await fetch(`${s.ledger.url}/accounts/${id}`).then((r) => r.json())) as { availableMinor: string; heldMinor: string };
const customerWallet = async (customerId: string) => {
  const a = (await s.payments.ledger.wallet('customer', customerId)) as { availableMinor: string; heldMinor: string };
  return { available: BigInt(a.availableMinor), held: BigInt(a.heldMinor) };
};
const merchantAvailable = async (m = M) => BigInt((await wallet(m.ledgerAccountId)).availableMinor);
const feesAvailable = async () => BigInt((await wallet(await s.payments.ledger.systemAccountId('fees'))).availableMinor);
const invariants = async () => (await fetch(`${s.ledger.url}/internal/invariants`).then((r) => r.json())) as { ok: boolean };
const recover = async () => (await s.api('/internal/recovery/run', { method: 'POST', body: {}, headers: { 'x-admin-token': s.payments.config.adminToken } })).body;
const getPayment = async (id: string) => (await s.api(`/v1/payments/${id}`, { key: M.apiKey })).body;
const gatewayCharge = async (ref: string) => fetch(`${s.gateway.url}/charges/${ref}`).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('happy path', () => {
  it('hold -> gateway -> capture: succeeds, splits the fee, records a timeline and outbox events', async () => {
    const c = await customer(10_000n);
    const [m0, f0] = [await merchantAvailable(), await feesAvailable()];
    const r = await pay(c, 4_000);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('succeeded');
    expect(r.body.feeMinor).toBe('100'); // 2.5% of 4000

    expect(await customerWallet(c)).toEqual({ available: 6_000n, held: 0n });
    expect((await merchantAvailable()) - m0).toBe(3_900n);
    expect((await feesAvailable()) - f0).toBe(100n);

    const p = await getPayment(r.body.id);
    expect(p.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['created', 'processing', 'succeeded']);

    const events = await s.payments.db.selectFrom('outbox').select(['event_type', 'aggregate_id']).where('aggregate_id', '=', r.body.id).execute();
    expect(events.map((e) => e.event_type).sort()).toEqual(['payment.created', 'payment.succeeded']);
    expect((await invariants()).ok).toBe(true);
  });

  it('a payment with insufficient funds fails cleanly without ever calling the gateway', async () => {
    const c = await customer(100n);
    const r = await pay(c, 5_000);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('failed');
    expect(r.body.failureReason).toBe('insufficient_funds');
    expect((await gatewayCharge(r.body.id)).status).toBe(404);
    expect(await customerWallet(c)).toEqual({ available: 100n, held: 0n });
  });

  it('a bank decline releases the hold and fails the payment', async () => {
    s.gateway.faults.set({ declineRate: 1 });
    const c = await customer(10_000n);
    const r = await pay(c, 3_000);
    expect(r.body.status).toBe('failed');
    expect(r.body.failureReason).toBe('declined_by_bank');
    expect(await customerWallet(c)).toEqual({ available: 10_000n, held: 0n });
    expect((await invariants()).ok).toBe(true);
  });
});

describe('idempotency', () => {
  it('replays the stored response, rejects a different body (422) and requires the header (400)', async () => {
    const c = await customer(10_000n);
    const key = `idem-${uid()}`;
    const first = await pay(c, 1_000, key);
    const again = await pay(c, 1_000, key);
    expect(again.status).toBe(first.status);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await customerWallet(c)).toEqual({ available: 9_000n, held: 0n }); // charged once

    expect((await pay(c, 1_001, key)).status).toBe(422);
    expect((await s.api('/v1/payments', { key: M.apiKey, body: { customerId: c, amountMinor: '5' } })).status).toBe(400);
  });

  it('20 concurrent duplicates: exactly one payment, one hold, one gateway charge, customer charged once', async () => {
    const c = await customer(50_000n);
    const key = `dup-${uid()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => pay(c, 2_000, key)));
    // Under heavy contention a request may legitimately answer 409 (in progress), 202 (outcome not
    // known yet) or 503 (ledger slow); none of them may ever execute the payment twice.
    const odd = results.filter((r) => ![200, 201, 202, 409, 503].includes(r.status)).map((r) => `${r.status}:${JSON.stringify(r.body)}`);
    expect(odd, 'unexpected responses').toEqual([]);

    // Converge: under load the original request may still hold the payment's lease, in which case
    // recovery (correctly) skips it, so keep nudging until it settles.
    await waitFor(async () => {
      await recover();
      const r = await s.payments.db.selectFrom('payments').select('status').where('customer_id', '=', c).execute();
      return r.length === 1 && r[0]!.status === 'succeeded';
    }, 30_000, 250);
    const rows = await s.payments.db.selectFrom('payments').select(['id', 'status']).where('customer_id', '=', c).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('succeeded');
    expect((await gatewayCharge(rows[0]!.id)).body.status).toBe('succeeded');
    const holds = await s.ledger.pool.query('SELECT count(*)::int AS n FROM holds WHERE reference_id = $1', [rows[0]!.id]);
    expect(holds.rows[0].n).toBe(1);
    expect(await customerWallet(c)).toEqual({ available: 48_000n, held: 0n }); // charged exactly once
    // after completion every later duplicate gets the stored result
    const replay = await pay(c, 2_000, key);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(rows[0]!.id);
  });
});

describe('unknown outcomes (timeouts are NOT failures)', () => {
  it('gateway 5xx: payment stays processing with funds held; recovery then completes it exactly once', async () => {
    s.gateway.faults.set({ errorRate: 1 });
    const c = await customer(10_000n);
    const r = await pay(c, 2_000);
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('processing');
    expect(await customerWallet(c)).toEqual({ available: 8_000n, held: 2_000n }); // held, not released, not spent

    s.gateway.faults.reset();
    const summary = await recover();
    expect(summary.paymentsSettled).toBeGreaterThanOrEqual(1);
    const p = await getPayment(r.body.id);
    expect(p.status).toBe('succeeded');
    expect(await customerWallet(c)).toEqual({ available: 8_000n, held: 0n });
    expect((await recover()).paymentsSettled).toBe(0); // nothing left to do
    expect((await invariants()).ok).toBe(true);
  });

  it('LOST RESPONSE (bank charged, reply never arrived), callback dropped: recovery queries the bank and captures once', async () => {
    s.gateway.faults.set({ lostResponseRate: 1, callbackDropRate: 1 });
    const c = await customer(10_000n);
    const m0 = await merchantAvailable();
    const r = await pay(c, 2_000);
    expect(r.status).toBe(202);
    expect((await gatewayCharge(r.body.id)).body.status).toBe('succeeded'); // money DID move at the bank
    expect((await getPayment(r.body.id)).status).toBe('processing'); // ...but we did not know

    s.gateway.faults.reset();
    const summary = await recover();
    const after = await getPayment(r.body.id);
    expect(after.status, `recovery=${JSON.stringify(summary)} events=${JSON.stringify(after.events)}`).toBe('succeeded');
    expect((await merchantAvailable()) - m0).toBe(1_950n); // credited exactly once
    await recover();
    await recover();
    expect((await merchantAvailable()) - m0).toBe(1_950n);
    expect((await invariants()).ok).toBe(true);
  });

  it('lost response but the async callback arrives: resolves by itself, no recovery run needed', async () => {
    s.gateway.faults.set({ lostResponseRate: 1 });
    const c = await customer(10_000n);
    const r = await pay(c, 1_500);
    expect(r.status).toBe(202);
    const done = await waitFor(async () => {
      const p = await getPayment(r.body.id);
      return p.status === 'succeeded' ? p : false;
    }, 8_000);
    expect(done.status).toBe('succeeded');
  });

  it('duplicate callbacks are harmless: merchant credited exactly once', async () => {
    s.gateway.faults.set({ lostResponseRate: 1, duplicateCallbackRate: 1 });
    const c = await customer(10_000n);
    const m0 = await merchantAvailable();
    const r = await pay(c, 2_000);
    await waitFor(async () => ((await getPayment(r.body.id)).status === 'succeeded' ? true : false), 8_000);
    await new Promise((res) => setTimeout(res, 1_000)); // let the duplicates land
    expect((await merchantAvailable()) - m0).toBe(1_950n);
    const captures = s.ledgerProxy.forwarded.filter((f) => f.includes('/capture')).length;
    expect(captures).toBeGreaterThanOrEqual(1);
    expect((await invariants()).ok).toBe(true);
  });

  it('a payment the bank never heard of is ABANDONED by recovery: tombstoned, hold released, a late charge is refused', async () => {
    s.gateway.faults.set({ errorRate: 1 });
    const c = await customer(10_000n);
    const r = await pay(c, 2_000);
    expect(r.body.status).toBe('processing');

    s.gateway.faults.reset();
    s.payments.config.recoveryAbandonAfterSeconds = 0; // treat it as old enough
    await recover();
    const p = await getPayment(r.body.id);
    expect(p.status).toBe('failed');
    expect(await customerWallet(c)).toEqual({ available: 10_000n, held: 0n });
    // a delayed duplicate of the original charge request arrives now: the tombstone refuses it
    const late = await fetch(`${s.gateway.url}/charges`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: r.body.id, amountMinor: '2000' }) }).then((x) => x.json());
    expect(late.status).toBe('cancelled');
  });

  it('ledger unreachable at CAPTURE (bank already charged): stays processing, then captured exactly once', async () => {
    s.ledgerProxy.dropPaths = ['/capture'];
    const c = await customer(10_000n);
    const m0 = await merchantAvailable();
    const r = await pay(c, 2_000);
    expect(r.status).toBe(202);
    expect((await gatewayCharge(r.body.id)).body.status).toBe('succeeded');
    expect(await customerWallet(c)).toEqual({ available: 8_000n, held: 2_000n });

    s.ledgerProxy.dropPaths = [];
    await recover();
    expect((await getPayment(r.body.id)).status).toBe('succeeded');
    expect((await merchantAvailable()) - m0).toBe(1_950n);
    expect(await customerWallet(c)).toEqual({ available: 8_000n, held: 0n });
    expect((await invariants()).ok).toBe(true);
  });

  it('ledger unreachable at HOLD: stays processing with nothing held; recovery finishes the whole saga', async () => {
    s.ledgerProxy.dropPaths = ['/holds'];
    const c = await customer(10_000n);
    const r = await pay(c, 2_000);
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('processing');
    expect((await gatewayCharge(r.body.id)).status).toBe(404); // the bank was never asked: no hold, no charge

    s.ledgerProxy.dropPaths = [];
    await recover();
    expect((await getPayment(r.body.id)).status).toBe('succeeded');
    expect(await customerWallet(c)).toEqual({ available: 8_000n, held: 0n });
  });

  it('ledger fully down before anything is created: 503, and the SAME key works once it is back', async () => {
    const c = await customer(10_000n);
    s.ledgerProxy.down = true;
    const key = `retry-${uid()}`;
    const failed = await pay(c, 1_000, key);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('ledger_unavailable');
    s.ledgerProxy.down = false;
    const ok = await pay(c, 1_000, key);
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('succeeded');
  });

  it('a hold that expired while the outcome was unknown: bank charge is VOIDED and the payment fails', async () => {
    s.gateway.faults.set({ lostResponseRate: 1, callbackDropRate: 1 });
    const c = await customer(10_000n);
    const r = await pay(c, 2_000);
    expect(r.body.status).toBe('processing');
    // the hold lapses before recovery runs
    await s.ledger.pool.query("UPDATE holds SET expires_at = now() - interval '1 second' WHERE reference_id = $1", [r.body.id]);
    await fetch(`${s.ledger.url}/internal/holds/expire`, { method: 'POST' });

    s.gateway.faults.reset();
    await recover();
    const p = await getPayment(r.body.id);
    expect(p.status).toBe('failed');
    expect((await gatewayCharge(r.body.id)).body.status).toBe('voided'); // customer is not charged at the bank
    expect(await customerWallet(c)).toEqual({ available: 10_000n, held: 0n });
    expect((await invariants()).ok).toBe(true);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated gateway failures, fails fast, then closes again when the gateway recovers', async () => {
    s.gateway.faults.set({ errorRate: 1 });
    const c = await customer(1_000_000n);
    for (let i = 0; i < 6 && !s.payments.gateway.circuitOpen; i++) await pay(c, 100);
    expect(s.payments.gateway.circuitOpen).toBe(true);

    const t0 = Date.now();
    const fast = await pay(c, 100);
    expect(fast.status).toBe(202); // unknown, NOT failed
    expect(Date.now() - t0).toBeLessThan(300); // failed fast: no timeout wait, no retries

    s.gateway.faults.reset();
    await new Promise((r) => setTimeout(r, 600)); // > resetTimeout: next call is the half-open probe
    const probe = await pay(c, 100);
    expect(probe.body.status).toBe('succeeded');
    expect(s.payments.gateway.circuitOpen).toBe(false);

    await recover(); // the payments that were short-circuited complete now
    const stuck = await s.payments.db.selectFrom('payments').select('id').where('customer_id', '=', c).where('status', 'in', ['created', 'processing']).execute();
    expect(stuck).toHaveLength(0);
    expect((await invariants()).ok).toBe(true);
  });
});

describe('refunds', () => {
  const refund = (paymentId: string, body: object = {}, idempotencyKey = `ref-${uid()}`) => s.api(`/v1/payments/${paymentId}/refunds`, { key: M.apiKey, idempotencyKey, body });

  it('partial then remaining refund: money and fee flow back exactly, statuses move to partially_refunded then refunded', async () => {
    const c = await customer(20_000n);
    const [m0, f0, c0] = [await merchantAvailable(), await feesAvailable(), await customerWallet(c)];
    const p = (await pay(c, 10_000)).body; // fee 250
    expect(p.status).toBe('succeeded');

    const r1 = await refund(p.id, { amountMinor: '4000' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('succeeded');
    expect(r1.body.feeRefundMinor).toBe('100'); // 250 * 4000 / 10000
    expect((await getPayment(p.id)).status).toBe('partially_refunded');
    expect((await customerWallet(c)).available).toBe(c0.available - 10_000n + 4_000n);

    const r2 = await refund(p.id); // default = everything still refundable
    expect(r2.body.amountMinor).toBe('6000');
    expect(r2.body.feeRefundMinor).toBe('150'); // fee shares sum to exactly the fee
    const after = await getPayment(p.id);
    expect(after.status).toBe('refunded');
    expect(after.refundedMinor).toBe('10000');

    expect(await customerWallet(c)).toEqual(c0); // customer whole again
    expect(await merchantAvailable()).toBe(m0); // merchant net zero
    expect(await feesAvailable()).toBe(f0); // platform returned its fee
    expect(after.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['created', 'processing', 'succeeded', 'partially_refunded', 'refunded']);
    expect((await invariants()).ok).toBe(true);
  });

  it('rejects refunding more than was paid, and refunding a payment that did not succeed', async () => {
    const c = await customer(10_000n);
    const p = (await pay(c, 1_000)).body;
    const over = await refund(p.id, { amountMinor: '1001' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('refund_exceeds_payment');

    s.gateway.faults.set({ declineRate: 1 });
    const failed = (await pay(c, 1_000)).body;
    s.gateway.faults.reset();
    const r = await refund(failed.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('payment_not_refundable');
  });

  it('10 concurrent refunds of 60%: exactly one wins (reservation under the payment row lock)', async () => {
    const c = await customer(10_000n);
    const p = (await pay(c, 5_000)).body;
    const results = await Promise.all(Array.from({ length: 10 }, () => refund(p.id, { amountMinor: '3000' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await getPayment(p.id)).refundedMinor).toBe('3000');
    expect((await invariants()).ok).toBe(true);
  });

  it('is idempotent and detects key reuse with a different amount', async () => {
    const c = await customer(10_000n);
    const p = (await pay(c, 2_000)).body;
    const key = `ref-${uid()}`;
    const a = await refund(p.id, { amountMinor: '500' }, key);
    const b = await refund(p.id, { amountMinor: '500' }, key);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect((await getPayment(p.id)).refundedMinor).toBe('500'); // refunded once
    expect((await refund(p.id, { amountMinor: '501' }, key)).status).toBe(422);
  });

  it('fails cleanly when the merchant has already spent the money, and the amount stays refundable', async () => {
    const m = await s.newMerchant();
    const c = await customer(10_000n);
    const p = (await s.api('/v1/payments', { key: m.apiKey, idempotencyKey: `pay-${uid()}`, body: { customerId: c, amountMinor: '4000' } })).body;
    expect(p.status).toBe('succeeded');
    // merchant moves all its money elsewhere
    const sink = await s.payments.ledger.wallet('merchant', `sink-${uid()}`);
    const bal = BigInt((await wallet(m.ledgerAccountId)).availableMinor);
    await fetch(`${s.ledger.url}/transfers`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `drain-${uid()}` }, body: JSON.stringify({ fromAccountId: m.ledgerAccountId, toAccountId: sink.id, amountMinor: bal.toString() }) });

    const r = await s.api(`/v1/payments/${p.id}/refunds`, { key: m.apiKey, idempotencyKey: `ref-${uid()}`, body: {} });
    expect(r.body.status).toBe('failed');
    expect(r.body.failureReason).toBe('insufficient_funds');
    const stillPaid = (await s.api(`/v1/payments/${p.id}`, { key: m.apiKey })).body;
    expect(stillPaid.status).toBe('succeeded');

    // refill the merchant: the full amount can be refunded after all (reservation was released)
    await fetch(`${s.ledger.url}/transfers`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `refill-${uid()}` }, body: JSON.stringify({ fromAccountId: sink.id, toAccountId: m.ledgerAccountId, amountMinor: bal.toString() }) });
    const ok = await s.api(`/v1/payments/${p.id}/refunds`, { key: m.apiKey, idempotencyKey: `ref-${uid()}`, body: {} });
    expect(ok.body.status).toBe('succeeded');
    expect((await invariants()).ok).toBe(true);
  });

  it('a refund stuck because the ledger was unreachable is finished by recovery, once', async () => {
    const c = await customer(10_000n);
    const p = (await pay(c, 2_000)).body;
    s.ledgerProxy.dropPaths = ['/transactions'];
    const r = await refund(p.id, { amountMinor: '2000' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('pending');
    s.ledgerProxy.dropPaths = [];
    const summary = await recover();
    expect(summary.refundsSettled).toBe(1);
    expect((await getPayment(p.id)).status).toBe('refunded');
    await recover();
    expect(await customerWallet(c)).toEqual({ available: 10_000n, held: 0n });
  });
});

describe('auth and tenancy', () => {
  it('rejects missing and wrong API keys; other merchants cannot see your payments', async () => {
    const c = await customer(5_000n);
    const p = (await pay(c, 1_000)).body;
    expect((await s.api(`/v1/payments/${p.id}`)).status).toBe(401);
    expect((await s.api(`/v1/payments/${p.id}`, { key: 'zd_live_wrong' })).status).toBe(401);
    const other = await s.newMerchant();
    expect((await s.api(`/v1/payments/${p.id}`, { key: other.apiKey })).status).toBe(404);
    expect((await s.api(`/v1/payments/${p.id}/refunds`, { key: other.apiKey, idempotencyKey: `x-${uid()}`, body: {} })).status).toBe(404);
  });

  it('API keys are stored only as hashes; admin endpoints need the admin token', async () => {
    const row = await s.payments.db.selectFrom('merchants').selectAll().where('id', '=', M.id).executeTakeFirstOrThrow();
    expect(row.api_key_hash).not.toContain(M.apiKey);
    expect(row.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await s.api('/admin/merchants', { method: 'POST', body: { name: 'x' } })).status).toBe(401);
    expect((await s.api('/internal/recovery/run', { method: 'POST', body: {} })).status).toBe(401);
  });

  it('validates input', async () => {
    const c = await customer(1_000n);
    for (const bad of [{ customerId: c, amountMinor: '1.5' }, { customerId: c, amountMinor: '-1' }, { customerId: c, amountMinor: '0' }, { customerId: '', amountMinor: '5' }, { customerId: c, amountMinor: '5', currency: 'USD' }]) {
      const r = await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: `v-${uid()}`, body: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('recovery housekeeping', () => {
  it('closes an idempotency key left in_progress by a request that died after the payment settled', async () => {
    const c = await customer(5_000n);
    const key = `orphan-${uid()}`;
    const p = (await pay(c, 1_000, key)).body;
    // simulate the requester dying before it could store the response
    await s.payments.db.updateTable('idempotency_keys').set({ status: 'in_progress', response_status: null, response_snapshot: null }).where('key', '=', key).execute();
    expect((await pay(c, 1_000, key)).status).toBe(409); // still "running" as far as anyone can tell
    const summary = await recover();
    expect(summary.idempotencyKeysClosed).toBeGreaterThanOrEqual(1);
    const retry = await pay(c, 1_000, key);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(p.id);
  });
});
