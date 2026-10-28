import { randomUUID } from 'node:crypto';
import { createDb, createPool } from '@zerodrift/db';
import { makeEvent } from '@zerodrift/events';
import { createTestDatabase, inject } from '@zerodrift/testing';
import { type Kysely, sql } from 'kysely';
import { createInboxTable, createKafka, createProducer, ensureTopics } from '../src/index.js';

/** A service-shaped database: an outbox, an inbox, and a `handled` table the test handler writes to. */
export async function createServiceDb() {
  const { url } = await createTestDatabase();
  const pool = createPool(url, 20);
  const db = createDb<any>(pool) as Kysely<any>;
  await sql`
    CREATE TABLE outbox (
      id uuid PRIMARY KEY, aggregate_type text NOT NULL, aggregate_id text NOT NULL, event_type text NOT NULL,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
      seq bigserial
    )`.execute(db);
  await sql`CREATE TABLE handled (event_id uuid, aggregate_id text, n integer, seen_at timestamptz DEFAULT now(), id bigserial PRIMARY KEY)`.execute(db);
  await createInboxTable(db);
  return { db, pool };
}

/** Unique topic names per test so tests never see each other's messages. */
export async function createTopics() {
  const kafka = createKafka({ brokers: [inject('kafkaBrokers')], clientId: `test-${randomUUID().slice(0, 6)}` });
  const base = `t-${randomUUID().slice(0, 8)}`;
  const topic = `${base}.events`;
  await ensureTopics(kafka, [{ topic, numPartitions: 3 }, { topic: `${topic}.dlq`, numPartitions: 1 }]);
  return { kafka, topic, dlq: `${topic}.dlq`, topicFor: () => topic };
}

/** Write one outbox row exactly as a producing service would (envelope stored in `payload`). */
export async function writeOutbox(db: Kysely<any>, aggregateId: string, n = 0) {
  const env = makeEvent('transfer.completed', 'transfer', aggregateId, {
    transactionId: randomUUID(), fromAccountId: randomUUID(), toAccountId: randomUUID(), amountMinor: String(100 + n), currency: 'INR',
  });
  await sql`INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
            VALUES (${env.eventId}, ${env.aggregateType}, ${env.aggregateId}, ${env.eventType}, ${JSON.stringify(env)}::jsonb)`.execute(db);
  return env;
}

/** DLQ topics hold raw poison messages too, so fall back to the raw string instead of throwing. */
function parseOrRaw(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Read every message currently on a topic with a throwaway consumer group. */
export async function readAll(kafka: ReturnType<typeof createKafka>, topic: string, expected: number, timeoutMs = 20_000) {
  const consumer = kafka.consumer({ kafkaJS: { groupId: `reader-${randomUUID()}`, fromBeginning: true, autoCommit: false } });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  const out: { key: string; value: any; headers: Record<string, string>; partition: number; offset: string }[] = [];
  await consumer.run({
    eachMessage: async ({ partition, message }) => {
      out.push({
        key: message.key?.toString() ?? '',
        value: parseOrRaw(message.value?.toString() ?? ''),
        headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString() : String(v)])),
        partition,
        offset: message.offset,
      });
    },
  });
  const deadline = Date.now() + timeoutMs;
  while (out.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  // linger briefly to catch unexpected EXTRA messages (duplicates)
  await new Promise((r) => setTimeout(r, 500));
  await consumer.disconnect();
  return out;
}

export { createProducer };
