import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { bootstrap, createLogger } from '@zerodrift/common';
import { createDb, createPool, migrateToLatest } from '@zerodrift/db';
import { type OutboxRelay, startOutboxRelay } from '@zerodrift/kafka';
import { GatewayClient, type GatewayClientOptions } from './clients/gateway.client.js';
import { LedgerClient } from './clients/ledger.client.js';
import type { PaymentsDB } from './db-schema.js';
import { PaymentsModule } from './payments.module.js';
import type { PaymentsConfig } from './tokens.js';

export interface PaymentsAppOptions {
  databaseUrl: string;
  port: number;
  ledgerUrl: string;
  gatewayUrl: string;
  /** Where the gateway should POST async callbacks. Defaults to this service's own address. */
  publicUrl?: string;
  config?: Partial<PaymentsConfig>;
  gatewayClient?: Partial<GatewayClientOptions>;
  ledgerTimeoutMs?: number;
  migrate?: boolean;
  poolMax?: number;
  recoveryScheduler?: boolean;
  /** Kafka bootstrap servers. Omit to run without publishing events (events still accumulate in the outbox). */
  kafkaBrokers?: string[];
  logLevel?: string;
}

export interface RunningPayments {
  app: INestApplication;
  url: string;
  db: ReturnType<typeof createDb<PaymentsDB>>;
  gateway: GatewayClient;
  ledger: LedgerClient;
  config: PaymentsConfig;
  relay?: OutboxRelay;
  close: () => Promise<void>;
}

export const DEFAULT_CONFIG: PaymentsConfig = {
  holdTtlSeconds: 30 * 60,
  leaseSeconds: 20,
  recoveryStuckAfterSeconds: 30,
  recoveryAbandonAfterSeconds: 300,
  recoveryIntervalSeconds: 10,
  adminToken: 'dev-admin-token',
  gatewayCallbackSecret: 'dev-gateway-secret',
};

export async function startPayments(opts: PaymentsAppOptions): Promise<RunningPayments> {
  const log = createLogger('payments', opts.logLevel ?? 'info');
  const pool = createPool(opts.databaseUrl, opts.poolMax ?? 20);
  const db = createDb<PaymentsDB>(pool);
  if (opts.migrate ?? true) {
    const applied = await migrateToLatest(db, path.join(__dirname, 'migrations'));
    log.info({ applied }, 'migrations complete');
  }

  const config: PaymentsConfig = { ...DEFAULT_CONFIG, ...opts.config };
  const ledger = new LedgerClient({ baseUrl: opts.ledgerUrl, timeoutMs: opts.ledgerTimeoutMs });
  const gateway = new GatewayClient({ baseUrl: opts.gatewayUrl, ...opts.gatewayClient });
  if (opts.publicUrl) gateway.setCallbackUrl(`${opts.publicUrl}/internal/gateway-callback`);

  const app = await bootstrap(
    PaymentsModule.forRoot({ db, ledger, gateway, config, recoveryScheduler: opts.recoveryScheduler }),
    opts.port,
    'payments',
    { silent: opts.logLevel === 'silent' },
  );
  const port = (app.getHttpServer().address() as AddressInfo).port;
  // With port 0 (tests) the real port is only known now; default the callback address to ourselves.
  if (!opts.publicUrl) gateway.setCallbackUrl(`http://127.0.0.1:${port}/internal/gateway-callback`);
  const relay = opts.kafkaBrokers?.length
    ? startOutboxRelay({ db, brokers: opts.kafkaBrokers, service: 'payments', lockId: 74_002, log: (m, x) => log.info(x ?? {}, m) })
    : undefined;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    db,
    gateway,
    ledger,
    config,
    relay,
    close: async () => {
      await relay?.stop();
      await app.close();
      gateway.shutdown();
      await pool.end();
    },
  };
}
