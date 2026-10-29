import { z } from 'zod';

/**
 * Versioned event contracts shared by every producer and consumer.
 *
 * Rules for evolving these (see NOTES.md):
 *  - Adding an OPTIONAL field is backwards compatible: keep `schemaVersion`.
 *  - Removing/renaming/retyping a field is breaking: add a new event type version
 *    (e.g. `payment.succeeded.v2`) and run both until consumers have moved.
 * Amounts are decimal STRINGS on the wire (JSON has no bigint, and numbers lose precision).
 */

const amount = z.string().regex(/^\d+$/, 'amount must be an integer string in minor units');

/** Envelope wrapped around every event. `eventId` is the idempotency key for consumers. */
export const envelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string(),
  schemaVersion: z.literal(1),
  aggregateType: z.string(),
  aggregateId: z.string(),
  occurredAt: z.iso.datetime(),
  /** Correlation id propagated from the originating HTTP request for tracing. */
  correlationId: z.string().optional(),
  /** W3C trace context of the operation that caused this event, so async consumers continue the same trace. Optional + validated. */
  traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/).optional(),
  payload: z.unknown(),
});

const payment = {
  paymentId: z.string(),
  merchantId: z.string(),
  customerId: z.string(),
  amountMinor: amount,
  currency: z.string().length(3),
  /** The merchant's own reference (e.g. their order id), echoed back so webhooks can be matched to orders. Optional: added in a backward-compatible way. */
  reference: z.string().optional(),
};

export const eventPayloads = {
  'payment.created': z.object({ ...payment }),
  'payment.succeeded': z.object({ ...payment, gatewayRef: z.string() }),
  'payment.failed': z.object({ ...payment, reason: z.string() }),
  'refund.created': z.object({
    refundId: z.string(),
    paymentId: z.string(),
    merchantId: z.string(),
    amountMinor: amount,
    currency: z.string().length(3),
  }),
  'transfer.completed': z.object({
    transactionId: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    amountMinor: amount,
    currency: z.string().length(3),
  }),
} as const;

export type EventType = keyof typeof eventPayloads;
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>;
export type EventEnvelope = z.infer<typeof envelopeSchema>;

/** Validate an incoming message: envelope first, then the payload for its eventType. */
export function parseEvent(raw: unknown): { envelope: EventEnvelope; type: EventType; payload: unknown } {
  const envelope = envelopeSchema.parse(raw);
  if (!(envelope.eventType in eventPayloads)) {
    throw new Error(`Unknown event type: ${envelope.eventType}`);
  }
  const type = envelope.eventType as EventType;
  const payload = eventPayloads[type].parse(envelope.payload);
  return { envelope, type, payload };
}

/**
 * Build a validated envelope for an event. Producers call this when writing to the outbox, so an
 * invalid payload fails at write time (in the producer's transaction) and never reaches Kafka.
 */
export function makeEvent<T extends EventType>(
  type: T,
  aggregateType: string,
  aggregateId: string,
  payload: EventPayload<T>,
  opts: { eventId?: string; correlationId?: string; traceparent?: string; occurredAt?: Date } = {},
): EventEnvelope {
  eventPayloads[type].parse(payload);
  return envelopeSchema.parse({
    eventId: opts.eventId ?? crypto.randomUUID(),
    eventType: type,
    schemaVersion: 1,
    aggregateType,
    aggregateId,
    occurredAt: (opts.occurredAt ?? new Date()).toISOString(),
    correlationId: opts.correlationId,
    traceparent: opts.traceparent,
    payload,
  });
}
