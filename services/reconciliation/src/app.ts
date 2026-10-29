import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter, bootstrap, createHealthModule, createLogger } from '@zerodrift/common';
import { createDb, createPool, migrateToLatest, sql } from '@zerodrift/db';
import type { ReconDB } from './db-schema.js';
import { ADMIN_TOKEN, AdminGuard, ReconController } from './recon.controller.js';
import { DEFAULT_RECON_CONFIG, type ReconConfig, Reconciler } from './reconciler.service.js';
import { ReconScheduler } from './scheduler.js';
import type { Sources } from './sources.js';

export interface ReconAppOptions {
  databaseUrl: string;
  port: number;
  sources: Sources;
  adminToken: string;
  config?: Partial<ReconConfig>;
  /** Scheduled run intervals in ms. Omit to disable the scheduler (tests run reconciliations by hand). */
  scheduleMs?: { internal: number; external: number };
  logLevel?: string;
  /** Test hook: override the clock. */
  now?: () => Date;
}

export interface RunningRecon {
  app: INestApplication;
  url: string;
  reconciler: Reconciler;
  db: ReturnType<typeof createDb<ReconDB>>;
  close: () => Promise<void>;
}

export async function startReconciliation(opts: ReconAppOptions): Promise<RunningRecon> {
  const log = createLogger('reconciliation', opts.logLevel ?? 'info');
  const pool = createPool(opts.databaseUrl, 10);
  const db = createDb<ReconDB>(pool);
  const applied = await migrateToLatest(db, path.join(__dirname, 'migrations'));
  log.info({ applied }, 'migrations complete');

  const reconciler = new Reconciler(db, pool, opts.sources, { ...DEFAULT_RECON_CONFIG, ...opts.config }, opts.now);
  const Health = createHealthModule('reconciliation', [{ name: 'postgres', check: async () => void (await sql`select 1`.execute(db)) }]);

  @Module({
    imports: [Health],
    controllers: [ReconController],
    providers: [{ provide: Reconciler, useValue: reconciler }, { provide: ADMIN_TOKEN, useValue: opts.adminToken }, { provide: APP_FILTER, useClass: ErrorFilter }, AdminGuard],
  })
  class ReconModule {}

  const app = await bootstrap(ReconModule, opts.port, 'reconciliation', { silent: opts.logLevel === 'silent' });
  const scheduler = opts.scheduleMs ? new ReconScheduler(reconciler, opts.scheduleMs, (kind, err) => log.error({ kind, err: (err as Error).message }, 'scheduled run failed')) : undefined;
  scheduler?.start();

  const port = (app.getHttpServer().address() as AddressInfo).port;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    reconciler,
    db,
    close: async () => {
      await scheduler?.stop();
      await app.close();
      await pool.end();
    },
  };
}
