import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import { Errors } from './errors.js';
import * as s from './http.schemas.js';
import { HoldsService } from './holds.service.js';
import { InvariantsService } from './invariants.service.js';
import { LedgerService } from './ledger.service.js';

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value); // ZodError is turned into HTTP 400 by the exception filter
}

function requireKey(key: string | undefined): string {
  if (!key || key.length > 255) throw Errors.idempotencyKeyMissing();
  return key;
}

/** 201 for a fresh operation, 200 + header for an idempotent replay of an earlier one. */
function status(res: Response, replayed: boolean) {
  res.status(replayed ? 200 : 201);
  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
}

@Controller()
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly holds: HoldsService,
    private readonly invariants: InvariantsService,
  ) {}

  @Post('accounts')
  async createAccount(@Body() body: unknown) {
    return this.ledger.createAccount(parse(s.createAccountBody, body));
  }

  @Get('accounts')
  async listAccounts(@Query() q: unknown) {
    return { accounts: await this.ledger.listAccounts(parse(s.listAccountsQuery, q)) };
  }

  @Get('accounts/:id')
  async getAccount(@Param('id') id: string) {
    return this.ledger.getAccount(parse(s.idParam, id));
  }

  @Get('accounts/:id/entries')
  async entries(@Param('id') id: string, @Query() q: unknown) {
    return { entries: await this.ledger.listEntries(parse(s.idParam, id), parse(s.entriesQuery, q)) };
  }

  @Post('topups')
  async topUp(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.ledger.topUp({ ...parse(s.topUpBody, body), idempotencyKey: requireKey(key) });
    status(res, r.replayed);
    return r.transaction;
  }

  @Post('transfers')
  async transfer(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.ledger.transfer({ ...parse(s.transferBody, body), idempotencyKey: requireKey(key) });
    status(res, r.replayed);
    return r.transaction;
  }

  @Post('transactions')
  async postTransaction(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.ledger.postTransaction({ ...parse(s.postTransactionBody, body), idempotencyKey: requireKey(key) });
    status(res, r.replayed);
    return r.transaction;
  }

  @Post('transactions/:id/reverse')
  async reverse(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.ledger.reverse({
      transactionId: parse(s.idParam, id),
      ...parse(s.reverseBody, body ?? {}),
      idempotencyKey: requireKey(key),
    });
    status(res, r.replayed);
    return r.transaction;
  }

  @Get('transactions/:id')
  async getTransaction(@Param('id') id: string) {
    return this.ledger.getTransaction(parse(s.idParam, id));
  }

  @Post('holds')
  async createHold(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.holds.createHold({ ...parse(s.createHoldBody, body), idempotencyKey: requireKey(key) });
    status(res, r.replayed);
    return r.hold;
  }

  @Get('holds/:id')
  async getHold(@Param('id') id: string) {
    return this.holds.getHold(parse(s.idParam, id));
  }

  @Post('holds/:id/capture')
  async capture(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.holds.captureHold({
      holdId: parse(s.idParam, id),
      ...parse(s.captureBody, body),
      idempotencyKey: requireKey(key),
    });
    status(res, r.replayed);
    return { hold: r.hold, transaction: r.transaction };
  }

  @Post('holds/:id/release')
  async release(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.holds.releaseHold(parse(s.idParam, id));
    status(res, r.replayed);
    return r.hold;
  }

  /** Normally driven by the background sweeper; exposed so ops/tests can trigger it. */
  @Post('internal/holds/expire')
  async expire() {
    return { expired: await this.holds.expireDueHolds() };
  }

  /** Read-only transaction feed for reconciliation. Internal network only. */
  @Get('internal/transactions')
  async listTransactions(@Query() q: unknown) {
    const p = parse(s.listTransactionsQuery, q);
    return this.ledger.listTransactions({ type: p.type, from: p.from ? new Date(p.from) : undefined, to: p.to ? new Date(p.to) : undefined, after: p.after, limit: p.limit });
  }

  @Get('internal/invariants')
  async checkInvariants() {
    return this.invariants.check();
  }
}
