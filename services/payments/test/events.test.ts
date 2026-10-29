import { randomUUID } from 'node:crypto';
import { TOPICS, TOPIC_SPECS } from '@zerodrift/config';
import { type EventEnvelope, parseEvent } from '@zerodrift/events';
import { createKafka, ensureTopics, startOutboxRelay } from '@zerodrift/kafka';
import { inject, waitFor } from '@zerodrift/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './harness.js';

let s: Stack;
let M: Stack['merchant'];
const seen: { topic: string; partition: number; key: string; eventId: string; envelope: EventEnvelope }[] = [];
let stopCollector: () => Promise<void>;

beforeAll(async () => {
  const brokers = [inject('kafkaBrokers')];
  const kafka = createKafka({ brokers, clientId: 'events-test' });
  await ensureTopics(kafka, TOPIC_SPECS);

  // one collector for the whole file: records every event on both topics
  const consumer = kafka.consumer({ kafkaJS: { groupId: `collector-${randomUUID()}`, fromBeginning: true, autoCommit: true } });
  await consumer.connect();
  await consumer.subscribe({ topics: [TOPICS.payments, TOPICS.ledger] });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const envelope = JSON.parse(message.value!.toString()) as EventEnvelope;
      seen.push({ topic, partition, key: message.key!.toString(), eventId: message.headers!['event-id']!.toString(), envelope });
    },
  });
  stopCollector = () => consumer.disconnect();

  s = await startStack({}, brokers);
  M = await s.newMerchant();
});
afterAll(async () => {
  await stopCollector();
  await s.close();
});

const uid = () => randomUUID().slice(0, 8);
const eventsFor = (aggregateId: string) => seen.filter((e) => e.key === aggregateId);
const typesFor = (aggregateId: string) => eventsFor(aggregateId).map((e) => e.envelope.eventType);
const count = (aggregateId: string, type: string) => typesFor(aggregateId).filter((t) => t === type).length;
const recover = () => s.api('/internal/recovery/run', { method: 'POST', body: {}, headers: { 'x-admin-token': s.payments.config.adminToken } });

async function customer(funds = 50_000n) {
  const id = `cust-${uid()}`;
  await s.api(`/v1/customers/${id}/topups`, { key: M.apiKey, idempotencyKey: `tu-${uid()}`, body: { amountMinor: funds.toString() } });
  return id;
}
const pay = (customerId: string, amount: number, reference?: string) => s.api('/v1/payments', { key: M.apiKey, idempotencyKey: `pay-${uid()}`, body: { customerId, amountMinor: String(amount), ...(reference ? { reference } : {}) } });

describe('events reach Kafka', () => {
  it('a successful payment emits payment.created then payment.succeeded, in order, on one partition, schema-valid', async () => {
    const c = await customer();
    const p = (await pay(c, 4_000)).body;
    expect(p.status).toBe('succeeded');
    await waitFor(async () => (typesFor(p.id).length >= 2 ? true : false), 15_000);

    expect(typesFor(p.id)).toEqual(['payment.created', 'payment.succeeded']);
    const evs = eventsFor(p.id);
    expect(new Set(evs.map((e) => e.partition)).size).toBe(1); // keyed by aggregate id => same partition => ordered
    for (const e of evs) {
      expect(() => parseEvent(e.envelope)).not.toThrow();
      expect(e.eventId).toBe(e.envelope.eventId); // header matches envelope
      expect(e.topic).toBe(TOPICS.payments);
    }
    expect(evs[1]!.envelope.payload).toMatchObject({ paymentId: p.id, merchantId: M.id, customerId: c, amountMinor: '4000', currency: 'INR' });
  });

  it("events echo the merchant's own reference so webhooks can be matched to orders", async () => {
    const ref = `order-${uid()}`;
    const p = (await pay(await customer(), 1_000, ref)).body;
    await waitFor(async () => (typesFor(p.id).length >= 2 ? true : false), 15_000);
    for (const e of eventsFor(p.id)) expect(e.envelope.payload).toMatchObject({ reference: ref });
    const plain = (await pay(await customer(), 1_000)).body; // no reference given: the field is simply absent (old shape still valid)
    await waitFor(async () => (typesFor(plain.id).length >= 2 ? true : false), 15_000);
    expect(eventsFor(plain.id)[0]!.envelope.payload).not.toHaveProperty('reference');
  });

  it('a declined payment emits payment.failed with the reason', async () => {
    s.gateway.faults.set({ declineRate: 1 });
    const c = await customer();
    const p = (await pay(c, 1_000)).body;
    s.gateway.faults.reset();
    await waitFor(async () => (count(p.id, 'payment.failed') === 1 ? true : false), 15_000);
    const failed = eventsFor(p.id).find((e) => e.envelope.eventType === 'payment.failed')!;
    expect(failed.envelope.payload).toMatchObject({ reason: 'declined_by_bank' });
    expect(count(p.id, 'payment.succeeded')).toBe(0);
  });

  it('a refund emits refund.created', async () => {
    const c = await customer();
    const p = (await pay(c, 3_000)).body;
    const r = (await s.api(`/v1/payments/${p.id}/refunds`, { key: M.apiKey, idempotencyKey: `ref-${uid()}`, body: { amountMinor: '1000' } })).body;
    await waitFor(async () => (count(r.id, 'refund.created') === 1 ? true : false), 15_000);
    expect(eventsFor(r.id)[0]!.envelope.payload).toMatchObject({ refundId: r.id, paymentId: p.id, amountMinor: '1000' });
  });

  it('the ledger emits transfer.completed once per transfer, even when the client retries', async () => {
    const a = await s.payments.ledger.wallet('customer', `ta-${uid()}`);
    const b = await s.payments.ledger.wallet('customer', `tb-${uid()}`);
    await fetch(`${s.ledger.url}/topups`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `f-${uid()}` }, body: JSON.stringify({ accountId: a.id, amountMinor: '5000' }) });
    const key = `xfer-${uid()}`;
    const call = () => fetch(`${s.ledger.url}/transfers`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ fromAccountId: a.id, toAccountId: b.id, amountMinor: '700' }) }).then((r) => r.json());
    const first = await call();
    await call();
    await call();
    await waitFor(async () => (count(first.id, 'transfer.completed') >= 1 ? true : false), 15_000);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(count(first.id, 'transfer.completed')).toBe(1);
    expect(eventsFor(first.id)[0]!.topic).toBe(TOPICS.ledger);
    expect(eventsFor(first.id)[0]!.envelope.payload).toMatchObject({ fromAccountId: a.id, toAccountId: b.id, amountMinor: '700' });
  });
});

describe('exactly-one event per state change, even under chaos', () => {
  it('lost response + duplicate callbacks + repeated recovery: ONE payment.succeeded and ONE payment.created', async () => {
    s.gateway.faults.set({ lostResponseRate: 1, duplicateCallbackRate: 1 });
    const c = await customer();
    const p = (await pay(c, 2_000)).body; // 202 processing
    expect(p.status).toBe('processing');
    s.gateway.faults.reset();
    await waitFor(async () => (count(p.id, 'payment.succeeded') >= 1 ? true : false), 15_000);
    for (let i = 0; i < 3; i++) await recover();
    await new Promise((r) => setTimeout(r, 1_500)); // let any (wrong) extra events arrive
    expect(count(p.id, 'payment.created')).toBe(1);
    expect(count(p.id, 'payment.succeeded')).toBe(1);
    expect(typesFor(p.id)).toEqual(['payment.created', 'payment.succeeded']);
  });

  it('an idempotent replay of a payment request emits no new events', async () => {
    const c = await customer();
    const key = `same-${uid()}`;
    const first = await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: key, body: { customerId: c, amountMinor: '900' } });
    await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: key, body: { customerId: c, amountMinor: '900' } });
    await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: key, body: { customerId: c, amountMinor: '900' } });
    await waitFor(async () => (count(first.body.id, 'payment.succeeded') >= 1 ? true : false), 15_000);
    await new Promise((r) => setTimeout(r, 800));
    expect(typesFor(first.body.id)).toEqual(['payment.created', 'payment.succeeded']);
  });
});

describe('the outbox buffers while Kafka is not being published to', () => {
  it('events written while the relay is stopped are kept in order and published once it restarts', async () => {
    await s.payments.relay!.stop(); // "Kafka is down / publisher is dead"
    const c = await customer();
    const p = (await pay(c, 1_200)).body; // the service keeps working
    expect(p.status).toBe('succeeded');
    const pending = await s.payments.db.selectFrom('outbox').select('event_type').where('aggregate_id', '=', p.id).where('published_at', 'is', null).execute();
    expect(pending.map((r) => r.event_type).sort()).toEqual(['payment.created', 'payment.succeeded']);
    await new Promise((r) => setTimeout(r, 800));
    expect(eventsFor(p.id)).toHaveLength(0); // nothing leaked out

    const relay = startOutboxRelay({ db: s.payments.db as never, brokers: [inject('kafkaBrokers')], service: 'payments', lockId: 74_002 });
    try {
      await waitFor(async () => (typesFor(p.id).length === 2 ? true : false), 20_000);
      expect(typesFor(p.id)).toEqual(['payment.created', 'payment.succeeded']);
    } finally {
      await relay.stop();
    }
  });
});
