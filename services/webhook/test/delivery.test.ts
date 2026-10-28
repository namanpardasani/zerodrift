import { createServer } from 'node:http';
import { buildSignatureHeader } from '@zerodrift/webhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Env, startEnv } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env.close());
beforeEach(() => {
  env.receiver.received.length = 0;
  Object.assign(env.receiver.behavior, { failNext: 0, failStatus: 500, delayMs: 0 });
});

const delivery = async (m: { key: string }, id: string) => (await env.api(`/v1/webhook-deliveries/${id}`, { key: m.key })).body;
const onlyDelivery = async (eventId: string) => {
  const rows = await env.deliveryRows(eventId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe('delivery', () => {
  it('sends a signed webhook the receiver can verify, and logs the attempt', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    const eventId = await env.enqueue(m);
    await env.pump();

    expect(env.receiver.received).toHaveLength(1);
    const got = env.receiver.received[0]!;
    expect(got.outcome).toBe('ok'); // signature verified by the receiver
    expect(got.eventId).toBe(eventId);
    expect(got.body).toMatchObject({ id: eventId, type: 'payment.succeeded', data: { merchantId: m.id, amountMinor: '1000' } });

    const d = await delivery(m, (await onlyDelivery(eventId)).id);
    expect(d.status).toBe('succeeded');
    expect(d.attempts).toHaveLength(1);
    expect(d.attempts[0]).toMatchObject({ attemptNo: 1, responseCode: 200, error: null });
  });

  it('retries failures with backoff and finally succeeds; every attempt is in the log', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    env.receiver.behavior.failNext = 3;
    const eventId = await env.enqueue(m);
    await env.pump();

    const d = await delivery(m, (await onlyDelivery(eventId)).id);
    expect(d.status).toBe('succeeded');
    expect(d.attempts.map((a: { responseCode: number }) => a.responseCode)).toEqual([500, 500, 500, 200]);
    expect(d.attempts.map((a: { attemptNo: number }) => a.attemptNo)).toEqual([1, 2, 3, 4]);
  });

  it('after the max attempts the delivery is dead-lettered and stops being retried', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    env.receiver.behavior.failNext = 1_000;
    const eventId = await env.enqueue(m);
    await env.pump();

    const row = await onlyDelivery(eventId);
    expect(row.status).toBe('dead');
    expect(row.attempt_count).toBe(4); // maxAttempts in this test env
    const callsAfterDead = env.receiver.received.length;
    for (let i = 0; i < 5; i++) await env.webhook.worker.runOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(env.receiver.received.length).toBe(callsAfterDead); // nothing more is sent
  });

  it('manual replay of a dead delivery works after the merchant fixes their server; history is kept', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    env.receiver.behavior.failNext = 1_000;
    const eventId = await env.enqueue(m);
    await env.pump();
    const id = (await onlyDelivery(eventId)).id;
    expect((await delivery(m, id)).status).toBe('dead');

    env.receiver.behavior.failNext = 0; // merchant fixed their server
    const replayed = await env.api(`/v1/webhook-deliveries/${id}/replay`, { key: m.key, method: 'POST', body: {} });
    expect(replayed.status).toBe(200);
    await env.pump();

    const d = await delivery(m, id);
    expect(d.status).toBe('succeeded');
    expect(d.replayCount).toBe(1);
    expect(d.attempts.map((a: { attemptNo: number }) => a.attemptNo)).toEqual([1, 2, 3, 4, 5]); // old attempts preserved, numbering continues
    expect(d.attempts[4].responseCode).toBe(200);
  });

  it('replaying an entire event re-sends it to every endpoint', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    const eventId = await env.enqueue(m);
    await env.pump();
    env.receiver.received.length = 0;
    const r = await env.api(`/v1/webhook-events/${eventId}/replay`, { key: m.key, method: 'POST', body: {} });
    expect(r.status).toBe(200);
    expect(r.body.deliveries).toHaveLength(1);
    await env.pump();
    expect(env.receiver.received).toHaveLength(1);
    expect(env.receiver.received[0]!.outcome).toBe('duplicate'); // same event id: the receiver dedupes
  });

  it('a slow receiver counts as a timeout, which is retried', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    env.receiver.behavior.delayMs = 1_500; // longer than the 600ms attempt timeout
    const eventId = await env.enqueue(m);
    await env.webhook.worker.runOnce();
    const id = (await onlyDelivery(eventId)).id;
    const first = await delivery(m, id);
    expect(first.attempts[0].error).toBe('timeout');
    expect(first.status).toBe('pending');
    env.receiver.behavior.delayMs = 0;
    await env.pump();
    expect((await delivery(m, id)).status).toBe('succeeded');
  });

  it('a receiver that rejects the signature gets nothing through (401 is logged as a failed attempt)', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    env.receiver.secrets = ['whsec_somebody_elses'];
    const eventId = await env.enqueue(m);
    await env.pump();
    expect((await onlyDelivery(eventId)).status).toBe('dead');
    expect(env.receiver.received.every((r) => r.outcome === 'bad_signature')).toBe(true);
  });

  it('redirects are not followed (they could bounce the request to an internal address)', async () => {
    let hit = false;
    const target = createServer((_q, res) => {
      hit = true;
      res.end('internal');
    });
    await new Promise<void>((r) => target.listen(0, r));
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/secret`;
    const redirector = createServer((_q, res) => {
      res.writeHead(302, { location: targetUrl });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, r));
    try {
      const m = env.merchant();
      await env.createEndpoint(m, { url: `http://127.0.0.1:${(redirector.address() as { port: number }).port}/hook`, trust: false });
      const eventId = await env.enqueue(m);
      await env.webhook.worker.runOnce();
      const d = await delivery(m, (await onlyDelivery(eventId)).id);
      expect(d.attempts[0].responseCode).toBe(302);
      expect(d.status).toBe('pending'); // treated as a failure, will retry
      expect(hit).toBe(false);
    } finally {
      target.close();
      redirector.close();
    }
  });
});

describe('secrets', () => {
  it('rotation: old and new secrets both verify during the grace period, then only the new one', async () => {
    const m = env.merchant();
    const ep = await env.createEndpoint(m);
    const oldSecret = ep.secret;
    const rotated = await env.api(`/v1/webhook-endpoints/${ep.id}/rotate-secret`, { key: m.key, method: 'POST', body: {} });
    const newSecret = rotated.body.secret as string;
    expect(newSecret).not.toBe(oldSecret);

    env.receiver.secrets = [newSecret]; // receiver already switched
    let eventId = await env.enqueue(m);
    await env.pump();
    expect((await onlyDelivery(eventId)).status).toBe('succeeded');

    env.receiver.secrets = [oldSecret]; // receiver has NOT switched yet: still works during the overlap
    env.receiver.received.length = 0;
    eventId = await env.enqueue(m);
    await env.pump();
    expect((await onlyDelivery(eventId)).status).toBe('succeeded');

    // the grace period ends: the old secret stops signing
    await env.webhook.db.updateTable('webhook_endpoints').set({ previous_secret_expires_at: new Date(Date.now() - 1_000) }).where('id', '=', ep.id).execute();
    eventId = await env.enqueue(m);
    await env.pump();
    expect((await onlyDelivery(eventId)).status).toBe('dead'); // receiver still trusts only the old one
  });

  it('the secret is returned once, never again, and is stored encrypted', async () => {
    const m = env.merchant();
    const ep = await env.createEndpoint(m);
    expect(ep.secret).toMatch(/^whsec_/);
    const got = await env.api(`/v1/webhook-endpoints/${ep.id}`, { key: m.key });
    expect(got.body.secret).toBeUndefined();
    const list = await env.api('/v1/webhook-endpoints', { key: m.key });
    expect(JSON.stringify(list.body)).not.toContain(ep.secret);
    const row = await env.webhook.db.selectFrom('webhook_endpoints').select('secret_encrypted').where('id', '=', ep.id).executeTakeFirstOrThrow();
    expect(row.secret_encrypted).not.toContain(ep.secret);
  });
});

describe('planning deliveries', () => {
  it('honours event-type filters, skips inactive endpoints and endpoints created after the event', async () => {
    const m = env.merchant();
    const a = await env.createEndpoint(m, { eventTypes: ['payment.succeeded'] });
    const b = await env.createEndpoint(m, { eventTypes: ['refund.created'] });
    const c = await env.createEndpoint(m);
    await env.api(`/v1/webhook-endpoints/${c.id}`, { key: m.key, method: 'PATCH', body: { active: false } });

    const eventId = await env.enqueue(m, 'payment.succeeded');
    const rows = await env.deliveryRows(eventId);
    expect(rows.map((r) => r.endpoint_id)).toEqual([a.id]); // not b (other type), not c (inactive)
    expect(b.id).not.toBe(a.id);

    const oldEvent = await env.enqueue(m, 'payment.succeeded', new Date(Date.now() - 60_000)); // happened before the endpoints existed
    expect(await env.deliveryRows(oldEvent)).toHaveLength(0);
  });

  it('the same event planned twice (Kafka redelivery) still yields ONE delivery per endpoint', async () => {
    const m = env.merchant();
    await env.createEndpoint(m);
    const eventId = await env.enqueue(m);
    const row = await env.webhook.db.selectFrom('webhook_events').select('payload').where('event_id', '=', eventId).executeTakeFirstOrThrow();
    await env.webhook.db.transaction().execute((trx) => env.webhook.deliveries.enqueueForEvent(trx, row.payload as never, m.id));
    await env.webhook.db.transaction().execute((trx) => env.webhook.deliveries.enqueueForEvent(trx, row.payload as never, m.id));
    expect(await env.deliveryRows(eventId)).toHaveLength(1);
  });

  it('a disabled endpoint with pending deliveries dead-letters them as endpoint_disabled; re-enable + replay delivers', async () => {
    const m = env.merchant();
    const ep = await env.createEndpoint(m);
    const eventId = await env.enqueue(m);
    await env.api(`/v1/webhook-endpoints/${ep.id}`, { key: m.key, method: 'DELETE' });
    await env.pump();
    const id = (await onlyDelivery(eventId)).id;
    const d = await delivery(m, id);
    expect(d.status).toBe('dead');
    expect(d.attempts[0].error).toBe('endpoint_disabled');
    expect(env.receiver.received.filter((r) => r.eventId === eventId)).toHaveLength(0); // nothing was sent for it

    await env.api(`/v1/webhook-endpoints/${ep.id}`, { key: m.key, method: 'PATCH', body: { active: true } });
    await env.api(`/v1/webhook-deliveries/${id}/replay`, { key: m.key, method: 'POST', body: {} });
    await env.pump();
    expect((await delivery(m, id)).status).toBe('succeeded');
  });
});

describe('concurrency and crashes', () => {
  it('two workers on the same database never attempt the same delivery twice', async () => {
    const { startWebhook } = await import('../src/app.js');
    const second = await startWebhook({
      databaseUrl: env.databaseUrl,
      port: 0,
      logLevel: 'silent',
      startWorker: false,
      authenticator: { authenticate: async () => null },
      config: { ...env.webhook.config },
    });
    try {
      const m = env.merchant();
      await env.createEndpoint(m);
      const eventIds = new Set<string>();
      for (let i = 0; i < 30; i++) eventIds.add(await env.enqueue(m));
      for (let i = 0; i < 20; i++) await Promise.all([env.webhook.worker.runOnce(), second.worker.runOnce()]);
      await env.pump();
      // only look at THIS test's events (leftover retries from other tests may share the receiver)
      const mine = env.receiver.received.filter((r) => eventIds.has(r.eventId));
      expect(mine.filter((r) => r.outcome === 'ok')).toHaveLength(30);
      expect(mine).toHaveLength(30); // 30 attempts for 30 deliveries: nothing was sent twice
      const attemptKeys = mine.map((r) => `${r.deliveryId}#${r.attempt}`);
      expect(new Set(attemptKeys).size).toBe(attemptKeys.length); // no (delivery, attempt) seen twice
    } finally {
      await second.close();
    }
  });

  it('a worker that dies after claiming leaves the delivery recoverable once the lease expires', async () => {
    const short = await startEnv({ leaseSeconds: 1 });
    try {
      const m = short.merchant();
      await short.createEndpoint(m);
      const eventId = await short.enqueue(m);
      const claimed = await short.webhook.deliveries.claimDue(10); // claim... then "crash" before attempting
      expect(claimed).toHaveLength(1);
      expect(await short.webhook.deliveries.claimDue(10)).toHaveLength(0); // invisible while leased
      await new Promise((r) => setTimeout(r, 1_300));
      await short.pump(); // lease expired: it is picked up again and delivered
      expect((await short.deliveryRows(eventId))[0]!.status).toBe('succeeded');
      expect(short.receiver.received.filter((r) => r.outcome === 'ok')).toHaveLength(1);
    } finally {
      await short.close();
    }
  });
});

describe('API security', () => {
  it('requires a valid API key and isolates merchants from each other', async () => {
    const a = env.merchant('a');
    const b = env.merchant('b');
    const ep = await env.createEndpoint(a);
    const eventId = await env.enqueue(a);
    const dId = (await onlyDelivery(eventId)).id;

    expect((await env.api('/v1/webhook-endpoints')).status).toBe(401);
    expect((await env.api('/v1/webhook-endpoints', { key: 'nope' })).status).toBe(401);
    for (const [path, method] of [[`/v1/webhook-endpoints/${ep.id}`, 'GET'], [`/v1/webhook-deliveries/${dId}`, 'GET'], [`/v1/webhook-deliveries/${dId}/replay`, 'POST'], [`/v1/webhook-endpoints/${ep.id}/rotate-secret`, 'POST']] as const) {
      expect((await env.api(path, { key: b.key, method, body: method === 'POST' ? {} : undefined })).status, `${method} ${path}`).toBe(404);
    }
    expect((await env.api('/v1/webhook-deliveries', { key: b.key })).body.deliveries).toEqual([]);
    expect((await env.api(`/v1/webhook-endpoints/${ep.id}`, { key: b.key, method: 'PATCH', body: { active: false } })).status).toBe(404);
  });

  it('validates input and the admin API needs the admin token', async () => {
    const m = env.merchant();
    expect((await env.api('/v1/webhook-endpoints', { key: m.key, body: { url: 'not a url' } })).status).toBe(400);
    expect((await env.api('/v1/webhook-endpoints', { key: m.key, body: { url: 'ftp://x.example.com' } })).status).toBe(400);
    expect((await env.api('/v1/webhook-endpoints', { key: m.key, body: { url: 'https://x.example.com', eventTypes: ['Not Valid'] } })).status).toBe(400);
    expect((await fetch(`${env.webhook.url}/admin/webhook-stats`)).status).toBe(401);
    const ok = await fetch(`${env.webhook.url}/admin/webhook-stats`, { headers: { 'x-admin-token': env.webhook.config.adminToken } });
    expect(ok.status).toBe(200);
  });

  it('SSRF: private/loopback/metadata addresses are refused when private URLs are not allowed', async () => {
    const strict = await startEnv({ allowPrivateUrls: false });
    try {
      const m = strict.merchant();
      for (const url of ['http://127.0.0.1:9/hook', 'http://localhost/hook', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.7/x', 'http://[::1]/x']) {
        const r = await strict.api('/v1/webhook-endpoints', { key: m.key, body: { url } });
        expect(r.status, url).toBe(400);
        expect(r.body.error.code).toBe('url_not_allowed');
      }
    } finally {
      await strict.close();
    }
  });

  it('signature header on the wire matches the documented scheme', async () => {
    const m = env.merchant();
    const ep = await env.createEndpoint(m);
    let seen: string | undefined;
    let body = '';
    const probe = createServer((req, res) => {
      seen = String(req.headers['zerodrift-signature']);
      req.on('data', (c) => (body += c));
      req.on('end', () => res.end('ok'));
    });
    await new Promise<void>((r) => probe.listen(0, r));
    try {
      await env.api(`/v1/webhook-endpoints/${ep.id}`, { key: m.key, method: 'PATCH', body: { url: `http://127.0.0.1:${(probe.address() as { port: number }).port}/h` } });
      await env.enqueue(m);
      await env.pump();
      const t = Number(seen!.match(/t=(\d+)/)![1]);
      expect(seen).toBe(buildSignatureHeader([ep.secret], body, t)); // t=<ts>,v1=HMAC(secret, `${ts}.${rawBody}`)
    } finally {
      probe.close();
    }
  });
});
