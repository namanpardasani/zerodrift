import type { EventEnvelope } from '@zerodrift/events';
import type { Transaction } from 'kysely';
import type { PaymentsDB } from './db-schema.js';

/**
 * Transactional outbox: write the event row in the SAME transaction as the state change it
 * describes. Either both commit or neither does, so we can never change state without emitting the
 * event (or emit one for a change that rolled back). A separate publisher relays rows to Kafka.
 */
export async function emit(trx: Transaction<PaymentsDB>, envelope: EventEnvelope): Promise<void> {
  await trx
    .insertInto('outbox')
    .values({
      id: envelope.eventId,
      aggregate_type: envelope.aggregateType,
      aggregate_id: envelope.aggregateId,
      event_type: envelope.eventType,
      payload: JSON.stringify(envelope),
    })
    .execute();
}
