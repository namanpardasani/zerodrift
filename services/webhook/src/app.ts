import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter, bootstrap, createHealthModule, createLogger } from '@zerodrift/common';
import { TOPICS, TOPIC_SPECS } from '@zerodrift/config';
import { createDb, createPool, migrateToLatest, sql } from '@zerodrift/db';
import { type RunningConsumer, createKafka, ensureTopics, startIdempotentConsumer } from '@zerodrift/kafka';
import { AdminGuard, MerchantGuard, type MerchantAuthenticator } from './auth.js';
import { DEFAULT_WEBHOOK_CONFIG, type WebhookConfig } from './config.js';
import type { WebhookDB } from './db-schema.js';
import { AuditService } from './audit.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { DeliveryWorker } from './delivery-worker.js';
import { EndpointsService } from './endpoints.service.js';
import { createEventHandler } from './event-handler.js';
import { AUTHENTICATOR, CONFIG, DB } from './tokens.js';
import { WebhookAdminController, WebhookController } from './webhook.controller.js';

export interface WebhookAppOptions {
  databaseUrl: string;
  port: number;
  /** How API keys are verified (production: PaymentsAuthenticator). */
  authenticator: MerchantAuthenticator;
  config: Partial<WebhookConfig> & { encryptionKey: Buffer };
  /** Omit to run without consuming events (the delivery API/worker still work). */
  kafkaBrokers?: string[];
  /** Set false to drive the delivery worker by hand in tests. */
  startWorker?: boolean;
  poolMax?: number;
  logLevel?: string;
}

export interface RunningWebhook {
  app: INestApplication;
  url: string;
  db: ReturnType<typeof createDb<WebhookDB>>;
  config: WebhookConfig;
  deliveries: DeliveriesService;
  endpoints: EndpointsService;
  worker: DeliveryWorker;
  close: () => Promise<void>;
}

export async function startWebhook(opts: WebhookAppOptions): Promise<RunningWebhook> {
  const log = createLogger('webhook', opts.logLevel ?? 'info');
  const pool = createPool(opts.databaseUrl, opts.poolMax ?? 20);
  const db = createDb<WebhookDB>(pool);
  const applied = await migrateToLatest(db, path.join(__dirname, 'migrations'));
  log.info({ applied }, 'migrations complete');

  const config: WebhookConfig = { ...DEFAULT_WEBHOOK_CONFIG, ...opts.config };
  const Health = createHealthModule('webhook', [{ name: 'postgres', check: async () => void (await sql`select 1`.execute(db)) }]);

  @Module({
    imports: [Health],
    controllers: [WebhookController, WebhookAdminController],
    providers: [
      { provide: DB, useValue: db },
      { provide: CONFIG, useValue: config },
      { provide: AUTHENTICATOR, useValue: opts.authenticator },
      { provide: APP_FILTER, useClass: ErrorFilter },
      MerchantGuard,
      AdminGuard,
      AuditService,
      EndpointsService,
      DeliveriesService,
    ],
  })
  class WebhookModule {}

  const app = await bootstrap(WebhookModule, opts.port, 'webhook', { silent: opts.logLevel === 'silent' });
  const deliveries = app.get(DeliveriesService);
  const endpoints = app.get(EndpointsService);
  const worker = new DeliveryWorker(deliveries, {
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    onError: (err) => log.error({ err: (err as Error).message }, 'delivery worker error'),
  });
  if (opts.startWorker ?? true) worker.start();

  // Consume events in the background; Kafka being down must not stop the API or the worker.
  let consumer: RunningConsumer | undefined;
  let stopped = false;
  const consuming = opts.kafkaBrokers?.length
    ? (async () => {
        for (let attempt = 1; !stopped; attempt++) {
          try {
            const kafka = createKafka({ brokers: opts.kafkaBrokers!, clientId: 'webhook-service' });
            await ensureTopics(kafka, TOPIC_SPECS);
            consumer = await startIdempotentConsumer({
              kafka,
              groupId: 'webhook-service',
              topics: [TOPICS.payments],
              db,
              handler: createEventHandler(deliveries),
              onError: (err, info) => log.warn({ err: (err as Error).message, ...info }, 'event handling failed'),
            });
            log.info('event consumer started');
            return;
          } catch (err) {
            log.warn({ attempt, err: (err as Error).message }, 'kafka not reachable yet, retrying');
            await new Promise((r) => setTimeout(r, Math.min(5_000, 500 * attempt)));
          }
        }
      })()
    : undefined;

  const port = (app.getHttpServer().address() as AddressInfo).port;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    db,
    config,
    deliveries,
    endpoints,
    worker,
    close: async () => {
      stopped = true;
      await consuming?.catch(() => {});
      await consumer?.stop();
      await worker.stop();
      await app.close();
      await pool.end();
    },
  };
}
