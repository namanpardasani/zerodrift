import { inject } from '@zerodrift/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './harness.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack({ redisUrl: inject('redisUrl'), rateWindowSeconds: 2, rateMaxFailedAuth: 5 });
});
afterAll(() => s.close());

const get = (m: { apiKey: string }, path = '/v1/me') => s.api(path, { key: m.apiKey });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-merchant rate limiting (token bucket in Redis)', () => {
  it('tells every caller their quota in X-RateLimit headers, counting down', async () => {
    const m = await s.newMerchant('quota', 250, 5);
    const first = await get(m);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('5');
    expect(Number(first.headers.get('x-ratelimit-remaining'))).toBe(4);
    const second = await get(m);
    expect(Number(second.headers.get('x-ratelimit-remaining'))).toBe(3);
  });

  it('refuses a merchant that exceeds its quota (429 + Retry-After) without affecting other merchants', async () => {
    const noisy = await s.newMerchant('noisy', 250, 3);
    const quiet = await s.newMerchant('quiet', 250, 3);
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await get(noisy)).status);
    expect(results.slice(0, 3)).toEqual([200, 200, 200]);
    expect(results.slice(3)).toEqual([429, 429]);
    const blocked = await get(noisy);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await get(quiet)).status).toBe(200); // isolation: someone else's flood does not touch me
  });

  it('refills over time: after waiting, the merchant can call again', async () => {
    const m = await s.newMerchant('refill', 250, 4); // 4 per 2s window = 2 tokens/second
    for (let i = 0; i < 4; i++) await get(m);
    expect((await get(m)).status).toBe(429);
    await sleep(900); // ~1.8 tokens back
    expect((await get(m)).status).toBe(200);
  });

  it('is atomic: 50 concurrent requests against a quota of 10 let EXACTLY 10 through', async () => {
    const long = await startStack({ redisUrl: inject('redisUrl'), rateWindowSeconds: 3_600 }); // refill is negligible during the test
    try {
      const m = await long.newMerchant('burst', 250, 10);
      const statuses = await Promise.all(Array.from({ length: 50 }, () => long.api('/v1/me', { key: m.apiKey }).then((r) => r.status)));
      expect(statuses.filter((x) => x === 200)).toHaveLength(10);
      expect(statuses.filter((x) => x === 429)).toHaveLength(40);
    } finally {
      await long.close();
    }
  });

  it('the quota is shared across replicas: two payments instances on one Redis together allow exactly the limit', async () => {
    const { startPayments } = await import('../src/app.js');
    const a = await startStack({ redisUrl: inject('redisUrl'), rateWindowSeconds: 3_600 });
    // a second payments process (own database copy of the merchant) sharing the SAME Redis
    const b = await startPayments({
      databaseUrl: (await import('@zerodrift/testing').then((m) => m.createTestDatabase())).url,
      port: 0, ledgerUrl: a.ledger.url, gatewayUrl: a.gateway.url, recoveryScheduler: false, logLevel: 'silent',
      redisUrl: inject('redisUrl'), rateWindowSeconds: 3_600,
    });
    try {
      // make the merchant known to BOTH instances by registering the same key hash in b's database
      const m = await a.newMerchant('shared', 250, 10);
      const row = await a.payments.db.selectFrom('merchants').selectAll().where('id', '=', m.id).executeTakeFirstOrThrow();
      await b.db.insertInto('merchants').values({ id: row.id, name: row.name, api_key_hash: row.api_key_hash, api_key_prefix: row.api_key_prefix, rate_limit_per_min: row.rate_limit_per_min, fee_bps: row.fee_bps, ledger_account_id: row.ledger_account_id }).execute();
      const hit = (base: string) => fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${m.apiKey}` } }).then((r) => r.status);
      const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) => hit(i % 2 ? a.payments.url : b.url)));
      expect(statuses.filter((x) => x === 200)).toHaveLength(10); // one bucket, however the requests are spread
    } finally {
      await b.close();
      await a.close();
    }
  });
});

describe('failure behaviour', () => {
  it('FAILS OPEN: if Redis is unreachable requests are still served (and quickly)', async () => {
    const broken = await startStack({ redisUrl: 'redis://127.0.0.1:1', rateWindowSeconds: 2 });
    try {
      const m = await broken.newMerchant('open', 250, 1); // a quota of 1 would block the 2nd call if the limiter worked
      const t0 = Date.now();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await broken.api('/v1/me', { key: m.apiKey })).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200]);
      expect(Date.now() - t0).toBeLessThan(3_000); // a dead Redis must not add seconds of latency
    } finally {
      await broken.close();
    }
  });

  it('works without any Redis configured (limiter simply disabled)', async () => {
    const none = await startStack();
    try {
      for (let i = 0; i < 3; i++) expect((await none.api('/v1/me', { key: none.merchant.apiKey })).status).toBe(200);
      expect((await none.api('/v1/me', { key: none.merchant.apiKey })).headers.get('x-ratelimit-limit')).toBeNull();
    } finally {
      await none.close();
    }
  });
});

describe('brute-force throttling of bad API keys', () => {
  it('after repeated failures from one address further attempts get 429 BEFORE any key lookup, and it recovers after the window', async () => {
    const t = await startStack({ redisUrl: inject('redisUrl'), rateWindowSeconds: 2, rateMaxFailedAuth: 5 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 9; i++) codes.push((await t.api('/v1/me', { key: `zd_live_guess${i}` })).status);
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
      // documented trade-off: while an address is throttled, even its valid requests wait out the window
      expect((await t.api('/v1/me', { key: t.merchant.apiKey })).status).toBe(429);
      await sleep(2_300);
      expect((await t.api('/v1/me', { key: t.merchant.apiKey })).status).toBe(200);
    } finally {
      await t.close();
    }
  }, 30_000);
});
