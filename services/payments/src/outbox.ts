import { emitEvent } from '@zerodrift/kafka';
import type { EventEnvelope } from '@zerodrift/events';
import type { Transaction } from 'kysely';
import type { PaymentsDB } from './db-schema.js';

/** Write an event to the outbox in the caller's transaction (see @zerodrift/kafka emitEvent). */
export const emit = (trx: Transaction<PaymentsDB>, envelope: EventEnvelope): Promise<void> => emitEvent(trx, envelope);
