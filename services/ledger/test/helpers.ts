import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { createDb, createPool } from '@zerodrift/db';
import { createTestDatabase } from '@zerodrift/testing';
import type { LedgerDB } from '../src/db-schema.js';
import { HoldsService } from '../src/holds.service.js';
import { InvariantsService } from '../src/invariants.service.js';
import { LedgerModule } from '../src/ledger.module.js';
import { LedgerService } from '../src/ledger.service.js';

const migrations = import.meta.glob<{ up: (db: any) => Promise<void> }>('../src/migrations/*.ts', { eager: true });

/** A fully wired ledger on its own fresh database, plus an HTTP base URL. */
export async function createTestLedger() {
  const { url } = await createTestDatabase();
  const pool = createPool(url, 60);
  const db = createDb<LedgerDB>(pool);
  for (const key of Object.keys(migrations).sort()) await migrations[key]!.up(db);

  const app = await NestFactory.create(LedgerModule.forRoot({ db, holdSweepIntervalSeconds: 0 }), { logger: false });
  await app.listen(0);
  const baseUrl = await app.getUrl();

  const ledger = app.get(LedgerService);
  const holds = app.get(HoldsService);
  const invariants = app.get(InvariantsService);

  let n = 0;
  /** Create a customer wallet, optionally funded via a top-up. */
  async function wallet(owner: string, fund = 0n, type: 'customer' | 'merchant' = 'customer') {
    const a = await ledger.createAccount({ ownerType: type, ownerId: owner });
    if (fund > 0n) {
      await ledger.topUp({ accountId: a.id, amountMinor: fund, idempotencyKey: `fund-${owner}-${n++}` });
    }
    return a.id;
  }
  const balance = async (id: string) => {
    const a = await ledger.getAccount(id);
    return { available: BigInt(a.availableMinor), held: BigInt(a.heldMinor) };
  };
  const key = () => `k-${randomUUID()}`;

  return {
    db,
    pool,
    app,
    baseUrl,
    ledger,
    holds,
    invariants,
    wallet,
    balance,
    key,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export type TestLedger = Awaited<ReturnType<typeof createTestLedger>>;

/** Assert the whole book is consistent; prints violations on failure. */
export async function expectInvariants(t: TestLedger) {
  const report = await t.invariants.check();
  if (!report.ok) throw new Error(`Invariants violated: ${JSON.stringify(report, null, 2)}`);
}
