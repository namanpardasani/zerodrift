import { type DynamicModule, Module, type OnApplicationBootstrap, Inject, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createHealthModule } from '@zerodrift/common';
import { sql } from 'kysely';
import { ErrorFilter } from './filters.js';
import { HoldsService } from './holds.service.js';
import { InvariantsService } from './invariants.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import type { Db } from './posting.js';
import { DB } from './tokens.js';

export interface LedgerModuleOptions {
  db: Db;
  /** Seconds between expiry sweeps; 0 disables the background sweeper (tests drive it manually). */
  holdSweepIntervalSeconds?: number;
}

export const SWEEP_INTERVAL = Symbol('SWEEP_INTERVAL');

@Module({})
export class LedgerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly ledger: LedgerService,
    private readonly holds: HoldsService,
    @Inject(SWEEP_INTERVAL) private readonly sweepSeconds: number,
  ) {}

  static forRoot(opts: LedgerModuleOptions): DynamicModule {
    const Health = createHealthModule('ledger', [
      { name: 'postgres', check: async () => void (await sql`select 1`.execute(opts.db)) },
    ]);
    return {
      module: LedgerModule,
      imports: [Health],
      controllers: [LedgerController],
      providers: [
        { provide: DB, useValue: opts.db },
        { provide: SWEEP_INTERVAL, useValue: opts.holdSweepIntervalSeconds ?? 10 },
        { provide: APP_FILTER, useClass: ErrorFilter },
        LedgerService,
        HoldsService,
        InvariantsService,
      ],
    };
  }

  async onApplicationBootstrap() {
    await this.ledger.ensureSystemAccounts();
    if (this.sweepSeconds > 0) {
      this.timer = setInterval(() => {
        this.holds.expireDueHolds().catch((err) => console.error('hold sweep failed', err));
      }, this.sweepSeconds * 1000);
      this.timer.unref();
    }
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
