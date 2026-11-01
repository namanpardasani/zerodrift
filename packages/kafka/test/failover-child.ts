// A consumer in its own OS process, so a test can kill it the way a crashed pod dies (SIGKILL: no leave-group, no goodbye).
import { createDb, createPool } from '@zerodrift/db';
import { sql } from 'kysely';
import { createKafka, startIdempotentConsumer } from '../src/index.js';

async function main() {
  const pool = createPool(process.env.DATABASE_URL!, 5);
  const db = createDb<any>(pool);
  const kafka = createKafka({ brokers: [process.env.KAFKA_BROKERS!], clientId: `failover-child-${process.pid}` });
  await startIdempotentConsumer({
    kafka,
    db,
    groupId: process.env.GROUP!,
    topics: [process.env.TOPIC!],
    lagIntervalMs: 0,
    handler: async ({ trx, event, payload }) => {
      const n = Number((payload as { amountMinor: string }).amountMinor) - 100;
      await sql`INSERT INTO handled (event_id, aggregate_id, n) VALUES (${event.eventId}, ${event.aggregateId}, ${n})`.execute(trx);
    },
  });
  console.log(`READY ${process.pid}`);
  setInterval(() => undefined, 1 << 30);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
