import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './harness.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

const finding = (run: { mismatches?: { kind: string; reference: string; severity: string; message: string }[] }, kind: string, reference: string) =>
  run.mismatches?.find((m) => m.kind === kind && m.reference === reference);

// NOTE: the first test must run first: later tests deliberately damage data.
describe('a healthy system reconciles clean', () => {
  it('internal and external runs are clean after payments, a refund, a decline and a recovered payment', async () => {
    expect((await s.pay(await s.customer(), 4_000)).body.status).toBe('succeeded');
    const b = (await s.pay(await s.customer(), 6_000)).body;
    await s.refund(b.id, 2_500); // partial refund
    s.gateway.faults.set({ declineRate: 1 });
    expect((await s.pay(await s.customer(), 1_000)).body.status).toBe('failed');
    s.gateway.faults.reset();
    // a payment whose bank response was lost, then recovered
    s.gateway.faults.set({ lostResponseRate: 1, callbackDropRate: 1 });
    const lost = (await s.pay(await s.customer(), 2_000)).body;
    expect(lost.status).toBe('processing');
    s.gateway.faults.reset();
    await s.adminRecovery();

    const internal = await s.reconcile('internal');
    expect(internal.status, JSON.stringify(internal.mismatches)).toBe('clean');
    expect(internal.summary).toMatchObject({ invariants: { totalBalanceMinor: '0' } });
    expect(internal.summary!.paymentsChecked).toBeGreaterThanOrEqual(4);
    expect(internal.summary!.ledgerTransactionsChecked).toBeGreaterThanOrEqual(4); // 3 payments + 1 refund

    const external = await s.reconcile('external');
    expect(external.status, JSON.stringify(external.mismatches)).toBe('clean');
    expect(external.summary!.gatewayChargesChecked).toBe(3); // a, b, lost (the decline created no successful charge)
  });

  it('while a payment is still unresolved (lost response, not yet recovered) nothing critical is reported', async () => {
    s.gateway.faults.set({ lostResponseRate: 1, callbackDropRate: 1 });
    const p = (await s.pay(await s.customer(), 1_500)).body;
    s.gateway.faults.reset();
    expect(p.status).toBe('processing');
    expect((await s.reconcile('external')).status).toBe('clean'); // the bank knows first: in flight, not a mismatch
    expect((await s.reconcile('internal')).status).toBe('clean'); // young enough not to be "stuck" (stuckAfter = 1h here)
    await s.adminRecovery();
    expect((await s.reconcile('internal')).status).toBe('clean');
    expect((await s.reconcile('external')).status).toBe('clean');
  });
});

describe('external reconciliation catches disagreements with the bank', () => {
  it('missing_in_gateway: we captured money the bank says it never collected (charge voided at the bank)', async () => {
    const p = (await s.pay(await s.customer(), 3_000)).body;
    await fetch(`${s.gateway.url}/charges/${p.id}/void`, { method: 'POST' });
    const run = await s.reconcile('external');
    expect(run.status).toBe('mismatches');
    expect(finding(run, 'missing_in_gateway', p.id)).toMatchObject({ severity: 'critical' });
  });

  it('bank_charge_without_payment (unknown reference): the bank collected money for something we never recorded', async () => {
    const ghost = randomUUID();
    await fetch(`${s.gateway.url}/charges`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: ghost, amountMinor: '777' }) });
    const run = await s.reconcile('external');
    expect(finding(run, 'bank_charge_without_payment', ghost)).toMatchObject({ severity: 'critical' });
  });

  it('bank_charge_without_payment (payment failed): the customer was charged but the payment is marked failed', async () => {
    s.gateway.faults.set({ lostResponseRate: 1, callbackDropRate: 1 });
    const p = (await s.pay(await s.customer(), 1_800)).body;
    s.gateway.faults.reset();
    // simulate a bug that wrongly failed it
    await s.payments.db.updateTable('payments').set({ status: 'failed', failure_reason: 'bug' }).where('id', '=', p.id).execute();
    const run = await s.reconcile('external');
    expect(finding(run, 'bank_charge_without_payment', p.id)).toMatchObject({ severity: 'critical' });
  });

  it('amount_mismatch: our amount differs from what the bank charged', async () => {
    const p = (await s.pay(await s.customer(), 2_200)).body;
    await s.payments.db.updateTable('payments').set({ amount_minor: 2_300n }).where('id', '=', p.id).execute();
    const external = await s.reconcile('external');
    expect(finding(external, 'amount_mismatch', p.id)).toMatchObject({ severity: 'critical' });
    expect(finding(external, 'amount_mismatch', p.id)!.message).toContain(p.id);
    const internal = await s.reconcile('internal'); // the ledger disagrees too
    expect(finding(internal, 'ledger_amount_mismatch', p.id)).toBeTruthy();
  });
});

describe('internal reconciliation catches payments <-> ledger drift', () => {
  it('ledger_tx_missing: a succeeded payment pointing at a ledger transaction that does not exist', async () => {
    const p = (await s.pay(await s.customer(), 1_100)).body;
    await s.payments.db.updateTable('payments').set({ ledger_tx_id: randomUUID() }).where('id', '=', p.id).execute();
    expect(finding(await s.reconcile('internal'), 'ledger_tx_missing', p.id)).toMatchObject({ severity: 'critical' });
  });

  it('ledger_orphan_payment: the ledger moved money for a payment that does not exist', async () => {
    const ghost = randomUUID();
    const a = await s.payments.ledger.wallet('customer', `orphan-a-${s.uid()}`);
    const b = await s.payments.ledger.wallet('merchant', `orphan-b-${s.uid()}`);
    await fetch(`${s.ledger.url}/topups`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `o-${s.uid()}` }, body: JSON.stringify({ accountId: a.id, amountMinor: '500' }) });
    await fetch(`${s.ledger.url}/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `o2-${s.uid()}` }, body: JSON.stringify({ type: 'payment', referenceId: ghost, entries: [{ accountId: a.id, direction: 'debit', amountMinor: '500' }, { accountId: b.id, direction: 'credit', amountMinor: '500' }] }) });
    expect(finding(await s.reconcile('internal'), 'ledger_orphan_payment', ghost)).toMatchObject({ severity: 'critical' });
  });

  it('ledger_refund_missing: a refund marked succeeded with no ledger movement', async () => {
    const p = (await s.pay(await s.customer(), 2_000)).body;
    const r = (await s.refund(p.id, 500)).body;
    await s.payments.db.updateTable('refunds').set({ ledger_tx_id: randomUUID() }).where('id', '=', r.id).execute();
    // damage: the refund record points at a ledger transaction that is gone (here: re-typed so it is no longer a refund)
    await s.ledger.pool.query("UPDATE ledger_transactions SET type = 'transfer' WHERE reference_id = $1 AND type = 'refund'", [r.id]).catch(() => undefined);
    const run = await s.reconcile('internal');
    expect(finding(run, 'ledger_refund_missing', r.id)).toMatchObject({ severity: 'critical' });
  });

  it('stuck_payment (warning): a payment unresolved longer than the threshold', async () => {
    const strict = await startStack({ recon: { stuckAfterMs: 0 } }); // a stack where "stuck" means "not settled yet"
    try {
      strict.gateway.faults.set({ errorRate: 1 });
      const sp = (await strict.pay(await strict.customer(), 900)).body;
      strict.gateway.faults.reset();
      expect(sp.status).toBe('processing');
      const run = await strict.reconcile('internal');
      expect(run.status).toBe('mismatches');
      expect(finding(run, 'stuck_payment', sp.id)).toMatchObject({ severity: 'warning' });
      await strict.adminRecovery();
      expect((await strict.reconcile('internal')).status).toBe('clean'); // recovery fixed it, so the warning disappears
    } finally {
      await strict.close();
    }
  });
});

describe('the ledger self-audit is part of the internal run', () => {
  it('detects money created out of thin air and a balance that no longer matches the journal (damage done behind the ledger\'s back)', async () => {
    const t = await startStack();
    try {
      expect((await t.pay(await t.customer(), 1_000)).body.status).toBe('succeeded');
      expect((await t.reconcile('internal')).status).toBe('clean');

      const acct = await t.payments.ledger.wallet('customer', `victim-${t.uid()}`);
      // an attacker/bug with direct DB access bypasses the guard trigger and inflates a balance by 5 paise
      await t.ledger.pool.query('ALTER TABLE account_balances DISABLE TRIGGER account_balances_non_negative');
      await t.ledger.pool.query('UPDATE account_balances SET available_minor = available_minor + 5 WHERE account_id = $1', [acct.id]);

      const run = await t.reconcile('internal');
      expect(run.status).toBe('mismatches');
      expect(finding(run, 'money_not_conserved', 'ledger')).toMatchObject({ severity: 'critical' });
      expect(run.summary!.invariants!.totalBalanceMinor).toBe('5');
      expect(finding(run, 'balance_mismatch', acct.id)).toMatchObject({ severity: 'critical' });
    } finally {
      await t.close();
    }
  });
});
