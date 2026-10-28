import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter, bootstrap, createHealthModule, createLogger } from '@zerodrift/common';
import { createDb, createPool, ensureDatabase, migrateToLatest, sql } from '@zerodrift/db';
import { FaultSettings } from './faults.js';
import { GatewayController } from './gateway.controller.js';
import { CALLBACK_SECRET, FAULTS, GATEWAY_DB, GatewayService, type GatewayDB } from './gateway.service.js';

export interface GatewayAppOptions {
  databaseUrl: string;
  /** If set, the database is created on boot when missing (connects to the server's admin db). */
  adminDatabaseUrl?: string;
  databaseName?: string;
  port: number;
  callbackSecret?: string;
  logLevel?: string;
}

export interface RunningGateway {
  app: INestApplication;
  url: string;
  faults: FaultSettings;
  close: () => Promise<void>;
}

export async function startGateway(opts: GatewayAppOptions): Promise<RunningGateway> {
  const log = createLogger('mock-gateway', opts.logLevel ?? 'info');
  if (opts.adminDatabaseUrl && opts.databaseName) await ensureDatabase(opts.adminDatabaseUrl, opts.databaseName);
  const pool = createPool(opts.databaseUrl, 20);
  const db = createDb<GatewayDB>(pool);
  const applied = await migrateToLatest(db, path.join(__dirname, 'migrations'));
  log.info({ applied }, 'migrations complete');

  const faults = new FaultSettings();
  const Health = createHealthModule('mock-gateway', [{ name: 'postgres', check: async () => void (await sql`select 1`.execute(db)) }]);

  @Module({
    imports: [Health],
    controllers: [GatewayController],
    providers: [
      { provide: GATEWAY_DB, useValue: db },
      { provide: FAULTS, useValue: faults },
      { provide: CALLBACK_SECRET, useValue: opts.callbackSecret ?? 'dev-gateway-secret' },
      { provide: APP_FILTER, useClass: ErrorFilter },
      GatewayService,
    ],
  })
  class GatewayModule {}

  const app = await bootstrap(GatewayModule, opts.port, 'mock-gateway');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    faults,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
