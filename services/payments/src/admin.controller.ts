import { createHmac, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as s from './http.schemas.js';
import { AdminGuard, MerchantsService } from './merchants.service.js';
import { ReconciliationFeed } from './reconciliation-feed.js';
import { RecoveryService } from './recovery.service.js';
import { SagaService } from './saga.service.js';
import { isSettled } from './state-machine.js';
import { PaymentsRepo } from './payments.repo.js';
import { CONFIG, type PaymentsConfig } from './tokens.js';

/** Operator endpoints: merchant onboarding and manual recovery. Protected by the admin token. */
@Controller()
export class AdminController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly recovery: RecoveryService,
    private readonly feed: ReconciliationFeed,
  ) {}

  @Post('admin/merchants')
  @UseGuards(AdminGuard)
  async createMerchant(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.merchants.create(s.createMerchantBody.parse(body));
    res.status(201);
    return { ...r.merchant, apiKey: r.apiKey, note: 'Store this API key now; it cannot be shown again.' };
  }

  @Get('admin/merchants')
  @UseGuards(AdminGuard)
  async listMerchants() {
    return { merchants: await this.merchants.list() };
  }

  /** Read-only feed for the reconciliation service: payments (with refunds and ledger links) in a time window. */
  @Get('internal/reconciliation/payments')
  @UseGuards(AdminGuard)
  async reconciliationPayments(@Query() q: Record<string, string>) {
    return this.feed.payments({ from: q.from, to: q.to, after: q.after, limit: q.limit ? Number(q.limit) : undefined });
  }

  @Post('internal/recovery/run')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async runRecovery() {
    return this.recovery.runOnce();
  }
}

/** Receives the gateway's async notifications. May arrive late, twice, or never; all are harmless. */
@Controller('internal')
export class GatewayCallbackController {
  constructor(
    private readonly saga: SagaService,
    private readonly repo: PaymentsRepo,
    @Inject(CONFIG) private readonly config: PaymentsConfig,
  ) {}

  @Post('gateway-callback')
  @HttpCode(200)
  async callback(@Body() body: { reference?: string }, @Req() req: Request) {
    const given = Buffer.from(String(req.headers['x-gateway-signature'] ?? ''), 'hex');
    const expected = createHmac('sha256', this.config.gatewayCallbackSecret).update(JSON.stringify(body)).digest();
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ignored: 'bad_signature' };

    // The callback only NUDGES the saga. The saga re-queries the gateway itself, so a forged,
    // duplicated or reordered callback can never change a payment's state on its own.
    // Acknowledge immediately; do the work in the background (the gateway does not wait for it).
    if (body.reference && /^[0-9a-f-]{36}$/.test(body.reference)) void this.nudge(body.reference);
    return { ok: true };
  }

  /**
   * The callback often lands while the original request still holds the payment's lease (it is
   * waiting out a timeout). A single attempt would then do nothing and the nudge would be lost, so
   * keep trying briefly until the payment settles. Anything left over is picked up by the recovery job.
   */
  private async nudge(paymentId: string): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const p = await this.saga.run(paymentId, 'recovery');
        if (isSettled(p.status)) return;
      } catch {
        return; // unknown payment id or a hard error: recovery will deal with it
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
