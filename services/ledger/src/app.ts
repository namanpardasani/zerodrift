import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { bootstrap, createLogger } from '@zerodrift/common';
import { createDb, createPool, migrateToLatest } from '@zerodrift/db';
import { type OutboxRelay, startOutboxRelay } from '@zerodrift/kafka';
import type { LedgerDB } from './db-schema.js';
import { LedgerModule } from './ledger.module.js';

export interface LedgerAppOptions {
  databaseUrl: string;
  /** 0 picks a free port (tests). */
  port: number;
  migrate?: boolean;
  poolMax?: number;
  holdSweepIntervalSeconds?: number;
  /** Kafka bootstrap servers. Omit to run without publishing events (events still accumulate in the outbox). */
  kafkaBrokers?: string[];
  logLevel?: string;
}

export interface RunningLedger {
  app: INestApplication;
  pool: ReturnType<typeof createPool>;
  url: string;
  relay?: OutboxRelay;
  close: () => Promise<void>;
}

/** Build, migrate and start the ledger. Used by main.ts and by other services' integration tests. */
export async function startLedger(opts: LedgerAppOptions): Promise<RunningLedger> {
  const log = createLogger('ledger', opts.logLevel ?? 'info');
  const pool = createPool(opts.databaseUrl, opts.poolMax ?? 20);
  const db = createDb<LedgerDB>(pool);
  if (opts.migrate ?? true) {
    const applied = await migrateToLatest(db, path.join(__dirname, 'migrations'));
    log.info({ applied }, 'migrations complete');
  }
  const app = await bootstrap(
    LedgerModule.forRoot({ db, holdSweepIntervalSeconds: opts.holdSweepIntervalSeconds ?? 10 }),
    opts.port,
    'ledger',
    { silent: opts.logLevel === 'silent' },
  );
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const relay = opts.kafkaBrokers?.length
    ? startOutboxRelay({ db, brokers: opts.kafkaBrokers, service: 'ledger', lockId: 74_001, log: (m, x) => log.info(x ?? {}, m) })
    : undefined;
  return {
    app,
    pool,
    url: `http://127.0.0.1:${port}`,
    relay,
    close: async () => {
      await relay?.stop();
      await app.close();
      await pool.end();
    },
  };
}
