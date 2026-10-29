import { type DynamicModule, Module, type OnApplicationBootstrap, type OnApplicationShutdown, Inject, Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter, createHealthModule } from '@zerodrift/common';
import { sql } from 'kysely';
import { AdminController, GatewayCallbackController } from './admin.controller.js';
import { AdminQueries } from './admin-queries.js';
import { GatewayClient } from './clients/gateway.client.js';
import { LedgerClient } from './clients/ledger.client.js';
import { IdempotencyService } from './idempotency.service.js';
import { AdminGuard, MerchantAuthGuard, MerchantsService } from './merchants.service.js';
import { PaymentsController } from './payments.controller.js';
import { type Db, PaymentsRepo } from './payments.repo.js';
import { PaymentsService } from './payments.service.js';
import { ReconciliationFeed } from './reconciliation-feed.js';
import { RecoveryService } from './recovery.service.js';
import { RefundsService } from './refunds.service.js';
import { SagaService } from './saga.service.js';
import { CONFIG, DB, GATEWAY, LEDGER, type PaymentsConfig } from './tokens.js';

export interface PaymentsModuleOptions {
  db: Db;
  ledger: LedgerClient;
  gateway: GatewayClient;
  config: PaymentsConfig;
  /** Disable the background recovery timer (tests call the job explicitly). */
  recoveryScheduler?: boolean;
}

const SCHEDULER = Symbol('RECOVERY_SCHEDULER');

@Module({})
export class PaymentsModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('RecoveryScheduler');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly recovery: RecoveryService,
    @Inject(CONFIG) private readonly config: PaymentsConfig,
    @Inject(SCHEDULER) private readonly enabled: boolean,
  ) {}

  static forRoot(opts: PaymentsModuleOptions): DynamicModule {
    const Health = createHealthModule('payments', [{ name: 'postgres', check: async () => void (await sql`select 1`.execute(opts.db)) }]);
    return {
      module: PaymentsModule,
      imports: [Health],
      controllers: [PaymentsController, AdminController, GatewayCallbackController],
      providers: [
        { provide: DB, useValue: opts.db },
        { provide: CONFIG, useValue: opts.config },
        { provide: LEDGER, useValue: opts.ledger },
        { provide: GATEWAY, useValue: opts.gateway },
        { provide: SCHEDULER, useValue: opts.recoveryScheduler ?? true },
        { provide: APP_FILTER, useClass: ErrorFilter },
        PaymentsRepo,
        IdempotencyService,
        MerchantsService,
        MerchantAuthGuard,
        AdminGuard,
        SagaService,
        PaymentsService,
        RefundsService,
        RecoveryService,
        ReconciliationFeed,
        AdminQueries,
      ],
    };
  }

  onApplicationBootstrap() {
    if (!this.enabled) return;
    let running = false; // never overlap two sweeps in one process
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      this.recovery
        .runOnce()
        .catch((err) => this.log.error(`recovery sweep failed: ${(err as Error).message}`))
        .finally(() => (running = false));
    }, this.config.recoveryIntervalSeconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
