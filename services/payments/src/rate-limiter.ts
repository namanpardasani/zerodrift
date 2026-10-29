import { registry } from '@zerodrift/common';
import { Redis } from 'ioredis';
import { Counter } from 'prom-client';

const decisions = new Counter({ name: 'rate_limit_decisions_total', help: 'Rate limiter decisions', labelNames: ['limiter', 'result'], registers: [registry] });

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * TOKEN BUCKET, executed atomically inside Redis.
 *
 * Each merchant owns a bucket holding up to `limit` tokens (so short bursts up to the per-window quota
 * are fine); it refills continuously at limit/window tokens per second; every request takes one token.
 * Empty bucket = 429 with the exact time until a token exists.
 *
 * Why a Lua script: refill + check + spend must be ONE atomic step. Done as separate Redis calls,
 * 50 concurrent requests could all read "1 token left" and all pass. Redis runs a script without
 * interleaving other commands. The script also uses Redis's own clock (TIME), so several payments
 * replicas with slightly different clocks still share one consistent bucket.
 */
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now_ms end
tokens = math.min(capacity, tokens + math.max(0, now_ms - ts) * refill_per_sec / 1000)
local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / refill_per_sec * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now_ms))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill_per_sec * 1000) + 1000)
return { allowed, math.floor(tokens), retry_ms }
`;

/** Counts events in a rolling-ish fixed window (INCR + EXPIRE): used to cap repeated failed logins. */
const COUNT_IN_WINDOW = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return { n, redis.call('TTL', KEYS[1]) }
`;

export interface RateLimiterOptions {
  redisUrl: string;
  /** Length of a quota window in seconds. `rate_limit_per_min` assumes 60; tests shorten it. */
  windowSeconds?: number;
  /** Failed API-key attempts allowed per client address per window before it is throttled. */
  maxFailedAuth?: number;
  log?: (msg: string) => void;
}

/**
 * Per-merchant API rate limiting + brute-force throttling, backed by Redis.
 *
 * FAILS OPEN: if Redis is slow or down the request is ALLOWED (and counted in a metric). A limiter is
 * a protective extra; making every payment depend on its availability would turn a cache outage into a
 * payments outage. Commands have a tiny timeout and no offline queue, so a dead Redis costs milliseconds.
 */
export class RateLimiter {
  private readonly redis: Redis;
  private readonly windowSeconds: number;
  private readonly maxFailedAuth: number;
  private lastErrorLog = 0;

  constructor(private readonly opts: RateLimiterOptions) {
    this.windowSeconds = opts.windowSeconds ?? 60;
    this.maxFailedAuth = opts.maxFailedAuth ?? 20;
    this.redis = new Redis(opts.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 0, // never retry a command: fail open instead
      enableOfflineQueue: false, // do not queue commands while disconnected
      connectTimeout: 1_000,
      commandTimeout: 250,
      retryStrategy: (times) => Math.min(2_000, times * 200), // keep reconnecting in the background
    });
    this.redis.on('error', (err) => this.logError(err));
  }

  private logError(err: unknown) {
    const now = Date.now();
    if (now - this.lastErrorLog > 10_000) {
      this.lastErrorLog = now;
      this.opts.log?.(`rate limiter redis problem (failing open): ${(err as Error).message}`);
    }
  }

  /** Take one token from the merchant's bucket. */
  async consume(merchantId: string, limitPerWindow: number): Promise<RateDecision> {
    const refillPerSec = limitPerWindow / this.windowSeconds;
    try {
      const [allowed, remaining, retryMs] = (await this.redis.eval(TOKEN_BUCKET, 1, `rl:m:${merchantId}`, limitPerWindow, refillPerSec, 1)) as [number, number, number];
      decisions.inc({ limiter: 'merchant', result: allowed ? 'allowed' : 'limited' });
      return { allowed: allowed === 1, limit: limitPerWindow, remaining, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    } catch (err) {
      decisions.inc({ limiter: 'merchant', result: 'error_allowed' });
      this.logError(err);
      return { allowed: true, limit: limitPerWindow, remaining: limitPerWindow, retryAfterSeconds: 0 };
    }
  }

  /** Record a failed API-key attempt from `client`. Returns true once the client should be throttled. */
  async recordFailedAuth(client: string): Promise<{ throttled: boolean; retryAfterSeconds: number }> {
    try {
      const [n, ttl] = (await this.redis.eval(COUNT_IN_WINDOW, 1, `rl:authfail:${client}`, this.windowSeconds)) as [number, number];
      const throttled = n > this.maxFailedAuth;
      decisions.inc({ limiter: 'auth_failures', result: throttled ? 'limited' : 'allowed' });
      return { throttled, retryAfterSeconds: Math.max(1, ttl) };
    } catch (err) {
      this.logError(err);
      return { throttled: false, retryAfterSeconds: 0 };
    }
  }

  /** Is this client already over the failed-auth budget? (checked BEFORE any database lookup) */
  async isThrottled(client: string): Promise<{ throttled: boolean; retryAfterSeconds: number }> {
    try {
      const raw = await this.redis.get(`rl:authfail:${client}`);
      if (raw && Number(raw) > this.maxFailedAuth) return { throttled: true, retryAfterSeconds: Math.max(1, await this.redis.ttl(`rl:authfail:${client}`)) };
    } catch (err) {
      this.logError(err);
    }
    return { throttled: false, retryAfterSeconds: 0 };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
