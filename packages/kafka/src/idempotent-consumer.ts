import { KafkaJS } from '@confluentinc/kafka-javascript';
import { backoffDelayMs, registry, runWithContext } from '@zerodrift/common';
import { dlqTopicFor } from '@zerodrift/config';
import { type EventEnvelope, type EventType, parseEvent } from '@zerodrift/events';
import { type Kysely, type Transaction, sql } from 'kysely';
import { SpanKind, withSpan } from '@zerodrift/telemetry';
import { randomUUID } from 'node:crypto';
import { Counter } from 'prom-client';
import { type Kafka, type Producer, createProducer } from './client.js';
import { startLagMonitor } from './lag.js';

const processed = new Counter({
  name: 'consumer_messages_total',
  help: 'Consumed messages by outcome',
  labelNames: ['consumer', 'result'], // processed | duplicate | dead_lettered
  registers: [registry],
});

/**
 * The inbox: remembers which events a consumer already handled. PRIMARY KEY (consumer, event_id)
 * is what turns Kafka's at-least-once delivery into effectively-once PROCESSING.
 * Each consuming service adds this table to its own migrations via `createInboxTable`.
 */
export async function createInboxTable(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS processed_events (
      consumer     text NOT NULL,
      event_id     uuid NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    )`.execute(db);
}

export interface HandlerContext {
  /** The inbox row and everything the handler writes commit (or roll back) together. */
  trx: Transaction<any>;
  event: EventEnvelope;
  type: EventType;
  payload: unknown;
  meta: { topic: string; partition: number; offset: string };
}

export interface IdempotentConsumerOptions {
  kafka: Kafka;
  /** Consumer group id; also the name under which processed events are remembered. */
  groupId: string;
  topics: string[];
  db: Kysely<any>;
  handler: (ctx: HandlerContext) => Promise<void>;
  /** Attempts (including the first) before a failing message is dead-lettered. */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  fromBeginning?: boolean;
  /** How often to publish this group's lag as the kafka_consumer_lag metric. 0 disables. */
  lagIntervalMs?: number;
  onError?: (err: unknown, info: { topic: string; offset: string; attempt: number }) => void;
}

export interface RunningConsumer {
  stop: () => Promise<void>;
}

/**
 * An at-least-once consumer made idempotent.
 *
 *  - The handler runs in the SAME database transaction as the inbox insert. A redelivered event
 *    (rebalance, crash before offset commit, publisher resend) hits the inbox PK and is skipped,
 *    so handler effects happen once even though delivery is at-least-once.
 *    (Effects outside this database, e.g. HTTP calls, are NOT covered: have the handler write a
 *    job row instead and perform the call afterwards, as the webhook-service does.)
 *  - A failing handler is retried with backoff IN PLACE (blocking its partition keeps per-aggregate
 *    ordering). After `maxAttempts` the message goes to the dead-letter topic with the error in its
 *    headers, the offset moves on, and the partition is unblocked.
 *  - Messages that can never succeed (not JSON, fail the event schema) are dead-lettered at once.
 *  - If even the dead-letter publish fails we throw, the offset is NOT committed and the message is
 *    redelivered: a message is never silently dropped.
 *  - Offsets are committed only after eachMessage resolves (autoCommit), so a crash mid-handling
 *    means redelivery, never loss.
 */
export async function startIdempotentConsumer(opts: IdempotentConsumerOptions): Promise<RunningConsumer> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const dlqProducer: Producer = await createProducer(opts.kafka);
  const consumer = opts.kafka.consumer({
    kafkaJS: { groupId: opts.groupId, fromBeginning: opts.fromBeginning ?? true, autoCommit: true },
  });
  await consumer.connect();
  await consumer.subscribe({ topics: opts.topics });

  const deadLetter = async (topic: string, partition: number, offset: string, key: Buffer | null, value: Buffer | null, reason: string, attempts: number) => {
    await dlqProducer.send({
      topic: dlqTopicFor(topic),
      messages: [
        {
          key,
          value,
          headers: {
            'dlq-reason': reason.slice(0, 1000),
            'dlq-consumer': opts.groupId,
            'dlq-original-topic': topic,
            'dlq-original-partition': String(partition),
            'dlq-original-offset': offset,
            'dlq-attempts': String(attempts),
          },
        },
      ],
    });
    processed.inc({ consumer: opts.groupId, result: 'dead_lettered' });
  };

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const offset = message.offset;
      const raw = message.value;

      let parsed: ReturnType<typeof parseEvent>;
      try {
        parsed = parseEvent(JSON.parse(raw?.toString('utf8') ?? ''));
      } catch (err) {
        // poison message: retrying cannot help
        await deadLetter(topic, partition, offset, message.key as Buffer | null, raw, `invalid_message: ${(err as Error).message}`, 1);
        return;
      }

      // Everything below runs (a) with the event's correlation id in context, so log lines written by the
      // handler carry it, and (b) inside a span that CONTINUES the trace of the request that caused the
      // event (its traceparent travelled in the envelope), so a payment's async tail is part of its trace.
      await runWithContext({ correlationId: parsed.envelope.correlationId ?? randomUUID() }, () =>
        withSpan(
          `consume ${parsed.type}`,
          async () => {
            for (let attempt = 1; ; attempt++) {
              try {
                const duplicate = await opts.db.transaction().execute(async (trx) => {
                  const claimed = await sql<{ event_id: string }>`
                    INSERT INTO processed_events (consumer, event_id) VALUES (${opts.groupId}, ${parsed.envelope.eventId})
                    ON CONFLICT DO NOTHING RETURNING event_id`.execute(trx);
                  if (claimed.rows.length === 0) return true; // already handled: skip
                  await opts.handler({ trx, event: parsed.envelope, type: parsed.type, payload: parsed.payload, meta: { topic, partition, offset } });
                  return false;
                });
                processed.inc({ consumer: opts.groupId, result: duplicate ? 'duplicate' : 'processed' });
                return;
              } catch (err) {
                opts.onError?.(err, { topic, offset, attempt });
                if (attempt >= maxAttempts) {
                  await deadLetter(topic, partition, offset, message.key as Buffer | null, raw, `handler_failed: ${(err as Error).message}`, attempt);
                  return;
                }
                await new Promise((r) => setTimeout(r, backoffDelayMs(attempt - 1, { baseMs: opts.retryBaseMs ?? 200, maxMs: opts.retryMaxMs ?? 5_000 })));
              }
            }
          },
          { parentTraceparent: parsed.envelope.traceparent, kind: SpanKind.CONSUMER, attributes: { 'messaging.system': 'kafka', 'messaging.destination.name': topic, 'zerodrift.event.id': parsed.envelope.eventId, 'zerodrift.event.type': parsed.type } },
        ),
      );
    },
  });

  const stopLag = (opts.lagIntervalMs ?? 5_000) > 0 ? startLagMonitor(opts.kafka, opts.groupId, opts.topics, opts.lagIntervalMs ?? 5_000) : async () => {};
  return {
    stop: async () => {
      // strictly one native client at a time: lag admin first, then the consumer, then the DLQ producer
      await stopLag();
      await consumer.disconnect();
      await dlqProducer.disconnect();
    },
  };
}

export { KafkaJS };
