import { TOPIC_SPECS } from '@zerodrift/config';
import type { Kysely } from 'kysely';
import { type Producer, createKafka, createProducer, ensureTopics } from './client.js';
import { OutboxPublisher } from './outbox-publisher.js';

export interface OutboxRelayOptions {
  db: Kysely<any>;
  brokers: string[];
  service: string;
  lockId?: number;
  pollIntervalMs?: number;
  log?: (msg: string, extra?: unknown) => void;
}

export interface OutboxRelay {
  stop: () => Promise<void>;
  publisher: () => OutboxPublisher | undefined;
}

/**
 * Start publishing a service's outbox to Kafka, in the BACKGROUND.
 *
 * Deliberately not awaited by service boot: the outbox exists precisely so the service keeps
 * working (and keeps recording events durably) while Kafka is down or still starting. We keep
 * trying to connect; once connected, the backlog drains in order.
 */
export function startOutboxRelay(opts: OutboxRelayOptions): OutboxRelay {
  let stopped = false;
  let producer: Producer | undefined;
  let publisher: OutboxPublisher | undefined;
  const log = opts.log ?? (() => {});

  const connect = (async () => {
    for (let attempt = 1; !stopped; attempt++) {
      try {
        const kafka = createKafka({ brokers: opts.brokers, clientId: `${opts.service}-outbox` });
        await ensureTopics(kafka, TOPIC_SPECS);
        producer = await createProducer(kafka);
        publisher = new OutboxPublisher({
          db: opts.db,
          producer,
          service: opts.service,
          lockId: opts.lockId,
          pollIntervalMs: opts.pollIntervalMs,
          onError: (err) => log('outbox publish failed (will retry)', { error: (err as Error).message }),
        });
        publisher.start();
        log('outbox relay started', { brokers: opts.brokers });
        return;
      } catch (err) {
        log('kafka not reachable yet, retrying', { attempt, error: (err as Error).message });
        await new Promise((r) => setTimeout(r, Math.min(5_000, 500 * attempt)));
      }
    }
  })();

  return {
    publisher: () => publisher,
    stop: async () => {
      stopped = true;
      await connect.catch(() => {});
      await publisher?.stop();
      await producer?.disconnect().catch(() => {});
    },
  };
}
