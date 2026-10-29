import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.js';
import { type TestLedger, createTestLedger, expectInvariants } from './helpers.js';

let t: TestLedger;
beforeAll(async () => {
  t = await createTestLedger();
});
afterAll(() => t.close());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: DomainError) => e.code ?? e.message,
  );

describe('accounts', () => {
  it('createAccount is get-or-create', async () => {
    const a = await t.ledger.createAccount({ ownerType: 'customer', ownerId: 'dup-owner' });
    const b = await t.ledger.createAccount({ ownerType: 'customer', ownerId: 'dup-owner' });
    expect(b.id).toBe(a.id);
    expect(a.availableMinor).toBe('0');
  });

  it('system accounts exist after boot, and gateway_clearing may go negative', async () => {
    const list = await t.ledger.listAccounts({ ownerType: 'system' });
    expect(list.map((a) => a.type).sort()).toEqual(['fees', 'gateway_clearing', 'suspense']);
    expect(list.find((a) => a.type === 'gateway_clearing')!.allowNegative).toBe(true);
  });
});

describe('posting: top-ups and transfers', () => {
  it('moves money with matching journal entries and balances', async () => {
    const alice = await t.wallet('alice', 10_000n);
    const bob = await t.wallet('bob');
    const r = await t.ledger.transfer({
      fromAccountId: alice,
      toAccountId: bob,
      amountMinor: 2_500n,
      idempotencyKey: t.key(),
    });
    expect(r.replayed).toBe(false);
    expect(r.transaction.entries).toHaveLength(2);
    expect(await t.balance(alice)).toEqual({ available: 7_500n, held: 0n });
    expect(await t.balance(bob)).toEqual({ available: 2_500n, held: 0n });
    await expectInvariants(t);
  });

  it('splits a platform fee (round half up) into the fees account', async () => {
    const payer = await t.wallet('fee-payer', 100_000n);
    const merchant = await t.wallet('fee-merchant', 0n, 'merchant');
    const feesId = await t.ledger.systemAccountId(t.db, 'fees');
    const before = (await t.balance(feesId)).available;
    // 1_234 paise at 2.5% = 30.85 -> fee 31, net 1_203
    await t.ledger.transfer({
      fromAccountId: payer,
      toAccountId: merchant,
      amountMinor: 1_234n,
      feeBps: 250,
      idempotencyKey: t.key(),
    });
    expect((await t.balance(merchant)).available).toBe(1_203n);
    expect((await t.balance(feesId)).available - before).toBe(31n);
    expect((await t.balance(payer)).available).toBe(100_000n - 1_234n);
    await expectInvariants(t);
  });

  it('rejects overdrafts and leaves no trace', async () => {
    const a = await t.wallet('poor', 100n);
    const b = await t.wallet('rich-target');
    const k = t.key();
    expect(await code(t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 101n, idempotencyKey: k }))).toBe(
      'insufficient_funds',
    );
    expect(await t.balance(a)).toEqual({ available: 100n, held: 0n });
    const rows = await t.db.selectFrom('ledger_transactions').select('id').where('idempotency_key', '=', k).execute();
    expect(rows).toHaveLength(0); // the whole transaction, incl. the idempotency claim, rolled back
  });

  it('rejects self transfers, zero amounts and unknown accounts', async () => {
    const a = await t.wallet('self');
    expect(await code(t.ledger.transfer({ fromAccountId: a, toAccountId: a, amountMinor: 1n, idempotencyKey: t.key() }))).toBe(
      'validation_error',
    );
    expect(
      await code(
        t.ledger.transfer({
          fromAccountId: a,
          toAccountId: '00000000-0000-4000-8000-000000000000',
          amountMinor: 1n,
          idempotencyKey: t.key(),
        }),
      ),
    ).toBe('not_found');
  });
});

describe('database-level money rules (even if code were buggy)', () => {
  it('journal entries cannot be updated or deleted', async () => {
    const a = await t.wallet('imm', 500n);
    const [entry] = await t.ledger.listEntries(a, {});
    await expect(
      t.pool.query('UPDATE journal_entries SET amount_minor = 1 WHERE id = $1', [entry!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(t.pool.query('DELETE FROM journal_entries WHERE id = $1', [entry!.id])).rejects.toThrow(/append-only/);
    await expect(t.pool.query('TRUNCATE journal_entries')).rejects.toThrow(/append-only/);
  });

  it('an unbalanced transaction cannot be committed', async () => {
    const a = await t.wallet('ub1');
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query(
        `INSERT INTO ledger_transactions (type, idempotency_key, request_hash) VALUES ('transfer', 'raw-unbalanced', 'x') RETURNING id`,
      );
      await client.query(
        `INSERT INTO journal_entries (transaction_id, account_id, direction, amount_minor, currency) VALUES ($1, $2, 'credit', 100, 'INR')`,
        [tx.rows[0].id, a],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    await expectInvariants(t);
  });

  it('a normal account cannot be pushed below zero by raw SQL', async () => {
    const a = await t.wallet('rawneg', 10n);
    await expect(
      t.pool.query('UPDATE account_balances SET available_minor = -1 WHERE account_id = $1', [a]),
    ).rejects.toThrow(/below zero/);
  });

  it('an entry must use its account currency', async () => {
    const a = await t.wallet('cur');
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query(
        `INSERT INTO ledger_transactions (type, idempotency_key, request_hash) VALUES ('transfer', 'raw-cur', 'x') RETURNING id`,
      );
      await expect(
        client.query(
          `INSERT INTO journal_entries (transaction_id, account_id, direction, amount_minor, currency) VALUES ($1, $2, 'credit', 1, 'USD')`,
          [tx.rows[0].id, a],
        ),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

describe('idempotency', () => {
  it('same key + same request returns the stored response and moves money once', async () => {
    const a = await t.wallet('idem-a', 1_000n);
    const b = await t.wallet('idem-b');
    const k = t.key();
    const req = { fromAccountId: a, toAccountId: b, amountMinor: 400n, idempotencyKey: k };
    const first = await t.ledger.transfer(req);
    const second = await t.ledger.transfer(req);
    expect(second.replayed).toBe(true);
    expect(second.transaction).toEqual(first.transaction);
    expect(await t.balance(a)).toEqual({ available: 600n, held: 0n });
  });

  it('same key + different request is rejected with idempotency_key_reuse', async () => {
    const a = await t.wallet('idem2-a', 1_000n);
    const b = await t.wallet('idem2-b');
    const k = t.key();
    await t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 100n, idempotencyKey: k });
    expect(
      await code(t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 101n, idempotencyKey: k })),
    ).toBe('idempotency_key_reuse');
  });

  it('a key used by a different operation type is also a mismatch', async () => {
    const a = await t.wallet('idem3');
    const k = t.key();
    await t.ledger.topUp({ accountId: a, amountMinor: 5n, idempotencyKey: k });
    expect(await code(t.ledger.topUp({ accountId: a, amountMinor: 6n, idempotencyKey: k }))).toBe('idempotency_key_reuse');
  });
});

describe('reversal', () => {
  it('posts mirror entries, restores balances, and cannot be done twice', async () => {
    const a = await t.wallet('rev-a', 1_000n);
    const b = await t.wallet('rev-b');
    const { transaction } = await t.ledger.transfer({
      fromAccountId: a,
      toAccountId: b,
      amountMinor: 300n,
      idempotencyKey: t.key(),
    });
    const rev = await t.ledger.reverse({ transactionId: transaction.id, idempotencyKey: t.key() });
    expect(rev.transaction.type).toBe('reversal');
    expect(rev.transaction.reversesTransactionId).toBe(transaction.id);
    expect(await t.balance(a)).toEqual({ available: 1_000n, held: 0n });
    expect(await t.balance(b)).toEqual({ available: 0n, held: 0n });
    expect(await code(t.ledger.reverse({ transactionId: transaction.id, idempotencyKey: t.key() }))).toBe('already_reversed');
    // original rows are untouched
    expect((await t.ledger.getTransaction(transaction.id)).entries).toHaveLength(2);
    await expectInvariants(t);
  });

  it('refuses to reverse when the money is already spent (no negative balances)', async () => {
    const a = await t.wallet('rev2-a', 1_000n);
    const b = await t.wallet('rev2-b');
    const c = await t.wallet('rev2-c');
    const { transaction } = await t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 500n, idempotencyKey: t.key() });
    await t.ledger.transfer({ fromAccountId: b, toAccountId: c, amountMinor: 500n, idempotencyKey: t.key() });
    expect(await code(t.ledger.reverse({ transactionId: transaction.id, idempotencyKey: t.key() }))).toBe('insufficient_funds');
    await expectInvariants(t);
  });

  it('cannot reverse a reversal', async () => {
    const a = await t.wallet('rev3-a', 100n);
    const b = await t.wallet('rev3-b');
    const { transaction } = await t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 50n, idempotencyKey: t.key() });
    const rev = await t.ledger.reverse({ transactionId: transaction.id, idempotencyKey: t.key() });
    expect(await code(t.ledger.reverse({ transactionId: rev.transaction.id, idempotencyKey: t.key() }))).toBe('not_reversible');
  });
});

describe('holds', () => {
  it('create moves available to held; release gives it back', async () => {
    const a = await t.wallet('h1', 1_000n);
    const { hold } = await t.holds.createHold({ accountId: a, amountMinor: 600n, idempotencyKey: t.key() });
    expect(await t.balance(a)).toEqual({ available: 400n, held: 600n });
    await t.holds.releaseHold(hold.id);
    expect(await t.balance(a)).toEqual({ available: 1_000n, held: 0n });
    expect((await t.holds.getHold(hold.id)).status).toBe('released');
    expect((await t.holds.releaseHold(hold.id)).replayed).toBe(true); // idempotent
    await expectInvariants(t);
  });

  it('held funds cannot be spent, and a hold cannot exceed available', async () => {
    const a = await t.wallet('h2', 1_000n);
    const b = await t.wallet('h2-b');
    await t.holds.createHold({ accountId: a, amountMinor: 900n, idempotencyKey: t.key() });
    expect(await code(t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: 200n, idempotencyKey: t.key() }))).toBe(
      'insufficient_funds',
    );
    expect(await code(t.holds.createHold({ accountId: a, amountMinor: 200n, idempotencyKey: t.key() }))).toBe(
      'insufficient_funds',
    );
  });

  it('full capture pays the destination out of held funds', async () => {
    const a = await t.wallet('h3', 1_000n);
    const m = await t.wallet('h3-m', 0n, 'merchant');
    const { hold } = await t.holds.createHold({ accountId: a, amountMinor: 700n, idempotencyKey: t.key() });
    const cap = await t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: t.key() });
    expect(cap.hold.status).toBe('captured');
    expect(cap.hold.capturedMinor).toBe('700');
    expect(await t.balance(a)).toEqual({ available: 300n, held: 0n });
    expect(await t.balance(m)).toEqual({ available: 700n, held: 0n });
    await expectInvariants(t);
  });

  it('partial capture releases the remainder; fee is split from the captured amount', async () => {
    const a = await t.wallet('h4', 1_000n);
    const m = await t.wallet('h4-m', 0n, 'merchant');
    const { hold } = await t.holds.createHold({ accountId: a, amountMinor: 800n, idempotencyKey: t.key() });
    const cap = await t.holds.captureHold({
      holdId: hold.id,
      toAccountId: m,
      amountMinor: 500n,
      feeBps: 200, // 2% of 500 = 10
      idempotencyKey: t.key(),
    });
    expect(cap.hold.capturedMinor).toBe('500');
    expect(await t.balance(a)).toEqual({ available: 500n, held: 0n }); // 1000 - 500 captured; 300 returned
    expect(await t.balance(m)).toEqual({ available: 490n, held: 0n });
    await expectInvariants(t);
  });

  it('capture is idempotent; capture/release after the final state is a conflict', async () => {
    const a = await t.wallet('h5', 1_000n);
    const m = await t.wallet('h5-m', 0n, 'merchant');
    const { hold } = await t.holds.createHold({ accountId: a, amountMinor: 300n, idempotencyKey: t.key() });
    const k = t.key();
    const first = await t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: k });
    const again = await t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: k });
    expect(again.replayed).toBe(true);
    expect(again.transaction.id).toBe(first.transaction.id);
    expect(await t.balance(m)).toEqual({ available: 300n, held: 0n });
    expect(await code(t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: t.key() }))).toBe('invalid_hold_state');
    expect(await code(t.holds.releaseHold(hold.id))).toBe('invalid_hold_state');
  });

  it('cannot capture more than was held, or a released hold', async () => {
    const a = await t.wallet('h6', 1_000n);
    const m = await t.wallet('h6-m', 0n, 'merchant');
    const { hold } = await t.holds.createHold({ accountId: a, amountMinor: 100n, idempotencyKey: t.key() });
    expect(await code(t.holds.captureHold({ holdId: hold.id, toAccountId: m, amountMinor: 101n, idempotencyKey: t.key() }))).toBe(
      'validation_error',
    );
    await t.holds.releaseHold(hold.id);
    expect(await code(t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: t.key() }))).toBe('invalid_hold_state');
  });

  it('hold creation is idempotent and detects key reuse', async () => {
    const a = await t.wallet('h7', 1_000n);
    const k = t.key();
    const first = await t.holds.createHold({ accountId: a, amountMinor: 100n, idempotencyKey: k });
    const again = await t.holds.createHold({ accountId: a, amountMinor: 100n, idempotencyKey: k });
    expect(again.replayed).toBe(true);
    expect(again.hold.id).toBe(first.hold.id);
    expect(await t.balance(a)).toEqual({ available: 900n, held: 100n }); // only one hold taken
    expect(await code(t.holds.createHold({ accountId: a, amountMinor: 200n, idempotencyKey: k }))).toBe('idempotency_key_reuse');
  });

  it('expired holds are swept and their funds returned; capturing an expired hold fails', async () => {
    const a = await t.wallet('h8', 1_000n);
    const m = await t.wallet('h8-m', 0n, 'merchant');
    const { hold } = await t.holds.createHold({ accountId: a, amountMinor: 250n, idempotencyKey: t.key(), ttlSeconds: 1 });
    expect(await t.balance(a)).toEqual({ available: 750n, held: 250n });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(await code(t.holds.captureHold({ holdId: hold.id, toAccountId: m, idempotencyKey: t.key() }))).toBe('hold_expired');
    expect(await t.holds.expireDueHolds()).toBeGreaterThanOrEqual(1);
    expect((await t.holds.getHold(hold.id)).status).toBe('expired');
    expect(await t.balance(a)).toEqual({ available: 1_000n, held: 0n });
    await expectInvariants(t);
  });
});

describe('generic posting (used for refunds)', () => {
  it('posts a multi-source refund shape and rejects unbalanced ones', async () => {
    const merchant = await t.wallet('gp-m', 1_000n, 'merchant');
    const customer = await t.wallet('gp-c');
    const feesId = await t.ledger.systemAccountId(t.db, 'fees');
    await t.ledger.transfer({ fromAccountId: merchant, toAccountId: feesId, amountMinor: 100n, idempotencyKey: t.key() }); // seed fees
    const r = await t.ledger.postTransaction({
      type: 'refund',
      idempotencyKey: t.key(),
      entries: [
        { accountId: merchant, direction: 'debit', amountMinor: 480n },
        { accountId: feesId, direction: 'debit', amountMinor: 20n },
        { accountId: customer, direction: 'credit', amountMinor: 500n },
      ],
    });
    expect(r.transaction.entries).toHaveLength(3);
    expect((await t.balance(customer)).available).toBe(500n);
    expect(
      await code(
        t.ledger.postTransaction({
          type: 'refund',
          idempotencyKey: t.key(),
          entries: [
            { accountId: merchant, direction: 'debit', amountMinor: 10n },
            { accountId: customer, direction: 'credit', amountMinor: 11n },
          ],
        }),
      ),
    ).toBe('validation_error');
    await expectInvariants(t);
  });
});

describe('transaction feed', () => {
  it('pages ascending by default and newest-first with order=desc, each row exactly once', async () => {
    const a = await t.wallet('feed-a', 10_000n);
    const b = await t.wallet('feed-b');
    for (let i = 0; i < 6; i++) await t.ledger.transfer({ fromAccountId: a, toAccountId: b, amountMinor: BigInt(10 + i), idempotencyKey: t.key() });
    const all = async (desc: boolean) => {
      const ids: string[] = [];
      let after: string | undefined;
      for (;;) {
        const q = new URLSearchParams({ type: 'transfer', limit: '2', ...(desc ? { order: 'desc' } : {}), ...(after ? { after } : {}) });
        const r = await (await fetch(`${t.baseUrl}/internal/transactions?${q}`)).json();
        ids.push(...r.transactions.map((x: { id: string }) => x.id));
        if (!r.nextCursor) return ids;
        after = r.nextCursor;
      }
    };
    const asc = await all(false);
    const desc = await all(true);
    expect(new Set(asc).size).toBe(asc.length);
    expect(asc.length).toBeGreaterThanOrEqual(6);
    expect(desc).toEqual([...asc].reverse());
  });
});

describe('HTTP API', () => {
  const post = (path: string, body: unknown, key?: string) =>
    fetch(`${t.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    });

  it('requires an Idempotency-Key and validates input', async () => {
    const a = await t.wallet('http-a');
    expect((await post('/topups', { accountId: a, amountMinor: '100' })).status).toBe(400);
    const bad = await post('/topups', { accountId: a, amountMinor: 1.5 }, t.key());
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('validation_error');
    expect((await post('/topups', { accountId: a, amountMinor: '-5' }, t.key())).status).toBe(400);
    expect((await post('/topups', { accountId: a, amountMinor: '0' }, t.key())).status).toBe(400);
  });

  it('201 on first call, 200 + Idempotent-Replayed on repeat, 422 on mismatch', async () => {
    const a = await t.wallet('http-b');
    const k = t.key();
    const first = await post('/topups', { accountId: a, amountMinor: '500' }, k);
    expect(first.status).toBe(201);
    const second = await post('/topups', { accountId: a, amountMinor: '500' }, k);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    const mismatch = await post('/topups', { accountId: a, amountMinor: '501' }, k);
    expect(mismatch.status).toBe(422);
    const acct = await (await fetch(`${t.baseUrl}/accounts/${a}`)).json();
    expect(acct.availableMinor).toBe('500');
  });

  it('maps insufficient funds to 409 and unknown ids to 404', async () => {
    const a = await t.wallet('http-c');
    const b = await t.wallet('http-d');
    const r = await post('/transfers', { fromAccountId: a, toAccountId: b, amountMinor: '1' }, t.key());
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('insufficient_funds');
    expect((await fetch(`${t.baseUrl}/accounts/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('exposes the invariant report', async () => {
    const r = await (await fetch(`${t.baseUrl}/internal/invariants`)).json();
    expect(r.ok).toBe(true);
    expect(r.totalBalanceMinor).toBe('0');
  });
});
