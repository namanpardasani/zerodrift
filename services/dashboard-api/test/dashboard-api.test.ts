import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertProductionSafe, startDashboardApi, type RunningDashboardApi } from '../src/app.js';
import { DEV_DEFAULTS, type DashboardConfig } from '../src/config.js';

interface Fake {
  url: string;
  seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  server: Server;
  handler: (method: string, url: string, body: string) => { status: number; body?: unknown };
}
async function fake(handler: Fake['handler'] = () => ({ status: 200, body: {} })): Promise<Fake> {
  const f: Fake = { url: '', seen: [], server: undefined as never, handler };
  f.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      f.seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const r = f.handler(req.method!, req.url!, body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => f.server.listen(0, r));
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  return f;
}

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const ADMIN = 'upstream-admin-token';
let ledger: Fake, payments: Fake, webhook: Fake, recon: Fake, chaos: Fake, prom: Fake;
let api: RunningDashboardApi;
let staticDir: string;
let token: string;

const cfg = (over: Partial<DashboardConfig> = {}): DashboardConfig => ({
  jwtSecret: SECRET, tokenTtlSeconds: 3600, operatorUser: 'admin', operatorPassword: 'correct-horse', adminToken: ADMIN,
  upstreams: { ledger: ledger.url, payments: payments.url, webhook: webhook.url, reconciliation: recon.url, chaos: chaos.url, prometheus: prom.url },
  allowedOrigins: ['http://localhost:5173'], staticDir, loginMaxFailures: 5, loginWindowSeconds: 60, ...over,
});

beforeAll(async () => {
  [ledger, payments, webhook, recon, chaos, prom] = await Promise.all([fake(), fake(), fake(), fake(), fake(), fake()]);
  staticDir = mkdtempSync(join(tmpdir(), 'dash-'));
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>dash</title><div id=root></div>');
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  api = await startDashboardApi({ port: 0, config: cfg(), logLevel: 'silent' });
  token = (await login('admin', 'correct-horse')).body.token;
});
afterAll(async () => {
  await api.close();
  for (const f of [ledger, payments, webhook, recon, chaos, prom]) f.server.close();
  rmSync(staticDir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { token?: string | null; base?: string } = {}) =>
  fetch(`${init.base ?? api.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? token}` }), ...(init.headers as Record<string, string>) } }).then(async (r) => ({ status: r.status, headers: r.headers, body: r.status === 204 ? null : ((await r.json().catch(() => null)) as any) }));
const login = (username: string, password: string) => call('/auth/login', { method: 'POST', token: null, body: JSON.stringify({ username, password }) });
const lastSeen = (f: Fake) => f.seen[f.seen.length - 1]!;
const key = new TextEncoder().encode(SECRET);
const sign = (over: { secret?: Uint8Array; exp?: string | number; aud?: string; iss?: string; role?: string } = {}) =>
  new SignJWT({ role: over.role ?? 'operator' }).setProtectedHeader({ alg: 'HS256' }).setSubject('admin').setIssuer(over.iss ?? 'zerodrift-dashboard').setAudience(over.aud ?? 'zerodrift-dashboard').setIssuedAt().setExpirationTime(over.exp ?? '1h').sign(over.secret ?? key);

describe('authentication', () => {
  it('logs in with the right credentials and rejects wrong ones with one generic message', async () => {
    const ok = await login('admin', 'correct-horse');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ user: 'admin', expiresInSeconds: 3600 });
    expect(ok.body.token.split('.')).toHaveLength(3);
    const badPass = await login('admin', 'nope');
    const badUser = await login('root', 'correct-horse');
    expect(badPass.status).toBe(401);
    expect(badUser.status).toBe(401);
    expect(badUser.body.error.message).toBe(badPass.body.error.message); // does not reveal which part was wrong
    expect((await call('/auth/login', { method: 'POST', token: null, body: JSON.stringify({ username: 'admin' }) })).status).toBe(400);
  });

  it('every /api route requires a valid token', async () => {
    const routes = ['GET /api/overview', 'GET /api/accounts', 'GET /api/payments', 'GET /api/webhooks/deliveries', 'GET /api/recon/latest', 'GET /api/metrics/summary', 'GET /api/chaos/status', 'POST /api/chaos/load', 'POST /api/chaos/reset', 'POST /api/recovery/run', 'GET /auth/me'];
    for (const r of routes) {
      const [method, path] = r.split(' ') as [string, string];
      expect((await call(path, { method, token: null, body: method === 'POST' ? '{}' : undefined })).status, r).toBe(401);
      expect((await call(path, { method, token: 'garbage', body: method === 'POST' ? '{}' : undefined })).status, `${r} garbage`).toBe(401);
    }
    expect((await call('/auth/me')).body).toEqual({ user: 'admin' });
  });

  it('rejects expired, forged, wrong-audience, wrong-issuer, wrong-role and alg=none tokens', async () => {
    const bad: Record<string, string> = {
      expired: await sign({ exp: Math.floor(Date.now() / 1000) - 10 }),
      forged: await sign({ secret: new TextEncoder().encode('some-other-secret-that-is-also-32-chars!!') }),
      wrongAudience: await sign({ aud: 'someone-else' }),
      wrongIssuer: await sign({ iss: 'evil' }),
      wrongRole: await sign({ role: 'viewer' }),
      // alg: none, hand-built
      algNone: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'admin', role: 'operator', iss: 'zerodrift-dashboard', aud: 'zerodrift-dashboard', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.`,
    };
    for (const [name, t] of Object.entries(bad)) expect((await call('/api/overview', { token: t })).status, name).toBe(401);
    expect((await call('/api/accounts', { token: await sign() })).status).not.toBe(401); // a correctly signed one works
  });

  it('login is rate limited after repeated failures (and says when to retry)', async () => {
    const strict = await startDashboardApi({ port: 0, config: cfg({ loginMaxFailures: 3, loginWindowSeconds: 2, staticDir: undefined }), logLevel: 'silent' });
    try {
      for (let i = 0; i < 3; i++) expect((await call('/auth/login', { base: strict.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'wrong' }) })).status).toBe(401);
      const blocked = await call('/auth/login', { base: strict.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) });
      expect(blocked.status).toBe(429); // even the right password is refused while locked
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      await new Promise((r) => setTimeout(r, 2_200));
      expect((await call('/auth/login', { base: strict.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) })).status).toBe(200);
    } finally {
      await strict.close();
    }
  }, 20_000);

  it('refuses to start in production with development secrets', () => {
    expect(() => assertProductionSafe('production', cfg({ jwtSecret: DEV_DEFAULTS.jwtSecret }))).toThrow(/JWT_SECRET/);
    expect(() => assertProductionSafe('production', cfg({ operatorPassword: DEV_DEFAULTS.operatorPassword }))).toThrow(/DASHBOARD_PASSWORD/);
    expect(() => assertProductionSafe('production', cfg({ adminToken: DEV_DEFAULTS.adminToken }))).toThrow(/ADMIN_TOKEN/);
    expect(() => assertProductionSafe('production', cfg())).not.toThrow();
    expect(() => assertProductionSafe('development', cfg({ jwtSecret: DEV_DEFAULTS.jwtSecret }))).not.toThrow();
  });
});

describe('proxying to the services', () => {
  it('forwards allowed filters, drops unknown query params, and uses each service\'s own credentials', async () => {
    payments.handler = () => ({ status: 200, body: { payments: [] } });
    await call('/api/payments?status=failed&merchantId=m1&limit=5&evil=1&before=2026-01-01T00:00:00Z');
    const p = lastSeen(payments);
    expect(p.url).toBe('/admin/payments?status=failed&merchantId=m1&limit=5&before=2026-01-01T00%3A00%3A00Z');
    expect(p.headers['x-admin-token']).toBe(ADMIN);

    await call('/api/accounts?ownerType=customer&limit=3&drop=table');
    expect(lastSeen(ledger).url).toBe('/accounts?ownerType=customer&limit=3');
    expect(lastSeen(ledger).headers['x-admin-token']).toBeUndefined(); // the ledger gets no admin credential: it has no auth to give

    await call('/api/webhooks/deliveries?status=dead');
    expect(lastSeen(webhook).headers['x-admin-token']).toBe(ADMIN);
    await call('/api/recon/runs?kind=external');
    expect(lastSeen(recon).url).toBe('/v1/recon/runs?kind=external');
    expect(lastSeen(recon).headers['x-admin-token']).toBe(ADMIN);
    expect(lastSeen(payments).headers.authorization).toBeUndefined(); // the operator's JWT is never forwarded upstream
  });

  it('the ledger transaction feed defaults to newest-first', async () => {
    await call('/api/ledger/transactions?type=payment');
    expect(lastSeen(ledger).url).toContain('order=desc');
    expect(lastSeen(ledger).url).toContain('type=payment');
  });

  it('validates ids before calling upstream; passes through upstream 404s with the service message', async () => {
    const before = payments.seen.length;
    expect((await call('/api/payments/not-a-uuid')).status).toBe(400);
    expect(payments.seen.length).toBe(before); // nothing was sent
    payments.handler = () => ({ status: 404, body: { error: { code: 'not_found', message: 'Payment x not found' } } });
    const r = await call('/api/payments/00000000-0000-4000-8000-000000000000');
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe('Payment x not found');
  });

  it('an unreachable service becomes a 502 naming it, and the overview degrades instead of failing', async () => {
    const dead = await startDashboardApi({ port: 0, logLevel: 'silent', config: cfg({ upstreams: { ledger: 'http://127.0.0.1:9', payments: payments.url, webhook: webhook.url, reconciliation: recon.url, chaos: chaos.url, prometheus: prom.url }, staticDir: undefined }) });
    try {
      const t = (await call('/auth/login', { base: dead.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) })).body.token;
      const r = await call('/api/accounts', { base: dead.url, token: t });
      expect(r.status).toBe(502);
      expect(r.body.error).toMatchObject({ code: 'upstream_unavailable', details: { service: 'ledger' } });
      payments.handler = () => ({ status: 200, body: { byStatus: {} } });
      const ov = await call('/api/overview', { base: dead.url, token: t });
      expect(ov.status).toBe(200);
      expect(ov.body.services.find((s: { name: string }) => s.name === 'ledger')).toMatchObject({ up: false });
      expect(ov.body.ledgerInvariants).toBeNull();
    } finally {
      await dead.close();
    }
  });

  it('manual recon runs pass the upstream status through (409 when already running)', async () => {
    recon.handler = () => ({ status: 409, body: { error: { code: 'run_in_progress' } } });
    const r = await call('/api/recon/runs', { method: 'POST', body: JSON.stringify({ kind: 'internal' }) });
    expect(r.status).toBe(409);
    expect((await call('/api/recon/runs', { method: 'POST', body: JSON.stringify({ kind: 'bogus' }) })).status).toBe(400);
  });
});

describe('metrics (fixed queries only)', () => {
  it('summarises Prometheus instant queries and exposes range queries only by name', async () => {
    prom.handler = (_m, url) => ({ status: 200, body: { status: 'success', data: { result: url.includes('query_range') ? [{ metric: {}, values: [[1, '2'], [2, '3']] }] : [{ metric: { to: 'succeeded' }, value: [1, '7'] }] } } });
    const s = await call('/api/metrics/summary');
    expect(s.body.available).toBe(true);
    expect(s.body.series.paymentsByStatus).toEqual([{ labels: { to: 'succeeded' }, value: 7 }]);
    const r = await call('/api/metrics/range/throughput?minutes=5');
    expect(r.body.series[0].points).toEqual([{ t: 1, v: 2 }, { t: 2, v: 3 }]);
    expect((await call('/api/metrics/range/up%7Bx%7D')).status).toBe(404); // arbitrary PromQL is not accepted
    const queries = prom.seen.map((x) => new URL(x.url, 'http://x').searchParams.get('query'));
    expect(queries.every((q) => q === null || /^[a-z_0-9(){}=",.~\[\]\s]+|up|sum|max/.test(q))).toBe(true);
  });

  it('reports "unavailable" instead of failing when Prometheus is down', async () => {
    const noProm = await startDashboardApi({ port: 0, logLevel: 'silent', config: cfg({ upstreams: { ledger: ledger.url, payments: payments.url, webhook: webhook.url, reconciliation: recon.url, chaos: chaos.url, prometheus: 'http://127.0.0.1:9' }, staticDir: undefined }) });
    try {
      const t = (await call('/auth/login', { base: noProm.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) })).body.token;
      const s = await call('/api/metrics/summary', { base: noProm.url, token: t });
      expect(s.status).toBe(200);
      expect(s.body.available).toBe(false);
    } finally {
      await noProm.close();
    }
  });
});

describe('a dead dependency must not slow the others down', () => {
  it('Upstream fails fast for a short while after a connection failure, then tries again', async () => {
    const { Upstream } = await import('../src/upstream.js');
    const dead = new Upstream('thing', 'http://127.0.0.1:9', {}, 2_000, 300);
    await expect(dead.request('GET', '/x')).rejects.toMatchObject({ code: 'upstream_unavailable' });
    const t = Date.now();
    await expect(dead.request('GET', '/x')).rejects.toMatchObject({ message: expect.stringContaining('failing fast') });
    expect(Date.now() - t).toBeLessThan(50); // answered instantly, no connection attempt
    await new Promise((r) => setTimeout(r, 350));
    await expect(dead.request('GET', '/x')).rejects.toMatchObject({ message: expect.not.stringContaining('failing fast') }); // window over: a real attempt again
  });

  it('metrics: when Prometheus is down it is queried once per window, not on every poll', async () => {
    prom.seen.length = 0;
    prom.handler = () => ({ status: 503, body: {} });
    const fresh = await startDashboardApi({ port: 0, logLevel: 'silent', config: cfg({ staticDir: undefined }) });
    try {
      const t = (await call('/auth/login', { base: fresh.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) })).body.token;
      expect((await call('/api/metrics/summary', { base: fresh.url, token: t })).body.available).toBe(false);
      const firstRound = prom.seen.length;
      expect(firstRound).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) await call('/api/metrics/summary', { base: fresh.url, token: t });
      await call('/api/metrics/range/throughput', { base: fresh.url, token: t });
      expect(prom.seen.length).toBeLessThanOrEqual(firstRound + 11); // no new storm: at most the in-flight first round
      expect(prom.seen.length).toBeLessThan(firstRound * 2);
    } finally {
      await fresh.close();
      prom.handler = () => ({ status: 200, body: {} });
    }
  });

  it('metrics: results are cached for a few seconds so several open pages share one round of queries', async () => {
    prom.handler = () => ({ status: 200, body: { status: 'success', data: { result: [] } } });
    const fresh = await startDashboardApi({ port: 0, logLevel: 'silent', config: cfg({ staticDir: undefined }) });
    try {
      const t = (await call('/auth/login', { base: fresh.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) })).body.token;
      prom.seen.length = 0;
      await call('/api/metrics/summary', { base: fresh.url, token: t });
      const one = prom.seen.length;
      await call('/api/metrics/summary', { base: fresh.url, token: t });
      await call('/api/metrics/summary', { base: fresh.url, token: t });
      expect(prom.seen.length).toBe(one);
    } finally {
      await fresh.close();
    }
  });
});

describe('chaos panel backend', () => {
  it('reports chaos as disabled when the controller says 404 (production-like), otherwise passes calls through', async () => {
    chaos.handler = () => ({ status: 404, body: { message: 'Not Found' } });
    expect((await call('/api/chaos/status')).body).toEqual({ enabled: false });
    // an UNREACHABLE controller is an error, not "disabled"
    const down = await startDashboardApi({ port: 0, logLevel: 'silent', config: cfg({ upstreams: { ledger: ledger.url, payments: payments.url, webhook: webhook.url, reconciliation: recon.url, chaos: 'http://127.0.0.1:9', prometheus: prom.url }, staticDir: undefined }) });
    try {
      const t = (await call('/auth/login', { base: down.url, method: 'POST', token: null, body: JSON.stringify({ username: 'admin', password: 'correct-horse' }) })).body.token;
      const r = await call('/api/chaos/status', { base: down.url, token: t });
      expect(r.status).toBe(502);
      expect(r.body.error.details.service).toBe('chaos-controller');
    } finally {
      await down.close();
    }
    chaos.handler = (m, url) => ({ status: 200, body: { enabled: true, echo: `${m} ${url}` } });
    expect((await call('/api/chaos/status')).body.enabled).toBe(true);
    const kill = await call('/api/chaos/services/payments/kill', { method: 'POST', body: '{}' });
    expect(kill.status).toBe(200);
    expect(lastSeen(chaos)).toMatchObject({ method: 'POST', url: '/chaos/services/payments/kill' });
    expect(lastSeen(chaos).headers['x-admin-token']).toBe(ADMIN);
    chaos.handler = () => ({ status: 403, body: { error: { code: 'target_not_allowed' } } });
    expect((await call('/api/chaos/services/postgres/kill', { method: 'POST', body: '{}' })).status).toBe(403); // controller's refusal is surfaced
  });

  it('the load generator sends the requested payments plus deliberate duplicates with the SAME idempotency key', async () => {
    payments.seen.length = 0;
    payments.handler = (method, url, body) => {
      if (url === '/admin/merchants') return { status: 201, body: { apiKey: 'zd_live_test', id: 'm1' } };
      if (url.includes('/topups')) return { status: 201, body: {} };
      if (url === '/v1/payments' && method === 'POST') {
        const { customerId } = JSON.parse(body);
        return { status: 201, body: { id: `pay-${customerId}-${payments.seen.length}`, status: 'succeeded' } };
      }
      return { status: 404 };
    };
    const r = await call('/api/chaos/load', { method: 'POST', body: JSON.stringify({ count: 20, concurrency: 4, duplicateRate: 0.5, customers: 3 }) });
    expect(r.status).toBe(200);
    const posts = payments.seen.filter((s) => s.url === '/v1/payments');
    const keys = posts.map((p) => p.headers['idempotency-key'] as string);
    expect(new Set(keys).size).toBe(20); // 20 distinct logical payments...
    expect(posts.length).toBe(20 + r.body.duplicatesSent); // ...plus the duplicates, which reuse keys
    expect(r.body.duplicatesSent).toBeGreaterThan(0);
    expect(posts.every((p) => p.headers.authorization === 'Bearer zd_live_test')).toBe(true);
    expect(payments.seen.filter((s) => s.url === '/admin/merchants')).toHaveLength(1);
    expect((await call('/api/chaos/load/last')).body.last.runId).toBe(r.body.runId);
    expect((await call('/api/chaos/load', { method: 'POST', body: JSON.stringify({ count: 100000 }) })).status).toBe(400); // bounded
  });

  it('refuses a second load run while one is in progress', async () => {
    payments.handler = (method, url) => {
      if (url === '/v1/payments' && method === 'POST') {
        const until = Date.now() + 200;
        while (Date.now() < until) { /* hold the response a moment: busy-wait is fine in a fake */ }
        return { status: 201, body: { id: `x-${Math.random()}`, status: 'succeeded' } };
      }
      return { status: 201, body: { apiKey: 'k' } };
    };
    const first = call('/api/chaos/load', { method: 'POST', body: JSON.stringify({ count: 3, concurrency: 1, duplicateRate: 0 }) });
    await new Promise((r) => setTimeout(r, 150));
    expect((await call('/api/chaos/load', { method: 'POST', body: '{}' })).status).toBe(409);
    expect((await first).status).toBe(200);
  });
});

describe('serving the app', () => {
  it('serves index.html at / and for client-side routes, but never swallows API/auth paths', async () => {
    const root = await fetch(`${api.url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<div id=root>');
    expect(await (await fetch(`${api.url}/payments/abc`)).text()).toContain('<div id=root>'); // SPA route
    expect((await fetch(`${api.url}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`${api.url}/assets/missing.js`)).status).toBe(404); // missing assets are real 404s, not index.html
    expect((await fetch(`${api.url}/api/overview`)).status).toBe(401);
    expect((await fetch(`${api.url}/health`)).status).toBe(200);
  });

  it('sets security headers and honours CORS only for allowed origins', async () => {
    const r = await fetch(`${api.url}/`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('x-powered-by')).toBeNull();
    const ok = await fetch(`${api.url}/auth/login`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const evil = await fetch(`${api.url}/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});
