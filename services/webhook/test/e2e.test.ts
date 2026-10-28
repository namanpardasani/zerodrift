import { randomBytes, randomUUID } from 'node:crypto';
import { startLedger, type RunningLedger } from '@zerodrift/ledger/app';
import { startGateway, type RunningGateway } from '@zerodrift/mock-gateway/app';
import { startPayments, type RunningPayments } from '@zerodrift/payments/app';
import { startReceiver, type Receiver } from '@zerodrift/demo-receiver/app';
import { TOPICS } from '@zerodrift/config';
import { createKafka, createProducer } from '@zerodrift/kafka';
import { createTestDatabase, inject, waitFor } from '@zerodrift/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebhook, type RunningWebhook } from '../src/app.js';
import { PaymentsAuthenticator } from '../src/auth.js';

/**
 * Whole pipeline, all real except the merchant's server being our demo receiver:
 *   payments saga -> outbox -> Kafka -> webhook consumer (inbox) -> delivery rows -> signed HTTP -> receiver
 */
let ledger: RunningLedger;
let gateway: RunningGateway;
let payments: RunningPayments;
let webhook: RunningWebhook;
let receiver: Receiver;
let merchant: { id: string; apiKey: string };

const brokers = () => [inject('kafkaBrokers')];
const uid = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  const [l, g, p, w] = await Promise.all([createTestDatabase(), createTestDatabase(), createTestDatabase(), createTestDatabase()]);
  ledger = await startLedger({ databaseUrl: l.url, port: 0, holdSweepIntervalSeconds: 0, logLevel: 'silent', kafkaBrokers: brokers() });
  gateway = await startGateway({ databaseUrl: g.url, port: 0, logLevel: 'silent' });
  payments = await startPayments({
    databaseUrl: p.url, port: 0, ledgerUrl: ledger.url, gatewayUrl: gateway.url, recoveryScheduler: false, logLevel: 'silent', kafkaBrokers: brokers(),
    ledgerTimeoutMs: 3_000,
    config: { recoveryStuckAfterSeconds: 0, leaseSeconds: 5 },
    gatewayClient: { timeoutMs: 1_000, retries: 1, retryBaseMs: 10, breaker: { resetTimeoutMs: 400, volumeThreshold: 6 } },
  });
  receiver = await startReceiver({ secrets: [] });
  webhook = await startWebhook({
    databaseUrl: w.url, port: 0, logLevel: 'silent',
    authenticator: new PaymentsAuthenticator(payments.url),
    kafkaBrokers: brokers(),
    config: { encryptionKey: randomBytes(32), allowPrivateUrls: true, backoffBaseMs: 30, backoffMaxMs: 200, backoffMinMs: 5, timeoutMs: 800, maxAttempts: 6, pollIntervalMs: 50 },
  });
  const r = await fetch(`${payments.url}/admin/merchants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': payments.config.adminToken }, body: JSON.stringify({ name: 'e2e shop' }) });
  merchant = (await r.json()) as { id: string; apiKey: string };

  const ep = await fetch(`${webhook.url}/v1/webhook-endpoints`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchant.apiKey}` }, body: JSON.stringify({ url: `${receiver.url}/webhooks` }) });
  expect(ep.status).toBe(201);
  receiver.secrets = [((await ep.json()) as { secret: string }).secret];
  await new Promise((r2) => setTimeout(r2, 1_500)); // let the consumer join its group
});
afterAll(async () => {
  await webhook.close();
  await receiver.close();
  await payments.close();
  await gateway.close();
  await ledger.close();
});

const paymentsApi = (path: string, body?: unknown, idem?: string) =>
  fetch(`${payments.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchant.apiKey}`, ...(idem ? { 'idempotency-key': idem } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

async function funded(amount = 50_000) {
  const id = `cust-${uid()}`;
  await paymentsApi(`/v1/customers/${id}/topups`, { amountMinor: String(amount) }, `tu-${uid()}`);
  return id;
}
const pay = (customerId: string, amount: number) => paymentsApi('/v1/payments', { customerId, amountMinor: String(amount) }, `pay-${uid()}`);
const okFor = (paymentId: string, type: string) => receiver.received.filter((r) => r.outcome === 'ok' && r.type === type && (r.body as any)?.data?.paymentId === paymentId);

describe('payments -> Kafka -> webhooks -> merchant', () => {
  it('a successful payment is delivered as payment.created and payment.succeeded, signed and verified', async () => {
    const p = (await pay(await funded(), 3_300)).body;
    expect(p.status).toBe('succeeded');
    await waitFor(async () => (okFor(p.id, 'payment.created').length === 1 && okFor(p.id, 'payment.succeeded').length === 1 ? true : false), 20_000);
    const got = okFor(p.id, 'payment.succeeded')[0]!;
    expect(got.body).toMatchObject({ type: 'payment.succeeded', data: { paymentId: p.id, merchantId: merchant.id, amountMinor: '3300', currency: 'INR' } });
    // and the delivery log says so
    const log = await fetch(`${webhook.url}/v1/webhook-deliveries?limit=100`, { headers: { authorization: `Bearer ${merchant.apiKey}` } }).then((r) => r.json() as Promise<any>);
    const mine = log.deliveries.filter((d: { eventType: string; eventId: string }) => d.eventId === got.eventId);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('succeeded');
  });

  it('a flaky merchant server still gets every event, exactly once as far as it can tell', async () => {
    receiver.behavior.failNext = 5; // the first 5 requests fail with 500
    const p = (await pay(await funded(), 1_100)).body;
    await waitFor(async () => (okFor(p.id, 'payment.created').length === 1 && okFor(p.id, 'payment.succeeded').length === 1 ? true : false), 30_000);
    receiver.behavior.failNext = 0;
    await new Promise((r) => setTimeout(r, 500));
    expect(okFor(p.id, 'payment.created')).toHaveLength(1);
    expect(okFor(p.id, 'payment.succeeded')).toHaveLength(1);
  });

  it('CHAOS: lost bank response + duplicate callbacks + repeated recovery => the merchant receives payment.succeeded exactly once', async () => {
    gateway.faults.set({ lostResponseRate: 1, duplicateCallbackRate: 1 });
    const p = (await pay(await funded(), 2_200)).body;
    expect(p.status).toBe('processing');
    gateway.faults.reset();
    await waitFor(async () => (okFor(p.id, 'payment.succeeded').length === 1 ? true : false), 30_000);
    for (let i = 0; i < 3; i++) {
      await fetch(`${payments.url}/internal/recovery/run`, { method: 'POST', headers: { 'x-admin-token': payments.config.adminToken } });
    }
    await new Promise((r) => setTimeout(r, 1_500));
    const all = receiver.received.filter((r) => (r.body as any)?.data?.paymentId === p.id);
    expect(all.filter((r) => r.type === 'payment.succeeded' && r.outcome === 'ok')).toHaveLength(1);
    expect(all.filter((r) => r.type === 'payment.created' && r.outcome === 'ok')).toHaveLength(1);
    expect(all.filter((r) => r.outcome === 'duplicate')).toHaveLength(0); // not even a duplicate reached the merchant
  });

  it('INVARIANT: every succeeded payment has exactly one delivery per event, each succeeded or dead-lettered', async () => {
    const c = await funded(200_000);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await pay(c, 500 + i)).body.id);

    // wait until the webhook service has seen all six payment.succeeded events and nothing is pending
    const succeededEvents = async () =>
      (await webhook.db.selectFrom('webhook_events').select(['event_id', 'payload']).where('merchant_id', '=', merchant.id).where('event_type', '=', 'payment.succeeded').execute()).map((e) => ({
        eventId: e.event_id,
        paymentId: (e.payload as { aggregateId: string }).aggregateId,
      }));
    await waitFor(async () => {
      const have = new Set((await succeededEvents()).map((e) => e.paymentId));
      const pending = await webhook.db.selectFrom('webhook_deliveries').select('id').where('status', '=', 'pending').execute();
      return ids.every((id) => have.has(id)) && pending.length === 0;
    }, 30_000);

    const events = await succeededEvents();
    for (const id of ids) {
      const mine = events.filter((e) => e.paymentId === id);
      expect(mine, `payment ${id}`).toHaveLength(1); // one event per succeeded payment
      const deliveries = await webhook.db.selectFrom('webhook_deliveries').select('status').where('event_id', '=', mine[0]!.eventId).execute();
      expect(deliveries).toHaveLength(1); // one endpoint => exactly one delivery row
      expect(['succeeded', 'dead']).toContain(deliveries[0]!.status); // delivered or dead-lettered, never lost or stuck
    }
  });

  it('a duplicate of the same Kafka event (broker redelivery / publisher resend) produces no second delivery', async () => {
    const p = (await pay(await funded(), 900)).body;
    await waitFor(async () => (okFor(p.id, 'payment.succeeded').length === 1 ? true : false), 20_000);
    const stored = await webhook.db.selectFrom('webhook_events').select('payload').where('event_type', '=', 'payment.succeeded').execute();
    const env = stored.map((s) => s.payload as { aggregateId: string; eventId: string }).find((e) => e.aggregateId === p.id)!;

    const producer = await createProducer(createKafka({ brokers: brokers(), clientId: 'dup-injector' }));
    try {
      for (let i = 0; i < 3; i++) await producer.send({ topic: TOPICS.payments, messages: [{ key: env.aggregateId, value: JSON.stringify(env), headers: { 'event-id': env.eventId } }] });
    } finally {
      await producer.disconnect();
    }
    await new Promise((r) => setTimeout(r, 2_500));
    const deliveries = await webhook.db.selectFrom('webhook_deliveries').select('id').where('event_id', '=', env.eventId).execute();
    expect(deliveries).toHaveLength(1);
    expect(okFor(p.id, 'payment.succeeded')).toHaveLength(1);
  });
});
