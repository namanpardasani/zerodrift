import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { Selectable } from 'kysely';
import type { MerchantsTable } from './db-schema.js';
import { Errors } from './errors.js';
import type { LedgerClient } from './clients/ledger.client.js';
import type { Db } from './payments.repo.js';
import { CONFIG, DB, LEDGER, type PaymentsConfig } from './tokens.js';

export type Merchant = Selectable<MerchantsTable>;

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

@Injectable()
export class MerchantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LEDGER) private readonly ledger: LedgerClient,
  ) {}

  /** Create a merchant + its ledger wallet. The plaintext API key is returned ONCE and never stored. */
  async create(input: { name: string; feeBps?: number; rateLimitPerMin?: number }) {
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
  constructor(private readonly merchants: MerchantsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { merchant?: Merchant }>();
    const header = req.headers.authorization;
    const key = header?.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined);
    if (!key) throw Errors.unauthorized();
    const merchant = await this.merchants.authenticate(key);
    if (!merchant) throw Errors.unauthorized();
    req.merchant = merchant;
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
