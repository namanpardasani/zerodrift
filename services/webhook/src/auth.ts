import { type CanActivate, type ExecutionContext, Inject, Injectable, createParamDecorator } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AUTHENTICATOR, CONFIG } from './tokens.js';
import type { WebhookConfig } from './config.js';

export interface MerchantAuthenticator {
  /** Returns the merchant id for a valid API key, or null for an unknown key. Throws if it cannot decide. */
  authenticate(apiKey: string): Promise<{ id: string } | null>;
}

/**
 * Merchants authenticate here with the SAME API key they use for the payments API. The key is only
 * ever hashed inside payments-service, so we do not copy it: we ask payments `GET /v1/me`.
 * Successful lookups are cached briefly to keep that call off the hot path.
 */
export class PaymentsAuthenticator implements MerchantAuthenticator {
  private cache = new Map<string, { id: string; expires: number }>();

  constructor(
    private readonly paymentsUrl: string,
    private readonly ttlMs = 30_000,
  ) {}

  async authenticate(apiKey: string): Promise<{ id: string } | null> {
    const hit = this.cache.get(apiKey);
    if (hit && hit.expires > Date.now()) return { id: hit.id };
    let res: Response;
    try {
      res = await fetch(`${this.paymentsUrl}/v1/me`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3_000) });
    } catch {
      throw new DomainError('auth_unavailable', 'Cannot verify API key right now', 503);
    }
    if (res.status === 401) return null;
    if (!res.ok) throw new DomainError('auth_unavailable', 'Cannot verify API key right now', 503);
    const { id } = (await res.json()) as { id: string };
    this.cache.set(apiKey, { id, expires: Date.now() + this.ttlMs });
    return { id };
  }
}

@Injectable()
export class MerchantGuard implements CanActivate {
  constructor(@Inject(AUTHENTICATOR) private readonly auth: MerchantAuthenticator) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { merchantId?: string }>();
    const header = req.headers.authorization;
    const key = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const merchant = key ? await this.auth.authenticate(key) : null;
    if (!merchant) throw new DomainError('unauthorized', 'Missing or invalid API key', 401);
    req.merchantId = merchant.id;
    return true;
  }
}

export const MerchantId = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest<{ merchantId: string }>().merchantId);

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: WebhookConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const expected = Buffer.from(this.config.adminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new DomainError('unauthorized', 'Admin token required', 401);
    return true;
  }
}
