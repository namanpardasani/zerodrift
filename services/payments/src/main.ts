import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { bootstrap, createHealthModule, createLogger } from '@zerodrift/common';
import { loadConfig, z } from '@zerodrift/config';
import { createDb, createPool, migrateToLatest, sql } from '@zerodrift/db';
import * as path from 'node:path';

const config = loadConfig(
  { DATABASE_URL: z.string().min(1), MIGRATE_ON_BOOT: z.stringbool().default(true) },
  { SERVICE_NAME: 'payments', PORT: '3002', ...process.env },
);

async function main() {
  const log = createLogger(config.SERVICE_NAME, config.LOG_LEVEL);
  const pool = createPool(config.DATABASE_URL);
  const db = createDb<unknown>(pool);

  if (config.MIGRATE_ON_BOOT) {
    const applied = await migrateToLatest(db, path.join(__dirname, 'migrations'));
    log.info({ applied }, 'migrations complete');
  }

  const Health = createHealthModule(config.SERVICE_NAME, [
    { name: 'postgres', check: async () => void (await sql`select 1`.execute(db)) },
  ]);

  @Module({ imports: [Health] })
  class AppModule {}

  await bootstrap(AppModule, config.PORT, config.SERVICE_NAME);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
