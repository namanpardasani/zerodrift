import type { HandlerContext } from '@zerodrift/kafka';
import type { Transaction } from 'kysely';
import type { WebhookDB } from './db-schema.js';
import { DeliveriesService } from './deliveries.service.js';

/**
 * Kafka handler (runs inside the consumer's inbox transaction): a payment/refund event becomes one
 * delivery row per subscribed endpoint of the event's merchant. The HTTP call itself happens later
 * in the DeliveryWorker, NOT here: an HTTP call cannot be rolled back with the database
 * transaction, so doing it here would break the exactly-once effect the inbox gives us.
 * Events without a merchant (e.g. ledger transfers) are not webhook material and are skipped.
 */
export function createEventHandler(deliveries: DeliveriesService) {
  return async (ctx: HandlerContext): Promise<void> => {
    const merchantId = (ctx.payload as { merchantId?: string }).merchantId;
    if (!merchantId) return;
    await deliveries.enqueueForEvent(ctx.trx as Transaction<WebhookDB>, ctx.event, merchantId);
  };
}
