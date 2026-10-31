import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb, createPool, migrateToLatest } from '@zerodrift/db';
import { createTestDatabase } from '@zerodrift/testing';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckResult, type Databases, reconciliationResult, runInvariants } from '../src/invariants.js';

/**
 * The checker is only worth trusting if it FAILS when the system is wrong. Each test builds a small,
 * correct world with real migrations (so the real constraints and triggers exist), proves every check
 * passes, then corrupts it in one specific way and proves the right check notices.
 */
const services = (name: string) => fileURLToPath(new URL(`../../services/${name}/src/migrations`, import.meta.url));
const pools: Pool[] = [];

async function database(service: string): Promise<Pool> {
  const { url } = await createTestDatabase();
  const pool = createPool(url, 3);
  pools.push(pool);
  await migrateToLatest(createDb(pool), services(service));
  return pool;
}

/** Run SQL with triggers disabled: the only way to fabricate the corruption the triggers normally forbid. */
async function corrupt(pool: Pool, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query('SET session_replication_role = replica');
    await c.query(sql, params);
  } finally {
    c.release();
  }
}

interface World {
  db: Record<keyof Databases, Pool>; // real pools, so the tests can also take a connection for multi-statement transactions
  ids: { customer: string; merchant: string; clearing: string; payment: string; capture: string; event: string; endpoint: string; merchantId: string };
  receiver: Record<string, number>;
}

const TOPUP = 1000n;

async function correctWorld(): Promise<World> {
  const [ledger, payments, webhook, gateway] = await Promise.all([database('ledger'), database('payments'), database('webhook'), database('mock-gateway')]);
  const ids = { customer: randomUUID(), merchant: randomUUID(), clearing: randomUUID(), payment: randomUUID(), capture: randomUUID(), event: randomUUID(), endpoint: randomUUID(), merchantId: randomUUID() };
  const topup = randomUUID();

  const account = (id: string, ownerType: string, owner: string, type: string, negative = false) =>
    ledger.query(`INSERT INTO accounts (id, owner_type, owner_id, type, allow_negative) VALUES ($1,$2,$3,$4,$5)`, [id, ownerType, owner, type, negative]);
  await account(ids.clearing, 'system', 'gateway', 'gateway_clearing', true);
  await account(ids.customer, 'customer', 'c1', 'wallet');
  await account(ids.merchant, 'merchant', 'm1', 'wallet');

  // A transaction and its entries must be inserted together (the balance trigger is deferred to commit).
  const post = async (txId: string, type: string, key: string, legs: [string, 'debit' | 'credit', bigint][]) => {
    const c = await ledger.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO ledger_transactions (id, type, idempotency_key, request_hash) VALUES ($1,$2,$3,'h')`, [txId, type, key]);
      for (const [account, direction, amount] of legs) {
        await c.query(`INSERT INTO journal_entries (transaction_id, account_id, direction, amount_minor, currency) VALUES ($1,$2,$3,$4,'INR')`, [txId, account, direction, amount.toString()]);
        // create the balance row at zero first: the non-negative trigger also looks at the proposed INSERT value
        await c.query(`INSERT INTO account_balances (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [account]);
        await c.query(`UPDATE account_balances SET available_minor = available_minor + $2 WHERE account_id = $1`, [account, (direction === 'credit' ? amount : -amount).toString()]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };
  await post(topup, 'topup', 'topup-1', [[ids.clearing, 'debit', TOPUP], [ids.customer, 'credit', TOPUP]]);
  await post(ids.capture, 'payment', `capture:${ids.payment}`, [[ids.customer, 'debit', 100n], [ids.merchant, 'credit', 100n]]);

  await payments.query(`INSERT INTO merchants (id, name, api_key_hash, api_key_prefix, ledger_account_id) VALUES ($1,'m1','hash','pre',$2)`, [ids.merchantId, ids.merchant]);
  await payments.query(
    `INSERT INTO payments (id, merchant_id, customer_id, customer_account_id, amount_minor, status, idempotency_key, fee_bps, fee_minor, ledger_tx_id)
     VALUES ($1,$2,'c1',$3,100,'succeeded','run1-1-1',250,3,$4)`,
    [ids.payment, ids.merchantId, ids.customer, ids.capture],
  );
  await gateway.query(`INSERT INTO gateway_charges (reference, amount_minor, currency, status) VALUES ($1,100,'INR','succeeded')`, [ids.payment]);

  await webhook.query(`INSERT INTO webhook_endpoints (id, merchant_id, url, secret_encrypted) VALUES ($1,$2,'http://r/webhooks','x')`, [ids.endpoint, ids.merchantId]);
  await webhook.query(`INSERT INTO webhook_events (event_id, merchant_id, event_type, payload) VALUES ($1,$2,'payment.succeeded',$3)`, [ids.event, ids.merchantId, JSON.stringify({ aggregateId: ids.payment })]);
  await webhook.query(`INSERT INTO webhook_deliveries (event_id, endpoint_id, status) VALUES ($1,$2,'succeeded')`, [ids.event, ids.endpoint]);

  return { db: { ledger, payments, webhook, gateway }, ids, receiver: { [ids.event]: 1 } };
}

const run = (w: World, receiver = w.receiver) => runInvariants(w.db, { expectedTopupMinor: TOPUP, receiver });
const failed = (r: CheckResult[]) => r.filter((x) => !x.passed).map((x) => x.name);

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

describe('invariant checker', () => {
  it('passes on a correct world (all checks ran)', async () => {
    const results = await run(await correctWorld());
    expect(failed(results)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(['money_conserved', 'transactions_balanced', 'balances_match_entries', 'no_money_stuck_in_holds', 'no_duplicate_charges', 'no_stuck_payments', 'webhooks_exactly_once']);
  });

  it('detects money created out of thin air', async () => {
    const w = await correctWorld();
    await w.db.ledger.query(`UPDATE account_balances SET available_minor = available_minor + 50 WHERE account_id = $1`, [w.ids.customer]);
    expect(failed(await run(w))).toEqual(expect.arrayContaining(['money_conserved', 'balances_match_entries']));
  });

  it('detects money that vanished (expected top-ups do not match)', async () => {
    const w = await correctWorld();
    const results = await runInvariants(w.db, { expectedTopupMinor: TOPUP + 1n, receiver: w.receiver });
    expect(failed(results)).toContain('money_conserved');
  });

  it('detects an unbalanced transaction', async () => {
    const w = await correctWorld();
    await corrupt(w.db.ledger, `INSERT INTO journal_entries (transaction_id, account_id, direction, amount_minor, currency) VALUES ($1,$2,'credit',5,'INR')`, [w.ids.capture, w.ids.merchant]);
    expect(failed(await run(w))).toContain('transactions_balanced');
  });

  it('detects an overdrawn normal account', async () => {
    const w = await correctWorld();
    await corrupt(w.db.ledger, `UPDATE account_balances SET available_minor = -5 WHERE account_id = $1`, [w.ids.merchant]);
    expect(failed(await run(w))).toContain('balances_match_entries');
  });

  it('detects a capture for a payment that failed (customer charged for nothing)', async () => {
    const w = await correctWorld();
    await w.db.payments.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [w.ids.payment]);
    expect(failed(await run(w))).toContain('no_duplicate_charges');
  });

  it('detects a succeeded payment the bank never charged', async () => {
    const w = await correctWorld();
    await w.db.gateway.query(`DELETE FROM gateway_charges`);
    expect(failed(await run(w))).toContain('no_duplicate_charges');
  });

  it('detects a succeeded payment with no capture in the ledger', async () => {
    const w = await correctWorld();
    await corrupt(w.db.ledger, `UPDATE ledger_transactions SET idempotency_key = 'something-else' WHERE id = $1`, [w.ids.capture]);
    expect(failed(await run(w))).toContain('no_duplicate_charges');
  });

  it('detects more payments than distinct keys sent', async () => {
    const w = await correctWorld();
    const results = await runInvariants(w.db, { expectedTopupMinor: TOPUP, receiver: w.receiver, runKeyPrefix: 'run1', uniqueKeysSent: 0 });
    expect(failed(results)).toContain('no_duplicate_charges');
  });

  it('detects a payment stuck in processing', async () => {
    const w = await correctWorld();
    await w.db.payments.query(`UPDATE payments SET status = 'processing'`);
    expect(failed(await run(w))).toContain('no_stuck_payments');
  });

  it('detects money stuck in an active hold', async () => {
    const w = await correctWorld();
    await w.db.ledger.query(`INSERT INTO holds (account_id, amount_minor, status, idempotency_key, request_hash, expires_at) VALUES ($1,10,'active','hold-x','h', now() + interval '1 hour')`, [w.ids.customer]);
    expect(failed(await run(w))).toContain('no_money_stuck_in_holds');
  });

  it('detects webhook problems: missing delivery, pending delivery, receiver mismatch and double acceptance', async () => {
    let w = await correctWorld();
    await w.db.webhook.query(`DELETE FROM webhook_deliveries`);
    expect(failed(await run(w))).toContain('webhooks_exactly_once');

    w = await correctWorld();
    await w.db.webhook.query(`UPDATE webhook_deliveries SET status = 'pending'`);
    expect(failed(await run(w))).toContain('webhooks_exactly_once');

    w = await correctWorld();
    expect(failed(await run(w, {}))).toContain('webhooks_exactly_once'); // delivered according to us, never seen by the receiver
    expect(failed(await run(w, { [w.ids.event]: 2 }))).toContain('webhooks_exactly_once'); // accepted twice

    w = await correctWorld();
    await w.db.webhook.query(`UPDATE webhook_deliveries SET status = 'dead'`); // dead-lettered is an accepted final state
    expect(failed(await run(w, {}))).toEqual([]);
  });

  it('detects a succeeded payment that has no event at all', async () => {
    const w = await correctWorld();
    await w.db.webhook.query(`DELETE FROM webhook_deliveries`);
    await w.db.webhook.query(`DELETE FROM webhook_events`);
    expect(failed(await run(w))).toContain('webhooks_exactly_once');
  });

  it('turns a reconciliation run into a check (and treats a missing result as failure)', () => {
    expect(reconciliationResult('internal', { status: 'clean', mismatches: [] }).passed).toBe(true);
    expect(reconciliationResult('internal', { status: 'discrepancies', mismatches: [{ kind: 'x' }] }).passed).toBe(false);
    expect(reconciliationResult('external', null).passed).toBe(false);
  });
});
