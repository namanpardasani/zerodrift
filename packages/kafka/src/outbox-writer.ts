import { getCorrelationId } from '@zerodrift/common';
import type { EventEnvelope } from '@zerodrift/events';
import { currentTraceparent } from '@zerodrift/telemetry';
import { type Transaction, sql } from 'kysely';

/**
 * Transactional outbox, write side. Call this INSIDE the transaction that changes state: the event
 * row then commits or rolls back together with the change, so state can never change without its
 * event being recorded (and no event exists for a change that rolled back). The row stores the
 * complete envelope; the OutboxPublisher later relays it to Kafka.
 */
export async function emitEvent(trx: Transaction<any>, input: EventEnvelope): Promise<void> {
  // Stamp the causing operation's identity onto the event: the correlation id (for logs) and the trace
  // context (for traces). Consumers on the other side of Kafka then continue both.
  const envelope: EventEnvelope = { ...input, correlationId: input.correlationId ?? getCorrelationId(), traceparent: input.traceparent ?? currentTraceparent() };
  await sql`
    INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
    VALUES (${envelope.eventId}, ${envelope.aggregateType}, ${envelope.aggregateId}, ${envelope.eventType}, ${JSON.stringify(envelope)}::jsonb)`.execute(trx);
}
