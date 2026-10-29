import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, Optional, createParamDecorator } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Selectable } from 'kysely';
import type { MerchantsTable } from './db-schema.js';
import { Errors } from './errors.js';
import type { LedgerClient } from './clients/ledger.client.js';
import type { Db } from './payments.repo.js';
import { AuditService } from './audit.service.js';
import type { RateLimiter } from './rate-limiter.js';
import { CONFIG, DB, LEDGER, RATE_LIMITER, type PaymentsConfig } from './tokens.js';

export type Merchant = Selectable<MerchantsTable>;

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

@Injectable()
export class MerchantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LEDGER) private readonly ledger: LedgerClient,
    private readonly audit: AuditService,
  ) {}

  /** Create a merchant + its ledger wallet. The plaintext API key is returned ONCE and never stored. */
  async create(input: { name: string; feeBps?: number; rateLimitPerMin?: number }, ip?: string) {
    const id = randomUUID();
    const wallet = await this.ledger.wallet('merchant', id);
    const apiKey = `zd_live_${randomBytes(32).toString('base64url')}`;
    const row = await this.db
      .insertInto('merchants')
      .values({
        id,
        name: input.name,
        api_key_hash: hashApiKey(apiKey),
        api_key_prefix: apiKey.slice(0, 12),
        fee_bps: input.feeBps ?? 250,
        rate_limit_per_min: input.rateLimitPerMin ?? 600,
        ledger_account_id: wallet.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.write({ actor: 'admin', merchantId: id, action: 'merchant.created', resourceType: 'merchant', resourceId: id, ip, details: { name: input.name, feeBps: row.fee_bps, rateLimitPerMin: row.rate_limit_per_min } }); // never the key
    return { merchant: this.publicView(row), apiKey };
  }

  async authenticate(apiKey: string): Promise<Merchant | null> {
    const m = await this.db.selectFrom('merchants').selectAll().where('api_key_hash', '=', hashApiKey(apiKey)).executeTakeFirst();
    return m && m.status === 'active' ? m : null;
  }

  async get(id: string): Promise<Merchant> {
    const m = await this.db.selectFrom('merchants').selectAll().where('id', '=', id).executeTakeFirst();
    if (!m) throw Errors.notFound('Merchant', id);
    return m;
  }

  async list() {
    const rows = await this.db.selectFrom('merchants').selectAll().orderBy('created_at', 'desc').execute();
    return rows.map((r) => this.publicView(r));
  }

  publicView(m: Merchant) {
    return {
      id: m.id,
      name: m.name,
      apiKeyPrefix: m.api_key_prefix,
      feeBps: m.fee_bps,
      rateLimitPerMin: m.rate_limit_per_min,
      ledgerAccountId: m.ledger_account_id,
      status: m.status,
      createdAt: m.created_at.toISOString(),
    };
  }
}

/** Authenticates `Authorization: Bearer <api key>` (or `x-api-key`) and attaches the merchant. */
@Injectable()
export class MerchantAuthGuard implements CanActivate {
  constructor(
    private readonly merchants: MerchantsService,
    @Optional() @Inject(RATE_LIMITER) private readonly limiter?: RateLimiter,
  ) {}

  /**
   * 1. Refuse clients that keep presenting bad keys (cheap check, BEFORE the database lookup).
   * 2. Authenticate the key.
   * 3. Spend a token from THIS merchant's bucket: one noisy merchant cannot slow the others, and every
   *    response tells the caller its quota (X-RateLimit-*).
   */
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & { merchant?: Merchant }>();
    const res = http.getResponse<Response>();
    const client = req.ip ?? 'unknown';

    if (this.limiter) {
      const t = await this.limiter.isThrottled(client);
      if (t.throttled) throw Errors.rateLimited(t.retryAfterSeconds);
    }
    const header = req.headers.authorization;
    const key = header?.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined);
    const merchant = key ? await this.merchants.authenticate(key) : null;
    if (!merchant) {
      // the attempt that pushes the client over its failure budget is itself refused with 429
      const f = await this.limiter?.recordFailedAuth(client);
      if (f?.throttled) throw Errors.rateLimited(f.retryAfterSeconds);
      throw Errors.unauthorized();
    }
    req.merchant = merchant;

    if (this.limiter) {
      const d = await this.limiter.consume(merchant.id, merchant.rate_limit_per_min);
      res.setHeader('X-RateLimit-Limit', String(d.limit));
      res.setHeader('X-RateLimit-Remaining', String(d.remaining));
      if (!d.allowed) throw Errors.rateLimited(d.retryAfterSeconds);
    }
    return true;
  }
}

/** Protects admin/internal endpoints with a shared token (dev/ops only; dashboard JWT auth comes later). */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: PaymentsConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const expected = Buffer.from(this.config.adminToken);
    // constant-time compare so the token cannot be guessed byte by byte from response timing
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw Errors.unauthorized();
    return true;
  }
}

export const CurrentMerchant = createParamDecorator((_d: unknown, ctx: ExecutionContext): Merchant => ctx.switchToHttp().getRequest<{ merchant: Merchant }>().merchant);
