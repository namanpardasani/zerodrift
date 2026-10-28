import type { EventEnvelope } from '@zerodrift/events';
import { type Transaction, sql } from 'kysely';

/**
 * Transactional outbox, write side. Call this INSIDE the transaction that changes state: the event
 * row then commits or rolls back together with the change, so state can never change without its
 * event being recorded (and no event exists for a change that rolled back). The row stores the
 * complete envelope; the OutboxPublisher later relays it to Kafka.
 */
export async function emitEvent(trx: Transaction<any>, envelope: EventEnvelope): Promise<void> {
  await sql`
    INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
    VALUES (${envelope.eventId}, ${envelope.aggregateType}, ${envelope.aggregateId}, ${envelope.eventType}, ${JSON.stringify(envelope)}::jsonb)`.execute(trx);
}
