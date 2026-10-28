import { z } from '@zerodrift/config';

const eventType = z.string().regex(/^(\*|[a-z]+\.[a-z_]+)$/, "event type like 'payment.succeeded' or '*'");

export const createEndpointBody = z.object({
  url: z.string().url().max(2_000),
  description: z.string().min(1).max(200).optional(),
  eventTypes: z.array(eventType).max(20).optional(),
});

export const updateEndpointBody = z.object({
  url: z.string().url().max(2_000).optional(),
  description: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
  eventTypes: z.array(eventType).max(20).optional(),
});

export const listDeliveriesQuery = z.object({
  status: z.enum(['pending', 'succeeded', 'dead']).optional(),
  endpointId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const uuid = z.string().uuid();
