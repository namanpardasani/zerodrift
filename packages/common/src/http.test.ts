import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { acceptCorrelationId, correlationHeaders, createHealthModule, createLogger, getCorrelationId, registry, requestMiddleware, securityHeaders } from './index.js';

const lines: Record<string, unknown>[] = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
    cb();
  },
});

@Controller()
class TestController {
  @Get('echo/:id')
  echo(@Param('id') id: string, @Query('secret') _q?: string) {
    // reads the correlation id from async context, several awaits deep, as real service code does
    return Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { id, correlationId: getCorrelationId(), outgoing: correlationHeaders() };
    });
  }

  @Get('boom')
  boom() {
    throw new Error('kaboom');
  }
}

@Module({ imports: [createHealthModule('t')], controllers: [TestController] })
class AppModule {}

let app: Awaited<ReturnType<typeof NestFactory.create>>;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.use(securityHeaders);
  app.use(requestMiddleware(createLogger('test-svc', 'info', sink)));
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(() => app.close());

describe('correlation id', () => {
  it('mints one when absent, echoes it back, and makes it visible deep inside the handler and on outgoing calls', async () => {
    const res = await fetch(`${base}/echo/1`);
    const id = res.headers.get('x-correlation-id')!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const body = await res.json();
    expect(body.correlationId).toBe(id);
    expect(body.outgoing).toEqual({ 'x-correlation-id': id }); // what an HTTP client would forward
  });

  it('reuses a safe caller-supplied id so one id follows a request across services', async () => {
    const res = await fetch(`${base}/echo/2`, { headers: { 'x-correlation-id': 'order-42:retry.1' } });
    expect(res.headers.get('x-correlation-id')).toBe('order-42:retry.1');
    expect((await res.json()).correlationId).toBe('order-42:retry.1');
  });

  it('REPLACES an unsafe id (log/header injection attempt, too long, odd characters)', () => {
    for (const bad of ['a\nb', 'x'.repeat(101), 'has space', '<script>', '', 'a;b']) {
      const id = acceptCorrelationId(bad);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(acceptCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(acceptCorrelationId(['array'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('concurrent requests never see each other\'s ids', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`${base}/echo/${i}`, { headers: { 'x-correlation-id': `req-${i}` } }).then((r) => r.json())));
    for (const [i, r] of results.entries()) expect(r.correlationId).toBe(`req-${i}`);
  });

  it('outside any request there is no id and no header', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(correlationHeaders()).toEqual({});
  });
});

describe('request logging', () => {
  it('writes one structured line per request with the correlation id, route PATTERN and status; never the query string or secrets', async () => {
    lines.length = 0;
    await fetch(`${base}/echo/77?secret=hunter2&card=4111111111111111`, { headers: { authorization: 'Bearer zd_live_supersecret', 'x-correlation-id': 'trace-me' } });
    await new Promise((r) => setTimeout(r, 30));
    const line = lines.find((l) => l.msg === 'request' && l.correlationId === 'trace-me')!;
    expect(line).toMatchObject({ service: 'test-svc', method: 'GET', route: '/echo/:id', status: 200, level: 30 });
    expect(typeof line.durationMs).toBe('number');
    const raw = JSON.stringify(lines);
    for (const leaked of ['hunter2', '4111111111111111', 'zd_live_supersecret', 'secret=']) expect(raw).not.toContain(leaked);
  });

  it('logs server errors at error level and client errors at warn; health/metrics stay quiet', async () => {
    lines.length = 0;
    await fetch(`${base}/boom`);
    await fetch(`${base}/nope`);
    await fetch(`${base}/health`);
    await fetch(`${base}/metrics`);
    await new Promise((r) => setTimeout(r, 30));
    const reqs = lines.filter((l) => l.msg === 'request');
    expect(reqs.find((l) => l.status === 500)).toMatchObject({ level: 50 });
    expect(reqs.find((l) => l.status === 404)).toMatchObject({ level: 40, route: 'unmatched' });
    expect(reqs.some((l) => l.route === '/health' || l.route === '/metrics')).toBe(false);
  });
});

describe('metrics', () => {
  it('records a latency histogram and request counter per route, with status', async () => {
    await fetch(`${base}/echo/9`);
    const text = await registry.metrics();
    expect(text).toMatch(/http_request_duration_seconds_bucket\{[^}]*route="\/echo\/:id"[^}]*status="200"/);
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/echo\/:id"/);
    expect(text).toMatch(/http_requests_total\{[^}]*route="\/echo\/:id"/);
    expect(text).not.toContain('route="/echo/9"'); // route PATTERN, so label cardinality stays bounded
  });
});

describe('hardening', () => {
  it('sets security headers, hides the framework, and forbids caching of API responses', async () => {
    const res = await fetch(`${base}/echo/3`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('log redaction', () => {
  it('replaces credentials wherever they appear in a log object', () => {
    const out: Record<string, any>[] = [];
    const log = createLogger('svc', 'info', new Writable({ write(c, _e, cb) { out.push(JSON.parse(c.toString())); cb(); } }));
    log.info({ authorization: 'Bearer abc', password: 'p', nested: { apiKey: 'k', secret: 's', token: 't', signature: 'sig' }, req: { headers: { authorization: 'Bearer z', 'x-api-key': 'key', 'x-admin-token': 'adm' } }, headers: { 'zerodrift-signature': 't=1,v1=ab' }, ok: 'visible' }, 'hello');
    const raw = JSON.stringify(out[0]);
    for (const leaked of ['Bearer abc', '"p"', '"k"', '"s"', '"t"', '"sig"', 'Bearer z', '"key"', '"adm"', 'v1=ab']) expect(raw).not.toContain(leaked);
    expect(out[0]!.ok).toBe('visible');
    expect(raw).toContain('[REDACTED]');
  });
});
