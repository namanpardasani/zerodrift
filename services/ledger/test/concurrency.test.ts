import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.js';
import { type TestLedger, createTestLedger, expectInvariants } from './helpers.js';

let t: TestLedger;
beforeAll(async () => {
  t = await createTestLedger();
});
afterAll(() => t.close());

/** Settle all promises and split into fulfilled values and error codes. */
async function settle<T>(ps: Promise<T>[]) {
  const results = await Promise.allSettled(ps);
  const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === 'fulfilled').map((r) => r.value);
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as DomainError).code ?? String(r.reason));
  return { ok, errors };
}

describe('concurrency', () => {
  it('100 parallel transfers in both directions on the same 5 accounts: no deadlock, money conserved', async () => {
    const N = 5;
    const start = 1_000_000n;
    const accounts = await Promise.all(Array.from({ length: N }, (_, i) => t.wallet(`ring-${i}`, start)));

    // Deliberately includes opposing pairs (a->b and b->a at the same time): the classic deadlock
    // recipe if locks were taken in the order the transfer names the accounts.
    const jobs = Array.from({ length: 100 }, (_, i) => {
      const from = accounts[i % N]!;
      const to = accounts[(i * 3 + 1 + (i % 2 ? 1 : 0)) % N]!;
      return from === to ? null : { from, to, amount: BigInt(100 + i) };
    }).filter((j): j is NonNullable<typeof j> => j !== null);

    const { ok, errors } = await settle(
      jobs.map((j) =>
        t.ledger.transfer({ fromAccountId: j.from, toAccountId: j.to, amountMinor: j.amount, idempotencyKey: t.key() }),
      ),
    );
    expect(errors).toEqual([]);
    expect(ok).toHaveLength(jobs.length);

    let total = 0n;
    for (const a of accounts) total += (await t.balance(a)).available;
    expect(total).toBe(start * BigInt(N)); // nothing created or destroyed
    await expectInvariants(t);
  });

  it('50 concurrent withdrawals from an account that can afford exactly 10: exactly 10 succeed, never negative', async () => {
    const src = await t.wallet('contended', 1_000n);
    const dst = await t.wallet('contended-dst');
    const { ok, errors } = await settle(
      Array.from({ length: 50 }, () =>
        t.ledger.transfer({ fromAccountId: src, toAccountId: dst, amountMinor: 100n, idempotencyKey: t.key() }),
      ),
    );
    expect(ok).toHaveLength(10);
    expect(errors).toHaveLength(40);
    expect(new Set(errors)).toEqual(new Set(['insufficient_funds']));
    expect(await t.balance(src)).toEqual({ available: 0n, held: 0n });
    expect(await t.balance(dst)).toEqual({ available: 1_000n, held: 0n });
    await expectInvariants(t);
  });

  it('30 concurrent duplicates of one request (same key) execute exactly once', async () => {
    const a = await t.wallet('dup-a', 10_000n);
    const b = await t.wallet('dup-b');
    const k = t.key();
    const { ok, errors } = await settle(
      Array.from({ length: 30 }, () => t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 700n, idempotencyKey: k })),
    );
    expect(errors).toEqual([]);
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(ok.map((r) => r.transaction.id)).size).toBe(1);
    expect(await t.balance(b)).toEqual({ available: 700n, held: 0n });
    const rows = await t.db.selectFrom('ledger_transactions').select('id').where('idempotency_key', '=', k).execute();
    expect(rows).toHaveLength(1);
  });

  it('30 concurrent duplicate HTTP requests: one 201, the rest 200 with the same body', async () => {
    const a = await t.wallet('httpdup-a', 5_000n);
    const b = await t.wallet('httpdup-b');
    const k = t.key();
    const call = () =>
      fetch(`${t.baseUrl}/transfers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': k },
        body: JSON.stringify({ fromAccountId: a, toAccountId: b, amountMinor: '250' }),
      });
    const responses = await Promise.all(Array.from({ length: 30 }, call));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(29);
    const ids = new Set((await Promise.all(responses.map((r) => r.json()))).map((j) => j.id));
    expect(ids.size).toBe(1);
    expect(await t.balance(b)).toEqual({ available: 250n, held: 0n });
  });

  it('concurrent duplicate hold creation yields one hold', async () => {
    const a = await t.wallet('hdup', 1_000n);
    const k = t.key();
    const { ok, errors } = await settle(
      Array.from({ length: 20 }, () => t.holds.createHold({ accountId: a, amountMinor: 300n, idempotencyKey: k })),
    );
    expect(errors).toEqual([]);
    expect(new Set(ok.map((r) => r.hold.id)).size).toBe(1);
    expect(await t.balance(a)).toEqual({ available: 700n, held: 300n });
    await expectInvariants(t);
  });

  it('capture racing release on the same hold: exactly one wins and the books stay consistent', async () => {
    for (let round = 0; round < 10; round++) {
      const a = await t.wallet(`race-${round}`, 1_000n);
      const m = await t.wallet(`race-m-${round}`, 0n, 'merchant');
      const { hold } = await t.holds.createHold({ accountId: a, amountMinor: 400n, idempotencyKey: t.key() });
      const results = await Promise.allSettled([
        t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: t.key() }),
        t.holds.releaseHold(hold.id),
        t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: t.key() }),
      ]);
      const finalStatus = (await t.holds.getHold(hold.id)).status;
      const won = results.filter((r) => r.status === 'fulfilled').length;
      if (finalStatus === 'captured') {
        // Both capture calls used different keys: one wins, the other is a state conflict.
        expect(won).toBe(1);
        expect(await t.balance(m)).toEqual({ available: 400n, held: 0n });
        expect(await t.balance(a)).toEqual({ available: 600n, held: 0n });
      } else {
        expect(finalStatus).toBe('released');
        expect(await t.balance(m)).toEqual({ available: 0n, held: 0n });
        expect(await t.balance(a)).toEqual({ available: 1_000n, held: 0n });
      }
    }
    await expectInvariants(t);
  });

  it('concurrent reversals (different keys) of one transaction: exactly one succeeds', async () => {
    const a = await t.wallet('crev-a', 1_000n);
    const b = await t.wallet('crev-b');
    const { transaction } = await t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 400n, idempotencyKey: t.key() });
    const { ok, errors } = await settle(
      Array.from({ length: 10 }, () => t.ledger.reverse({ transactionId: transaction.id, idempotencyKey: t.key() })),
    );
    expect(ok).toHaveLength(1);
    expect(new Set(errors)).toEqual(new Set(['already_reversed']));
    expect(await t.balance(a)).toEqual({ available: 1_000n, held: 0n });
    await expectInvariants(t);
  });

  it('mixed storm: transfers, holds, captures and releases at once keep every invariant', async () => {
    const accounts = await Promise.all(Array.from({ length: 6 }, (_, i) => t.wallet(`storm-${i}`, 50_000n)));
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      const from = accounts[i % 6]!;
      const to = accounts[(i + 1 + (i % 3)) % 6]!;
      if (from === to) continue;
      ops.push(t.ledger.transfer({ fromAccountId: from, toAccountId: to, amountMinor: BigInt(50 + i), idempotencyKey: t.key() }));
      ops.push(
        (async () => {
          const { hold } = await t.holds.createHold({ accountId: from, amountMinor: BigInt(100 + i), idempotencyKey: t.key() });
          return i % 2 === 0
            ? t.holds.captureHold({ holdId: hold.id, toAccountId: to, amountMinor: BigInt(50 + i), idempotencyKey: t.key() })
            : t.holds.releaseHold(hold.id);
        })(),
      );
    }
    const { errors } = await settle(ops);
    expect(errors).toEqual([]);
    await expectInvariants(t);
  });
});

describe('get-or-create under contention', () => {
  it('40 concurrent createAccount calls for the same owner all succeed and return one account', async () => {
    const t0 = Date.now();
    const { ok, errors } = await settle(Array.from({ length: 40 }, () => t.ledger.createAccount({ ownerType: 'customer', ownerId: 'same-owner' })));
    expect(errors).toEqual([]);
    expect(new Set(ok.map((a) => a.id)).size).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const n = await t.db.selectFrom('accounts').select('id').where('owner_id', '=', 'same-owner').execute();
    expect(n).toHaveLength(1);
  });
});

/**
 * Bug the chaos test caught: captureHold asked the POOL for the database clock while already holding a
 * pooled connection in its transaction. With more concurrent captures than pool connections, every
 * connection was held by a transaction waiting for another one: the whole service wedged for good
 * (readiness probe timed out, pods stayed NotReady). Nothing may borrow a second connection mid-transaction.
 */
describe('connection pool', () => {
  it('many concurrent captures through a tiny pool all complete (no pool-exhaustion deadlock)', async () => {
    const small = await createTestLedger(3);
    try {
      const merchant = await small.wallet('pool-m', 0n, 'merchant');
      const holdIds: string[] = [];
      for (let i = 0; i < 30; i++) {
        const payer = await small.wallet(`pool-p${i}`, 1_000n);
        holdIds.push((await small.holds.createHold({ accountId: payer, amountMinor: 500n, idempotencyKey: small.key() })).hold.id);
      }
      const captured = await Promise.race([
        Promise.all(holdIds.map((holdId) => small.holds.captureHold({ holdId, toAccountId: merchant, idempotencyKey: small.key() }))),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlocked: captures did not finish with a 3-connection pool')), 20_000)),
      ]);
      expect(captured).toHaveLength(30);
      expect(await small.balance(merchant)).toEqual({ available: 15_000n, held: 0n });
    } finally {
      await small.close();
    }
  });
});
