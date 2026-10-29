import { registry } from '@zerodrift/common';
import { Gauge } from 'prom-client';
import type { Kafka } from './client.js';

const lagGauge = new Gauge({ name: 'kafka_consumer_lag', help: 'Messages a consumer group has not processed yet, per topic', labelNames: ['group', 'topic'], registers: [registry] });

/**
 * Consumer lag = (newest offset in the partition) - (offset the group has committed), summed over a
 * topic's partitions. It is THE health signal of an async pipeline: 0 means the consumer keeps up;
 * a growing number means events are arriving faster than they are handled (or the consumer is down).
 * A group that has never committed anything counts from the oldest retained offset.
 *
 * ONE admin client is created and kept for the reader's lifetime. (Creating and destroying a native
 * librdkafka client on every poll, next to live consumers, crashed the process with SIGSEGV.)
 */
export class LagReader {
  private admin?: ReturnType<Kafka['admin']>;
  private connecting?: Promise<void>;

  constructor(private readonly kafka: Kafka) {}

  private async ensure() {
    if (!this.admin) {
      this.admin = this.kafka.admin();
      this.connecting = this.admin.connect();
    }
    await this.connecting;
    return this.admin;
  }

  async read(groupId: string, topics: string[]): Promise<Record<string, number>> {
    const admin = await this.ensure();
    const out: Record<string, number> = {};
    const committed = await admin.fetchOffsets({ groupId, topics });
    for (const topic of topics) {
      const ends = await admin.fetchTopicOffsets(topic);
      const groupParts = committed.find((c) => c.topic === topic)?.partitions ?? [];
      let lag = 0;
      for (const p of ends) {
        const done = groupParts.find((g) => g.partition === p.partition);
        const doneOffset = done && Number(done.offset) >= 0 ? Number(done.offset) : Number(p.low);
        lag += Math.max(0, Number(p.offset) - doneOffset);
      }
      out[topic] = lag;
    }
    return out;
  }

  async close(): Promise<void> {
    const admin = this.admin;
    this.admin = undefined;
    await this.connecting?.catch(() => {});
    await admin?.disconnect().catch(() => {});
  }
}

/** One-shot convenience (tests, scripts). Long-running code should keep a LagReader instead. */
export async function computeLag(kafka: Kafka, groupId: string, topics: string[]): Promise<Record<string, number>> {
  const reader = new LagReader(kafka);
  try {
    return await reader.read(groupId, topics);
  } finally {
    await reader.close();
  }
}

/**
 * Publish the lag as a Prometheus gauge on an interval. Returns an async stop function: it waits for any
 * read still in flight and closes the admin client BEFORE returning, so callers can then tear down their
 * other native clients one at a time (closing several librdkafka clients concurrently crashed the process).
 */
export function startLagMonitor(kafka: Kafka, groupId: string, topics: string[], intervalMs = 5_000, onError?: (err: unknown) => void): () => Promise<void> {
  const reader = new LagReader(kafka);
  let current: Promise<void> | undefined; // the read in flight, if any (never overlap two reads)
  const tick = async () => {
    if (current) return;
    current = (async () => {
      try {
        const lag = await reader.read(groupId, topics);
        for (const [topic, n] of Object.entries(lag)) lagGauge.set({ group: groupId, topic }, n);
      } catch (err) {
        onError?.(err); // monitoring must never take the consumer down
      }
    })().finally(() => {
      current = undefined;
    });
    await current;
  };
  // first read after one interval, not immediately: let the consumer finish joining its group first
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
    await reader.close();
  };
}
