import { registry } from '@zerodrift/common';
import { topicForAggregate } from '@zerodrift/config';
import { type Kysely, sql } from 'kysely';
import { Counter, Gauge } from 'prom-client';
import type { Producer } from './client.js';

const published = new Counter({ name: 'outbox_published_total', help: 'Outbox events published to Kafka', labelNames: ['service'], registers: [registry] });
const failures = new Counter({ name: 'outbox_publish_errors_total', help: 'Failed outbox publish attempts', labelNames: ['service'], registers: [registry] });
const backlog = new Gauge({ name: 'outbox_backlog', help: 'Unpublished outbox rows (capped at 10001)', labelNames: ['service'], registers: [registry] });

export interface OutboxPublisherOptions {
  /** The service's own database; it must contain the `outbox` table. */
  db: Kysely<any>;
  producer: Producer;
  service: string;
  /** Postgres advisory lock id; one publisher per outbox table at a time. Must be unique per database. */
  lockId?: number;
  batchSize?: number;
  pollIntervalMs?: number;
  /** Maps an aggregate type to its topic. Defaults to the shared routing table; tests override it. */
  topicFor?: (aggregateType: string) => string;
  onError?: (err: unknown) => void;
}

/**
 * Relays the transactional outbox to Kafka. At-least-once by construction:
 *
 *   1. in ONE transaction: take an advisory lock, read the oldest unpublished rows,
 *      send them to Kafka (acks=all), mark them published, COMMIT.
 *   2. If the process dies after the send but before the COMMIT, the rows are still unpublished and
 *      are sent AGAIN by the next run. Duplicates are expected and harmless: every event carries a
 *      stable `eventId` and consumers deduplicate on it (see idempotent-consumer.ts).
 *
 * Why an advisory lock (one active publisher): with several replicas, concurrent publishers using
 * SKIP LOCKED could send two events of the SAME aggregate out of order. A single active publisher
 * per outbox keeps order; any replica can take over instantly if the leader dies (the lock is
 * released with its transaction). Trade-off: publish throughput is one batch loop, which is ample
 * here and can be sharded by aggregate id later.
 *
 * Ordering: rows are read by `seq` (a bigserial) and keyed by aggregate id, so all events of one
 * aggregate land in one partition in the order they were written.
 */
export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private readonly lockId: number;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: OutboxPublisherOptions) {
    this.lockId = opts.lockId ?? 74_001;
    this.batchSize = opts.batchSize ?? 200;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
  }

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        // keep draining while there is more to send; sleep only when caught up
        while (!this.stopped && (await this.publishOnce()) === this.batchSize) {
          /* more waiting */
        }
      } catch (err) {
        failures.inc({ service: this.opts.service });
        this.opts.onError?.(err);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 10)); // let an in-flight batch finish
  }

  /** Publish one batch. Returns how many events were published (0 if idle or another replica holds the lock). */
  async publishOnce(): Promise<number> {
    this.running = true;
    try {
      return await this.opts.db.transaction().execute(async (trx) => {
        const lock = await sql<{ ok: boolean }>`select pg_try_advisory_xact_lock(${this.lockId}) as ok`.execute(trx);
        if (!lock.rows[0]?.ok) return 0;

        const rows = await sql<{ id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: unknown }>`
          SELECT id, aggregate_type, aggregate_id, event_type, payload
          FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT ${this.batchSize}`.execute(trx);
        if (rows.rows.length === 0) {
          backlog.set({ service: this.opts.service }, 0);
          return 0;
        }

        // One send per topic, preserving the read order inside each topic.
        const byTopic = new Map<string, { key: string; value: string; headers: Record<string, string> }[]>();
        for (const r of rows.rows) {
          const topic = (this.opts.topicFor ?? topicForAggregate)(r.aggregate_type);
          const list = byTopic.get(topic) ?? [];
          list.push({ key: r.aggregate_id, value: JSON.stringify(r.payload), headers: { 'event-id': r.id, 'event-type': r.event_type } });
          byTopic.set(topic, list);
        }
        for (const [topic, messages] of byTopic) await this.opts.producer.send({ topic, messages });

        await sql`UPDATE outbox SET published_at = now() WHERE id = ANY(${sql.val(rows.rows.map((r) => r.id))}::uuid[])`.execute(trx);
        published.inc({ service: this.opts.service }, rows.rows.length);

        const remaining = await sql<{ n: string }>`SELECT count(*)::text AS n FROM (SELECT 1 FROM outbox WHERE published_at IS NULL LIMIT 10001) t`.execute(trx);
        backlog.set({ service: this.opts.service }, Number(remaining.rows[0]?.n ?? 0));
        return rows.rows.length;
      });
    } finally {
      this.running = false;
    }
  }
}
