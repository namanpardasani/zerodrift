import { Body, Controller, Get, Headers, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import { LedgerClient } from './clients/ledger.client.js';
import { Errors } from './errors.js';
import * as s from './http.schemas.js';
import { CurrentMerchant, type Merchant, MerchantAuthGuard } from './merchants.service.js';
import { PaymentsService } from './payments.service.js';
import { RefundsService } from './refunds.service.js';
import { PaymentsRepo } from './payments.repo.js';
import { Inject } from '@nestjs/common';
import { LEDGER } from './tokens.js';

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value); // ZodError -> HTTP 400 via the shared ErrorFilter
}

function requireKey(key: string | undefined): string {
  if (!key || key.length > 255) throw Errors.idempotencyKeyMissing();
  return key;
}

function reply<T>(res: Response, r: { status: number; body: T; replayed: boolean }): T {
  res.status(r.status);
  if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return r.body;
}

/** The merchant-facing API. Everything requires `Authorization: Bearer <api key>`. */
@Controller('v1')
@UseGuards(MerchantAuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly repo: PaymentsRepo,
    @Inject(LEDGER) private readonly ledger: LedgerClient,
  ) {}

  @Get('me')
  async me(@CurrentMerchant() m: Merchant) {
    const wallet = await this.ledger.account(m.ledger_account_id);
    return { id: m.id, name: m.name, feeBps: m.fee_bps, balance: { availableMinor: wallet.availableMinor, heldMinor: wallet.heldMinor, currency: 'INR' } };
  }

  @Post('payments')
  async createPayment(@CurrentMerchant() m: Merchant, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.payments.create(m, parse(s.createPaymentBody, body), requireKey(key)));
  }

  @Get('payments')
  async list(@CurrentMerchant() m: Merchant, @Query() q: unknown) {
    return { payments: await this.payments.list(m, parse(s.listPaymentsQuery, q)) };
  }

  @Get('payments/:id')
  async get(@CurrentMerchant() m: Merchant, @Param('id') id: string) {
    return this.payments.get(m, parse(s.uuid, id));
  }

  @Post('payments/:id/refunds')
  async refund(
    @CurrentMerchant() m: Merchant,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return reply(res, await this.refunds.create(m, parse(s.uuid, id), parse(s.createRefundBody, body ?? {}), requireKey(key)));
  }

  @Get('payments/:id/refunds')
  async listRefunds(@CurrentMerchant() m: Merchant, @Param('id') id: string) {
    const p = await this.payments.get(m, parse(s.uuid, id));
    return { refunds: p.refunds ?? [] };
  }

  // ---- customers (wallet holders)

  @Post('customers')
  async createCustomer(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { customerId } = parse(s.createCustomerBody, body);
    const w = await this.ledger.wallet('customer', customerId);
    res.status(201);
    return { customerId, walletAccountId: w.id, balance: { availableMinor: w.availableMinor, heldMinor: w.heldMinor, currency: 'INR' } };
  }

  @Get('customers/:customerId')
  async getCustomer(@Param('customerId') customerId: string) {
    const id = parse(s.createCustomerBody, { customerId }).customerId;
    const w = await this.ledger.wallet('customer', id);
    return { customerId: id, walletAccountId: w.id, balance: { availableMinor: w.availableMinor, heldMinor: w.heldMinor, currency: 'INR' } };
  }

  /** Add funds to a customer wallet (simulated bank funding). Idempotent via the ledger's key handling. */
  @Post('customers/:customerId/topups')
  async topUp(
    @CurrentMerchant() m: Merchant,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const id = parse(s.createCustomerBody, { customerId }).customerId;
    const input = parse(s.topUpBody, body);
    const w = await this.ledger.wallet('customer', id);
    // scope the ledger key by merchant so two merchants can never collide on the same client key
    const r = await this.ledger.topUp({ accountId: w.id, amountMinor: input.amountMinor, idempotencyKey: `topup:${m.id}:${requireKey(key)}`, referenceId: input.reference });
    res.status(r.status);
    if (r.status === 200) res.setHeader('Idempotent-Replayed', 'true');
    return r.data;
  }
}
