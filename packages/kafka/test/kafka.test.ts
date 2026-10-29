import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { getCorrelationId, registry, runWithContext } from '@zerodrift/common';
import { currentTraceId, withSpan } from '@zerodrift/telemetry';
import { waitFor } from '@zerodrift/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxPublisher, type Producer, computeLag, createProducer, emitEvent, startIdempotentConsumer } from '../src/index.js';
import { makeEvent } from '@zerodrift/events';
import { createServiceDb, createTopics, readAll, writeOutbox } from './helpers.js';

let svc: Awaited<ReturnType<typeof createServiceDb>>;
let producer: Producer;

beforeAll(async () => {
  svc = await createServiceDb();
  const t = await createTopics();
  producer = await createProducer(t.kafka);
});
afterAll(async () => {
  await producer.disconnect();
  await svc.pool.end();
});

const handledCount = async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM handled`.execute(svc.db)).rows[0]!.n);
const clearAll = async () => {
  await sql`TRUNCATE outbox, handled, processed_events`.execute(svc.db);
};
const unpublished = async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM outbox WHERE published_at IS NULL`.execute(svc.db)).rows[0]!.n);

/** Publish until the outbox is drained. */
async function drain(pub: OutboxPublisher) {
  for (let i = 0; i < 50 && (await unpublished()) > 0; i++) await pub.publishOnce();
}

const defaultHandler = async ({ trx, event, payload }: { trx: any; event: { eventId: string; aggregateId: string }; payload: unknown }) => {
  const n = Number((payload as { amountMinor: string }).amountMinor) - 100;
  await sql`INSERT INTO handled (event_id, aggregate_id, n) VALUES (${event.eventId}, ${event.aggregateId}, ${n})`.execute(trx);
};

describe('outbox -> kafka -> idempotent consumer', () => {
  it('delivers every event and preserves per-aggregate order', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 1 });
    const consumer = await startIdempotentConsumer({ kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db, handler: defaultHandler });
    try {
      for (let n = 0; n < 30; n++) {
        await writeOutbox(svc.db, 'agg-A', n);
        await writeOutbox(svc.db, 'agg-B', n);
      }
      await drain(pub);
      await waitFor(async () => (await handledCount()) === 60, 30_000);
      for (const agg of ['agg-A', 'agg-B']) {
        const rows = await sql<{ n: number }>`SELECT n FROM handled WHERE aggregate_id = ${agg} ORDER BY id`.execute(svc.db);
        expect(rows.rows.map((r) => r.n)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      }
      expect(await unpublished()).toBe(0);
    } finally {
      await consumer.stop();
    }
  }, 60_000);

  it('a resent event (publisher at-least-once) is handled exactly once', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 2 });
    const consumer = await startIdempotentConsumer({ kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db, handler: defaultHandler });
    try {
      for (let n = 0; n < 10; n++) await writeOutbox(svc.db, 'agg-dup', n);
      await drain(pub);
      await waitFor(async () => (await handledCount()) === 10, 20_000);
      // pretend the publisher crashed after sending but before marking: everything is sent AGAIN
      await sql`UPDATE outbox SET published_at = NULL`.execute(svc.db);
      await drain(pub);
      const onTopic = await readAll(t.kafka, t.topic, 20);
      expect(onTopic).toHaveLength(20); // duplicates really are on the topic...
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await handledCount()).toBe(10); // ...but were handled once
      const inbox = await sql<{ n: string }>`SELECT count(*)::text AS n FROM processed_events`.execute(svc.db);
      expect(Number(inbox.rows[0]!.n)).toBe(10);
    } finally {
      await consumer.stop();
    }
  }, 60_000);

  it('crash between send and commit: the batch is re-sent and consumers still process each event once', async () => {
    await clearAll();
    const t = await createTopics();
    let failNext = true;
    const crashy: Producer = Object.create(producer, {
      send: {
        value: async (record: Parameters<Producer['send']>[0]) => {
          const r = await producer.send(record); // the broker HAS the messages...
          if (failNext) {
            failNext = false;
            throw new Error('crash after send, before commit'); // ...but we "died" before marking them published
          }
          return r;
        },
      },
    });
    const pub = new OutboxPublisher({ db: svc.db, producer: crashy, service: 'test', topicFor: t.topicFor, lockId: 3 });
    const consumer = await startIdempotentConsumer({ kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db, handler: defaultHandler });
    try {
      for (let n = 0; n < 8; n++) await writeOutbox(svc.db, 'agg-crash', n);
      await expect(pub.publishOnce()).rejects.toThrow('crash after send');
      expect(await unpublished()).toBe(8); // transaction rolled back: nothing marked published
      await drain(pub);
      expect(await unpublished()).toBe(0);
      await waitFor(async () => (await handledCount()) === 8, 20_000);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await handledCount()).toBe(8);
    } finally {
      await consumer.stop();
    }
  }, 60_000);

  it('two publishers racing on one outbox publish every event exactly once (advisory lock)', async () => {
    await clearAll();
    const t = await createTopics();
    const a = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 4, batchSize: 10 });
    const b = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 4, batchSize: 10 });
    for (let n = 0; n < 100; n++) await writeOutbox(svc.db, `agg-${n % 7}`, n);
    for (let i = 0; i < 60 && (await unpublished()) > 0; i++) await Promise.all([a.publishOnce(), b.publishOnce()]);
    const msgs = await readAll(t.kafka, t.topic, 100);
    expect(msgs).toHaveLength(100);
    expect(new Set(msgs.map((m) => m.headers['event-id'])).size).toBe(100);
  }, 60_000);

  it('survives a Kafka outage: nothing lost, nothing duplicated, backlog drains after recovery', async () => {
    await clearAll();
    const t = await createTopics();
    let failures = 3;
    const flaky: Producer = Object.create(producer, {
      send: {
        value: async (record: Parameters<Producer['send']>[0]) => {
          if (failures-- > 0) throw new Error('broker unavailable');
          return producer.send(record);
        },
      },
    });
    const errors: unknown[] = [];
    const pub = new OutboxPublisher({ db: svc.db, producer: flaky, service: 'test', topicFor: t.topicFor, lockId: 5, pollIntervalMs: 50, onError: (e) => errors.push(e) });
    for (let n = 0; n < 12; n++) await writeOutbox(svc.db, 'agg-out', n);
    pub.start();
    try {
      await waitFor(async () => (await unpublished()) === 0, 15_000);
    } finally {
      await pub.stop();
    }
    expect(errors.length).toBe(3);
    const msgs = await readAll(t.kafka, t.topic, 12);
    expect(msgs).toHaveLength(12);
  }, 60_000);
});

describe('consumer failure handling', () => {
  it('a transient handler failure is retried and its partial writes are rolled back', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 6 });
    let attempts = 0;
    const consumer = await startIdempotentConsumer({
      kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db, retryBaseMs: 10, retryMaxMs: 20, maxAttempts: 5,
      handler: async (ctx) => {
        await defaultHandler(ctx as never); // write first...
        if (++attempts < 3) throw new Error('transient'); // ...then fail: the write must vanish with the rollback
      },
    });
    try {
      await writeOutbox(svc.db, 'agg-retry', 0);
      await drain(pub);
      await waitFor(async () => (await handledCount()) >= 1, 20_000);
      await new Promise((r) => setTimeout(r, 500));
      expect(attempts).toBe(3);
      expect(await handledCount()).toBe(1); // exactly one surviving write despite 3 attempts
    } finally {
      await consumer.stop();
    }
  }, 60_000);

  it('a permanently failing message goes to the DLQ with diagnostics and does NOT block the partition', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 7 });
    const consumer = await startIdempotentConsumer({
      kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db, retryBaseMs: 10, retryMaxMs: 20, maxAttempts: 3,
      handler: async (ctx) => {
        if (ctx.event.aggregateId === 'poisoned') throw new Error('cannot handle this one');
        await defaultHandler(ctx as never);
      },
    });
    try {
      await writeOutbox(svc.db, 'agg-ok', 0);
      const bad = await writeOutbox(svc.db, 'poisoned', 1);
      await writeOutbox(svc.db, 'agg-ok', 2);
      await drain(pub);
      await waitFor(async () => (await handledCount()) === 2, 20_000); // the good ones still flow
      const dlq = await readAll(t.kafka, t.dlq, 1);
      expect(dlq).toHaveLength(1);
      expect(dlq[0]!.value.eventId).toBe(bad.eventId);
      expect(dlq[0]!.headers['dlq-reason']).toContain('cannot handle this one');
      expect(dlq[0]!.headers['dlq-attempts']).toBe('3');
      expect(dlq[0]!.headers['dlq-original-topic']).toBe(t.topic);
      const inbox = await sql`SELECT 1 FROM processed_events WHERE event_id = ${bad.eventId}`.execute(svc.db);
      expect(inbox.rows).toHaveLength(0); // failed events are not remembered as processed (replayable)
    } finally {
      await consumer.stop();
    }
  }, 60_000);

  it('poison messages (not JSON / fail the event schema) are dead-lettered immediately, without retries', async () => {
    await clearAll();
    const t = await createTopics();
    let handlerCalls = 0;
    const consumer = await startIdempotentConsumer({
      kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db, retryBaseMs: 10, maxAttempts: 5,
      handler: async () => void handlerCalls++,
    });
    try {
      await producer.send({ topic: t.topic, messages: [{ key: 'x', value: 'this is not json' }, { key: 'y', value: JSON.stringify({ eventType: 'payment.succeeded', hello: 'world' }) }] });
      const dlq = await readAll(t.kafka, t.dlq, 2);
      expect(dlq).toHaveLength(2);
      for (const m of dlq) expect(m.headers['dlq-reason']).toContain('invalid_message');
      expect(handlerCalls).toBe(0);
    } finally {
      await consumer.stop();
    }
  }, 60_000);

  it('a consumer restart resumes where it left off: no loss, no double processing', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 8 });
    const groupId = `g-${randomUUID()}`;
    const start = () => startIdempotentConsumer({ kafka: t.kafka, groupId, topics: [t.topic], db: svc.db, handler: defaultHandler });

    let c = await start();
    for (let n = 0; n < 20; n++) await writeOutbox(svc.db, `agg-${n % 4}`, n);
    await drain(pub);
    await waitFor(async () => (await handledCount()) >= 5, 20_000);
    await c.stop(); // "crash"/redeploy mid-stream
    for (let n = 20; n < 40; n++) await writeOutbox(svc.db, `agg-${n % 4}`, n);
    await drain(pub);
    c = await start();
    try {
      await waitFor(async () => (await handledCount()) === 40, 30_000);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await handledCount()).toBe(40);
      const dup = await sql<{ n: string }>`SELECT count(*)::text AS n FROM (SELECT event_id FROM handled GROUP BY event_id HAVING count(*) > 1) d`.execute(svc.db);
      expect(Number(dup.rows[0]!.n)).toBe(0);
    } finally {
      await c.stop();
    }
  }, 90_000);
});

describe('trace + correlation context across Kafka', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  beforeAll(() => provider.register());
  afterAll(() => provider.shutdown());

  it('the trace id and correlation id of the request that wrote the event reappear in the consumer handler, and the consumer span is a child of the request span', async () => {
    await clearAll();
    exporter.reset();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 9 });
    const seen: { traceId?: string; correlationId?: string; envelopeTrace?: string }[] = [];
    const consumer = await startIdempotentConsumer({
      kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db,
      handler: async (ctx) => {
        seen.push({ traceId: currentTraceId(), correlationId: getCorrelationId(), envelopeTrace: ctx.event.traceparent });
      },
    });
    try {
      let requestTraceId = '';
      // "an HTTP request" with a correlation id writes an event inside its DB transaction
      await runWithContext({ correlationId: 'req-corr-123' }, () =>
        withSpan('POST /v1/payments', async (span) => {
          requestTraceId = span.spanContext().traceId;
          const env = makeEvent('transfer.completed', 'transfer', 'agg-trace', { transactionId: randomUUID(), fromAccountId: randomUUID(), toAccountId: randomUUID(), amountMinor: '100', currency: 'INR' });
          await svc.db.transaction().execute((trx) => emitEvent(trx, env));
        }),
      );
      await drain(pub);
      await waitFor(async () => (seen.length === 1 ? true : false), 20_000);
      // the span only reaches the exporter when it ENDS, which is just after the handler returns
      await waitFor(async () => (exporter.getFinishedSpans().some((sp) => sp.name === 'consume transfer.completed') ? true : false), 10_000);

      expect(seen[0]!.traceId).toBe(requestTraceId); // the consumer is INSIDE the original trace
      expect(seen[0]!.correlationId).toBe('req-corr-123'); // and its logs would carry the original correlation id
      expect(seen[0]!.envelopeTrace).toContain(requestTraceId);

      const spans = exporter.getFinishedSpans();
      const request = spans.find((s) => s.name === 'POST /v1/payments')!;
      const consume = spans.find((s) => s.name === 'consume transfer.completed')!;
      expect(consume.spanContext().traceId).toBe(request.spanContext().traceId);
      expect(consume.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
      expect(consume.attributes['messaging.system']).toBe('kafka');
      expect(consume.attributes['zerodrift.event.type']).toBe('transfer.completed');
    } finally {
      await consumer.stop();
    }
  }, 60_000);

  it('events written with no trace/correlation context still flow (tracing off is a supported mode)', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 10 });
    const seen: unknown[] = [];
    const consumer = await startIdempotentConsumer({ kafka: t.kafka, groupId: `g-${randomUUID()}`, topics: [t.topic], db: svc.db, handler: async (ctx) => void seen.push(ctx.event.traceparent) });
    try {
      await writeOutbox(svc.db, 'agg-plain', 1);
      await drain(pub);
      await waitFor(async () => (seen.length === 1 ? true : false), 20_000);
      expect(seen[0]).toBeUndefined();
    } finally {
      await consumer.stop();
    }
  }, 60_000);
});

describe('consumer lag', () => {
  it('counts unconsumed messages for a group that has not started, then drops to zero as it catches up', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 11 });
    for (let n = 0; n < 25; n++) await writeOutbox(svc.db, `agg-${n % 5}`, n);
    await drain(pub);

    const groupId = `g-${randomUUID()}`;
    expect((await computeLag(t.kafka, groupId, [t.topic]))[t.topic]).toBe(25); // nobody has read anything yet

    const consumer = await startIdempotentConsumer({ kafka: t.kafka, groupId, topics: [t.topic], db: svc.db, handler: defaultHandler, lagIntervalMs: 0 });
    try {
      await waitFor(async () => (await handledCount()) === 25, 30_000);
      await waitFor(async () => ((await computeLag(t.kafka, groupId, [t.topic]))[t.topic] === 0 ? true : false), 30_000); // offsets are committed shortly after handling
    } finally {
      await consumer.stop();
    }
  }, 90_000);

  it('grows while a consumer is stopped and new events keep arriving', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 12 });
    const groupId = `g-${randomUUID()}`;
    const start = () => startIdempotentConsumer({ kafka: t.kafka, groupId, topics: [t.topic], db: svc.db, handler: defaultHandler, lagIntervalMs: 0 });
    let c = await start();
    await writeOutbox(svc.db, 'agg-a', 1);
    await drain(pub);
    await waitFor(async () => (await handledCount()) === 1, 20_000);
    await waitFor(async () => ((await computeLag(t.kafka, groupId, [t.topic]))[t.topic] === 0 ? true : false), 30_000);
    await c.stop(); // the consumer goes away...
    for (let n = 0; n < 7; n++) await writeOutbox(svc.db, 'agg-a', 10 + n);
    await drain(pub);
    expect((await computeLag(t.kafka, groupId, [t.topic]))[t.topic]).toBe(7); // ...and the backlog is visible
    c = await start();
    try {
      await waitFor(async () => (await handledCount()) === 8, 30_000);
    } finally {
      await c.stop();
    }
  }, 120_000);
});

describe('lag monitor robustness', () => {
  it('publishes kafka_consumer_lag as a metric while a consumer runs', async () => {
    await clearAll();
    const t = await createTopics();
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'test', topicFor: t.topicFor, lockId: 13 });
    const groupId = `g-metric-${randomUUID().slice(0, 8)}`;
    for (let n = 0; n < 6; n++) await writeOutbox(svc.db, 'agg-m', n);
    await drain(pub);
    const consumer = await startIdempotentConsumer({ kafka: t.kafka, groupId, topics: [t.topic], db: svc.db, handler: defaultHandler, lagIntervalMs: 300 });
    try {
      await waitFor(async () => ((await registry.metrics()).includes(`kafka_consumer_lag{group="${groupId}",topic="${t.topic}"}`) ? true : false), 20_000);
      await waitFor(async () => (new RegExp(`kafka_consumer_lag\\{group="${groupId}",topic="${t.topic.replace(/\./g, '\\.')}"\\} 0`).test(await registry.metrics()) ? true : false), 30_000);
    } finally {
      await consumer.stop();
    }
  }, 90_000);

  it('rapid start/stop cycles with an aggressive lag monitor never crash the native client (regression: SIGSEGV when clients were torn down concurrently)', async () => {
    await clearAll();
    const t = await createTopics();
    for (let i = 0; i < 6; i++) {
      const c = await startIdempotentConsumer({ kafka: t.kafka, groupId: `g-cycle-${randomUUID().slice(0, 8)}`, topics: [t.topic], db: svc.db, handler: defaultHandler, lagIntervalMs: 50 });
      await new Promise((r) => setTimeout(r, 250 + i * 40)); // let some monitor reads be in flight at stop time
      await c.stop();
    }
    expect(true).toBe(true); // reaching here without a SIGSEGV is the assertion
  }, 120_000);
});
