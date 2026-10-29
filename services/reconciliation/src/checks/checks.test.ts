import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FeedPayment, GatewayCharge, LedgerTx } from '../types.js';
import { compareToSettlement } from './external.js';
import { type InvariantReport, invariantsToMismatches } from './internal.js';
import { comparePaymentsToLedger } from './payments-ledger.js';

const T0 = Date.parse('2026-10-28T10:00:00Z');
const window = { from: new Date('2026-10-28T00:00:00Z'), to: new Date('2026-10-29T00:00:00Z') };
const now = new Date('2026-10-28T12:00:00Z');
const iso = (n: number) => new Date(T0 + n * 1000).toISOString();

interface World {
  payments: FeedPayment[];
  txs: LedgerTx[];
  charges: GatewayCharge[];
}

/** A fully consistent world: every settled payment has its ledger movement and its bank charge. */
function consistentWorld(specs: { amount: number; feeBps: number; kind: 'succeeded' | 'failed' | 'refunded' }[]): World {
  const w: World = { payments: [], txs: [], charges: [] };
  specs.forEach((s, i) => {
    const id = `p${i}`;
    const amount = BigInt(s.amount);
    const fee = (amount * BigInt(s.feeBps) + 5000n) / 10000n;
    const customer = `cust${i}`;
    const merchant = `merch${i % 3}`;
    const settled = s.kind !== 'failed';
    const payment: FeedPayment = {
      id, merchantId: merchant, customerAccountId: customer, merchantLedgerAccountId: merchant,
      amountMinor: amount.toString(), feeMinor: fee.toString(), currency: 'INR',
      status: s.kind === 'refunded' ? 'refunded' : s.kind, ledgerTxId: settled ? `tx${i}` : null,
      refundedMinor: s.kind === 'refunded' ? amount.toString() : '0', createdAt: iso(i), updatedAt: iso(i), refunds: [],
    };
    if (settled) {
      w.txs.push({ id: `tx${i}`, type: 'payment', referenceId: id, createdAt: iso(i), entries: [
        { accountId: customer, direction: 'debit', amountMinor: amount.toString() },
        { accountId: merchant, direction: 'credit', amountMinor: (amount - fee).toString() },
        ...(fee > 0n ? [{ accountId: 'fees', direction: 'credit' as const, amountMinor: fee.toString() }] : []),
      ] });
      w.charges.push({ reference: id, amountMinor: amount.toString(), currency: 'INR', status: 'succeeded', createdAt: iso(i) });
    }
    if (s.kind === 'refunded') {
      payment.refunds.push({ id: `r${i}`, amountMinor: amount.toString(), feeRefundMinor: fee.toString(), status: 'succeeded', ledgerTxId: `rtx${i}`, updatedAt: iso(i) });
      w.txs.push({ id: `rtx${i}`, type: 'refund', referenceId: `r${i}`, createdAt: iso(i), entries: [
        { accountId: customer, direction: 'credit', amountMinor: amount.toString() },
        { accountId: merchant, direction: 'debit', amountMinor: (amount - fee).toString() },
        ...(fee > 0n ? [{ accountId: 'fees', direction: 'debit' as const, amountMinor: fee.toString() }] : []),
      ] });
    }
    w.payments.push(payment);
  });
  return w;
}

const run = (w: World) => ({
  ledger: comparePaymentsToLedger(w.payments, w.txs, { window, now, stuckAfterMs: 5 * 60_000 }),
  external: compareToSettlement(w.payments, w.charges, { window }),
});
const kinds = (ms: { kind: string }[]) => ms.map((m) => m.kind).sort();

describe('a consistent world reconciles clean', () => {
  it('no findings for settled, failed and refunded payments', () => {
    const w = consistentWorld([{ amount: 10_000, feeBps: 250, kind: 'succeeded' }, { amount: 5_000, feeBps: 0, kind: 'failed' }, { amount: 7_777, feeBps: 199, kind: 'refunded' }]);
    expect(run(w)).toEqual({ ledger: [], external: [] });
  });

  it('property: any consistent world is clean, and ONE injected fault yields exactly that finding', () => {
    const spec = fc.record({ amount: fc.integer({ min: 1, max: 1_000_000 }), feeBps: fc.integer({ min: 0, max: 1_000 }), kind: fc.constantFrom('succeeded', 'failed', 'refunded' as const) });
    fc.assert(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 12 }), fc.nat(1000), (specs, pick) => {
        const w = consistentWorld(specs);
        expect(run(w)).toEqual({ ledger: [], external: [] });

        const settled = w.payments.filter((p) => p.status !== 'failed');
        if (settled.length === 0) return true;
        const target = settled[pick % settled.length]!;

        // 1. the bank never collected it
        const noCharge = run({ ...w, charges: w.charges.filter((c) => c.reference !== target.id) });
        expect(kinds(noCharge.external)).toEqual(['missing_in_gateway']);
        expect(noCharge.ledger).toEqual([]);

        // 2. the ledger amount is off by one paisa
        const badTx = w.txs.map((t) => (t.id === target.ledgerTxId ? { ...t, entries: t.entries.map((e, i) => (i === 0 ? { ...e, amountMinor: (BigInt(e.amountMinor) + 1n).toString() } : e)) } : t));
        const bad = run({ ...w, txs: badTx });
        expect(kinds(bad.ledger)).toEqual(['ledger_amount_mismatch']);
        expect(bad.external).toEqual([]);

        // 3. a stray bank charge nobody asked for
        const stray = run({ ...w, charges: [...w.charges, { reference: 'ghost', amountMinor: '100', currency: 'INR', status: 'succeeded', createdAt: iso(1) }] });
        expect(kinds(stray.external)).toEqual(['bank_charge_without_payment']);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe('payments <-> bank settlement', () => {
  const base = () => consistentWorld([{ amount: 10_000, feeBps: 250, kind: 'succeeded' }, { amount: 4_000, feeBps: 250, kind: 'failed' }]);

  it('flags a settled payment the bank has no charge for (critical)', () => {
    const w = base();
    const r = compareToSettlement(w.payments, [], { window });
    expect(r).toMatchObject([{ kind: 'missing_in_gateway', severity: 'critical', reference: 'p0' }]);
  });

  it('flags an amount difference with expected vs actual', () => {
    const w = base();
    w.charges[0] = { ...w.charges[0]!, amountMinor: '9999' };
    expect(compareToSettlement(w.payments, w.charges, { window })).toMatchObject([{ kind: 'amount_mismatch', expected: { amountMinor: '10000' }, actual: { amountMinor: '9999' } }]);
  });

  it('flags a FAILED payment the bank collected money for', () => {
    const w = base();
    w.charges.push({ reference: 'p1', amountMinor: '4000', currency: 'INR', status: 'succeeded', createdAt: iso(1) });
    expect(compareToSettlement(w.payments, w.charges, { window })).toMatchObject([{ kind: 'bank_charge_without_payment', reference: 'p1' }]);
  });

  it('ignores payments still in flight (the bank may know before we do)', () => {
    const w = base();
    w.payments[1] = { ...w.payments[1]!, status: 'processing' };
    w.charges.push({ reference: 'p1', amountMinor: '4000', currency: 'INR', status: 'succeeded', createdAt: iso(1) });
    expect(compareToSettlement(w.payments, w.charges, { window })).toEqual([]);
  });

  it('day boundaries: padded inputs are used for lookup but only in-window records are reported', () => {
    const w = base();
    const edge: FeedPayment = { ...w.payments[0]!, id: 'edge', createdAt: '2026-10-27T23:59:59.900Z', ledgerTxId: null };
    const edgeCharge: GatewayCharge = { reference: 'edge', amountMinor: '10000', currency: 'INR', status: 'succeeded', createdAt: '2026-10-28T00:00:00.100Z' };
    // the payment is on the previous day, the bank charge on this one: the payment is found, nothing is reported
    expect(compareToSettlement([...w.payments, edge], [...w.charges, edgeCharge], { window })).toEqual([]);
    // but if the payment is genuinely missing, the in-window bank charge is reported
    expect(compareToSettlement(w.payments, [...w.charges, edgeCharge], { window })).toMatchObject([{ kind: 'bank_charge_without_payment', reference: 'edge' }]);
  });
});

describe('payments <-> ledger', () => {
  const base = () => consistentWorld([{ amount: 10_000, feeBps: 250, kind: 'succeeded' }, { amount: 4_000, feeBps: 250, kind: 'failed' }, { amount: 6_000, feeBps: 250, kind: 'refunded' }]);
  const check = (w: World, stuckAfterMs = 5 * 60_000) => comparePaymentsToLedger(w.payments, w.txs, { window, now, stuckAfterMs });

  it('ledger transaction missing / not recorded', () => {
    const w = base();
    expect(check({ ...w, txs: w.txs.filter((t) => t.id !== 'tx0') })).toMatchObject([{ kind: 'ledger_tx_missing', reference: 'p0', severity: 'critical' }]);
    w.payments[0] = { ...w.payments[0]!, ledgerTxId: null };
    expect(check(w)[0]).toMatchObject({ kind: 'ledger_tx_missing' });
  });

  it('wrong merchant credit (fee not taken) is caught', () => {
    const w = base();
    w.txs = w.txs.map((t) => (t.id === 'tx0' ? { ...t, entries: t.entries.map((e) => (e.accountId === 'merch0' ? { ...e, amountMinor: '10000' } : e)) } : t));
    expect(check(w)).toMatchObject([{ kind: 'ledger_amount_mismatch', reference: 'p0' }]);
  });

  it('a FAILED payment with a ledger payment transaction is an orphan (money moved for nothing)', () => {
    const w = base();
    w.txs.push({ id: 'oops', type: 'payment', referenceId: 'p1', createdAt: iso(1), entries: [] });
    expect(kinds(check(w))).toEqual(['ledger_orphan_payment']);
  });

  it('a ledger payment transaction for a payment that does not exist is an orphan', () => {
    const w = base();
    w.txs.push({ id: 'ghost-tx', type: 'payment', referenceId: 'no-such-payment', createdAt: iso(1), entries: [] });
    expect(check(w)).toMatchObject([{ kind: 'ledger_orphan_payment', reference: 'no-such-payment' }]);
  });

  it('refund checks: missing ledger tx, wrong credit, failed refund that moved money, orphan refund', () => {
    const w = base();
    expect(check({ ...w, txs: w.txs.filter((t) => t.id !== 'rtx2') })).toMatchObject([{ kind: 'ledger_refund_missing', reference: 'r2' }]);
    const wrong = { ...w, txs: w.txs.map((t) => (t.id === 'rtx2' ? { ...t, entries: t.entries.map((e) => (e.direction === 'credit' ? { ...e, amountMinor: '1' } : e)) } : t)) };
    expect(check(wrong)).toMatchObject([{ kind: 'ledger_amount_mismatch', reference: 'r2' }]);
    const failedRefund = { ...w, payments: w.payments.map((p) => (p.id === 'p2' ? { ...p, refunds: [{ ...p.refunds[0]!, status: 'failed' as const }] } : p)) };
    expect(check(failedRefund)).toMatchObject([{ kind: 'ledger_orphan_refund', reference: 'r2' }]);
    expect(check({ ...w, txs: [...w.txs, { id: 'x', type: 'refund', referenceId: 'ghost-refund', createdAt: iso(1), entries: [] }] })).toMatchObject([{ kind: 'ledger_orphan_refund', reference: 'ghost-refund' }]);
  });

  it('a payment still processing but already captured in the ledger is flagged; old in-flight ones are "stuck"', () => {
    const w = base();
    w.payments[1] = { ...w.payments[1]!, status: 'processing', updatedAt: new Date(now.getTime() - 3_600_000).toISOString() };
    w.txs.push({ id: 'cap', type: 'payment', referenceId: 'p1', createdAt: iso(1), entries: [] });
    expect(kinds(check(w))).toEqual(['ledger_orphan_payment', 'stuck_payment']);
    expect(kinds(check({ ...w, txs: w.txs.filter((t) => t.id !== 'cap') }))).toEqual(['stuck_payment']);
    expect(kinds(check({ ...w, txs: w.txs.filter((t) => t.id !== 'cap') }, 2 * 3_600_000))).toEqual([]); // not stuck yet
  });
});

describe('ledger invariants -> findings', () => {
  const ok: InvariantReport = { ok: true, totalBalanceMinor: '0', unbalancedTransactions: [], balanceMismatches: [], heldMismatches: [], negativeBalances: [] };
  it('a clean report yields nothing', () => expect(invariantsToMismatches(ok)).toEqual([]));
  it('every violation becomes a critical finding', () => {
    const bad: InvariantReport = { ok: false, totalBalanceMinor: '7', unbalancedTransactions: ['t1'], balanceMismatches: [{ accountId: 'a', stored: '5', fromEntries: '4' }], heldMismatches: [{ accountId: 'b', held: '3', activeHolds: '0' }], negativeBalances: ['c'] };
    const ms = invariantsToMismatches(bad);
    expect(kinds(ms)).toEqual(['balance_mismatch', 'held_mismatch', 'money_not_conserved', 'negative_balance', 'unbalanced_transaction']);
    expect(ms.every((m) => m.severity === 'critical')).toBe(true);
  });
});
