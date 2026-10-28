import fc from 'fast-check';
import { feeFor } from '@zerodrift/money';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { DomainError } from '../src/errors.js';
import { type TestLedger, createTestLedger, expectInvariants } from './helpers.js';

let t: TestLedger;
beforeAll(async () => {
  t = await createTestLedger();
});
afterAll(() => t.close());

/**
 * Model-based property test. fast-check generates random sequences of operations; we run each
 * sequence against the REAL ledger (real Postgres) and against a tiny in-memory model, then demand:
 *   - every operation succeeds or fails exactly as the model predicts, with the predicted error
 *   - final available/held balances equal the model's
 *   - the ledger's own invariants hold (total == 0, balanced, balances == entries, held == holds)
 * A failing sequence is shrunk to a minimal reproduction.
 */
type Op =
  | { k: 'topup'; a: number; amt: number }
  | { k: 'transfer'; f: number; t: number; amt: number; bps: number }
  | { k: 'hold'; a: number; amt: number }
  | { k: 'capture'; h: number; to: number; pct: number; bps: number }
  | { k: 'release'; h: number }
  | { k: 'reverse'; x: number };

const W = 4; // wallets under test; index W = fees account, W+1 = gateway clearing

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('topup' as const), a: fc.nat(W - 1), amt: fc.integer({ min: 1, max: 5_000 }) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant('transfer' as const),
      f: fc.nat(W - 1),
      t: fc.nat(W - 1),
      amt: fc.integer({ min: 1, max: 4_000 }),
      bps: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 1_000 })),
    }),
  },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('hold' as const), a: fc.nat(W - 1), amt: fc.integer({ min: 1, max: 3_000 }) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('capture' as const),
      h: fc.nat(50),
      to: fc.nat(W - 1),
      pct: fc.integer({ min: 1, max: 100 }),
      bps: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 1_000 })),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('release' as const), h: fc.nat(50) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('reverse' as const), x: fc.nat(50) }) },
);

interface MEntry {
  acc: number;
  dir: 'debit' | 'credit';
  amt: bigint;
}

let runCounter = 0;
/** How many operations of each kind succeeded / were correctly rejected, to prove coverage. */
const stats: Record<string, number> = {};
const count = (key: string) => (stats[key] = (stats[key] ?? 0) + 1);

async function runSequence(ops: Op[]) {
  const run = ++runCounter;
  const ids: string[] = [];
  // Fund every wallet so most generated operations can actually succeed (an empty ledger would
  // reject nearly everything and the test would prove little).
  for (let i = 0; i < W; i++) ids.push(await t.wallet(`prop-${run}-${i}`, 6_000n));
  ids.push(await t.ledger.systemAccountId(t.db, 'fees'));
  ids.push(await t.ledger.systemAccountId(t.db, 'gateway_clearing'));
  const allowNeg = [false, false, false, false, false, true];

  const avail: bigint[] = [];
  const held: bigint[] = [];
  for (const id of ids) {
    const b = await t.balance(id);
    avail.push(b.available);
    held.push(b.held);
  }

  const holds: { id: string; acc: number; amt: bigint; status: 'active' | 'captured' | 'released' }[] = [];
  const txs: { id: string; entries: MEntry[]; reversed: boolean; isReversal: boolean }[] = [];

  const expectCode = async (p: Promise<unknown>, expected: string) => {
    try {
      await p;
    } catch (e) {
      const code = (e as DomainError).code;
      if (code !== expected) throw new Error(`expected ${expected}, got ${code ?? e}`);
      count(`rejected:${expected}`);
      return;
    }
    throw new Error(`expected failure ${expected} but call succeeded`);
  };

  for (const op of ops) {
    switch (op.k) {
      case 'topup': {
        const amt = BigInt(op.amt);
        const r = await t.ledger.topUp({ accountId: ids[op.a]!, amountMinor: amt, idempotencyKey: t.key() });
        count('ok:topup');
        avail[op.a]! += amt;
        avail[W + 1]! -= amt;
        txs.push({ id: r.transaction.id, isReversal: false, reversed: false, entries: [{ acc: W + 1, dir: 'debit', amt }, { acc: op.a, dir: 'credit', amt }] });
        break;
      }
      case 'transfer': {
        if (op.f === op.t) break;
        const amt = BigInt(op.amt);
        const fee = op.bps ? feeFor(amt, op.bps) : 0n;
        const call = t.ledger.transfer({ fromAccountId: ids[op.f]!, toAccountId: ids[op.t]!, amountMinor: amt, feeBps: op.bps || undefined, idempotencyKey: t.key() });
        if (avail[op.f]! < amt) {
          await expectCode(call, 'insufficient_funds');
          break;
        }
        const r = await call;
        count(fee > 0n ? 'ok:transfer+fee' : 'ok:transfer');
        avail[op.f]! -= amt;
        avail[op.t]! += amt - fee;
        const entries: MEntry[] = [{ acc: op.f, dir: 'debit', amt }, { acc: op.t, dir: 'credit', amt: amt - fee }];
        if (fee > 0n) {
          avail[W]! += fee;
          entries.push({ acc: W, dir: 'credit', amt: fee });
        }
        txs.push({ id: r.transaction.id, isReversal: false, reversed: false, entries });
        break;
      }
      case 'hold': {
        const amt = BigInt(op.amt);
        const call = t.holds.createHold({ accountId: ids[op.a]!, amountMinor: amt, idempotencyKey: t.key() });
        if (avail[op.a]! < amt) {
          await expectCode(call, 'insufficient_funds');
          break;
        }
        const r = await call;
        count('ok:hold');
        avail[op.a]! -= amt;
        held[op.a]! += amt;
        holds.push({ id: r.hold.id, acc: op.a, amt, status: 'active' });
        break;
      }
      case 'capture': {
        const h = holds[op.h % Math.max(holds.length, 1)];
        if (!h || op.to === h.acc) break;
        const amt = h.amt * BigInt(op.pct) / 100n || 1n;
        const call = t.holds.captureHold({ holdId: h.id, toAccountId: ids[op.to]!, amountMinor: amt, feeBps: op.bps || undefined, idempotencyKey: t.key() });
        if (h.status !== 'active') {
          await expectCode(call, 'invalid_hold_state');
          break;
        }
        const r = await call;
        const fee = op.bps ? feeFor(amt, op.bps) : 0n;
        count(amt < h.amt ? 'ok:capture-partial' : 'ok:capture-full');
        held[h.acc]! -= h.amt;
        avail[h.acc]! += h.amt - amt; // unused remainder returns to available
        avail[op.to]! += amt - fee;
        const entries: MEntry[] = [{ acc: h.acc, dir: 'debit', amt }, { acc: op.to, dir: 'credit', amt: amt - fee }];
        if (fee > 0n) {
          avail[W]! += fee;
          entries.push({ acc: W, dir: 'credit', amt: fee });
        }
        h.status = 'captured';
        txs.push({ id: r.transaction.id, isReversal: false, reversed: false, entries });
        break;
      }
      case 'release': {
        const h = holds[op.h % Math.max(holds.length, 1)];
        if (!h) break;
        if (h.status === 'captured') {
          await expectCode(t.holds.releaseHold(h.id), 'invalid_hold_state');
          break;
        }
        await t.holds.releaseHold(h.id);
        if (h.status === 'active') {
          count('ok:release');
          held[h.acc]! -= h.amt;
          avail[h.acc]! += h.amt;
          h.status = 'released';
        }
        break;
      }
      case 'reverse': {
        const x = txs[op.x % Math.max(txs.length, 1)];
        if (!x) break;
        const call = t.ledger.reverse({ transactionId: x.id, idempotencyKey: t.key() });
        if (x.isReversal) {
          await expectCode(call, 'not_reversible');
          break;
        }
        if (x.reversed) {
          await expectCode(call, 'already_reversed');
          break;
        }
        // Flipped entries: original debit -> credit, credit -> debit (all against available).
        const net = new Map<number, bigint>();
        for (const e of x.entries) net.set(e.acc, (net.get(e.acc) ?? 0n) + (e.dir === 'debit' ? e.amt : -e.amt));
        const overdraws = [...net].some(([acc, d]) => !allowNeg[acc]! && avail[acc]! + d < 0n);
        if (overdraws) {
          await expectCode(call, 'insufficient_funds');
          break;
        }
        const r = await call;
        count('ok:reverse');
        for (const [acc, d] of net) avail[acc]! += d;
        x.reversed = true;
        txs.push({ id: r.transaction.id, isReversal: true, reversed: false, entries: x.entries.map((e) => ({ ...e, dir: e.dir === 'debit' ? 'credit' : 'debit' })) });
        break;
      }
    }
  }

  for (let i = 0; i < ids.length; i++) {
    const b = await t.balance(ids[i]!);
    if (b.available !== avail[i] || b.held !== held[i]) {
      throw new Error(`account #${i} diverged: ledger ${b.available}/${b.held} vs model ${avail[i]}/${held[i]}`);
    }
  }
  await expectInvariants(t);
}

describe('ledger vs model (property based)', () => {
  it('any random sequence of top-ups, transfers, holds, captures, releases and reversals matches the model and keeps all invariants', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        await runSequence(ops);
      }),
      { numRuns: 60 },
    );
    // Guard against a vacuous test: every operation kind must have succeeded at least once.
    for (const k of ['ok:topup', 'ok:transfer', 'ok:transfer+fee', 'ok:hold', 'ok:capture-partial', 'ok:capture-full', 'ok:release', 'ok:reverse', 'rejected:insufficient_funds']) {
      if (!stats[k]) throw new Error(`property test never exercised ${k}: ${JSON.stringify(stats)}`);
    }
    console.log('property test coverage', JSON.stringify(stats));
  }, 240_000);
});
