import 'reflect-metadata';
import { bootstrap, createLogger } from '@zerodrift/common';
import { loadConfig, z } from '@zerodrift/config';
import { createDb, createPool, migrateToLatest } from '@zerodrift/db';
import * as path from 'node:path';
import type { LedgerDB } from './db-schema.js';
import { LedgerModule } from './ledger.module.js';

const config = loadConfig(
  {
    DATABASE_URL: z.string().min(1),
    MIGRATE_ON_BOOT: z.stringbool().default(true),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
    HOLD_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(10),
  },
  { SERVICE_NAME: 'ledger', PORT: '3001', ...process.env },
);

async function main() {
  const log = createLogger(config.SERVICE_NAME, config.LOG_LEVEL);
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
  const db = createDb<LedgerDB>(pool);

  if (config.MIGRATE_ON_BOOT) {
    const applied = await migrateToLatest(db, path.join(__dirname, 'migrations'));
    log.info({ applied }, 'migrations complete');
  }

  await bootstrap(
    LedgerModule.forRoot({ db, holdSweepIntervalSeconds: config.HOLD_SWEEP_INTERVAL_SECONDS }),
    config.PORT,
    config.SERVICE_NAME,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
