import { KafkaJS } from '@confluentinc/kafka-javascript';
import { retry } from '@zerodrift/common';

export type Kafka = KafkaJS.Kafka;
export type Producer = KafkaJS.Producer;

export interface KafkaOptions {
  brokers: string[];
  clientId: string;
}

/**
 * We use @confluentinc/kafka-javascript (librdkafka bindings, maintained by Confluent; last release
 * 2026-10) through its KafkaJS-compatible API. The original KafkaJS package has had no release
 * since 2023-02, so it was rejected (see NOTES.md).
 */
export function createKafka(opts: KafkaOptions): Kafka {
  return new KafkaJS.Kafka({ kafkaJS: { brokers: opts.brokers, clientId: opts.clientId, logLevel: KafkaJS.logLevel.ERROR } });
}

/**
 * A producer configured for safety over speed: acks=all and the idempotent producer, so a retry
 * inside the client can never write the same message twice into a partition.
 */
export async function createProducer(kafka: Kafka): Promise<Producer> {
  const producer = kafka.producer({ kafkaJS: { acks: -1, idempotent: true } });
  await producer.connect();
  return producer;
}

/** Create topics if missing (idempotent). Retries because brokers may still be starting. */
export async function ensureTopics(kafka: Kafka, topics: { topic: string; numPartitions: number }[], replicationFactor = 1): Promise<void> {
  await retry(
    async () => {
      const admin = kafka.admin();
      await admin.connect();
      try {
        await admin.createTopics({ topics: topics.map((t) => ({ topic: t.topic, numPartitions: t.numPartitions, replicationFactor })) });
      } finally {
        await admin.disconnect();
      }
    },
    { retries: 10, baseMs: 300, maxMs: 3_000 },
  );
}
