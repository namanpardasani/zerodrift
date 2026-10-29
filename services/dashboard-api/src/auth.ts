import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@zerodrift/common';
import type { Request } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { DashboardConfig } from './config.js';

export const CONFIG = Symbol('DASHBOARD_CONFIG');

const ISSUER = 'zerodrift-dashboard';
const AUDIENCE = 'zerodrift-dashboard';

/** Compare secrets in constant time (hash both first so the lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(CONFIG) private readonly config: DashboardConfig) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  async issue(subject: string): Promise<{ token: string; expiresInSeconds: number }> {
    const token = await new SignJWT({ role: 'operator' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.tokenTtlSeconds}s`)
      .sign(this.key);
    return { token, expiresInSeconds: this.config.tokenTtlSeconds };
  }

  /** Only HS256 is accepted (pinning the algorithm blocks "alg: none" and key-confusion tricks). */
  async verify(token: string): Promise<{ sub: string }> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    if (payload.role !== 'operator' || !payload.sub) throw new Error('not an operator token');
    return { sub: payload.sub };
  }
}

/**
 * Brute-force guard for the login endpoint: after N failures from one client within the window,
 * further attempts get 429 until the oldest failure ages out. (In-memory: per instance.)
 */
@Injectable()
export class LoginLimiter {
  private failures = new Map<string, number[]>();

  constructor(@Inject(CONFIG) private readonly config: DashboardConfig) {}

  private recent(key: string, now: number): number[] {
    const windowMs = this.config.loginWindowSeconds * 1000;
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < windowMs);
    this.failures.set(key, list);
    return list;
  }

  assertAllowed(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    if (list.length >= this.config.loginMaxFailures) {
      const retryAfter = Math.max(1, Math.ceil((list[0]! + this.config.loginWindowSeconds * 1000 - now) / 1000));
      throw new DomainError('rate_limited', 'Too many failed logins, try again later', 429, { retryAfterSeconds: retryAfter });
    }
  }

  recordFailure(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { operator?: string }>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new DomainError('unauthorized', 'Login required', 401);
    try {
      req.operator = (await this.tokens.verify(token)).sub;
    } catch {
      throw new DomainError('unauthorized', 'Session expired or invalid, log in again', 401); // same message for expired/forged: leak nothing
    }
    return true;
  }
}
