import { z } from '@zerodrift/config';
import { minorAmountSchema } from '@zerodrift/money';

const customerId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:@-]+$/, 'letters, digits and _ . : @ - only');
const text = (max: number) => z.string().min(1).max(max);

export const createPaymentBody = z.object({
  customerId,
  amountMinor: minorAmountSchema,
  currency: z.literal('INR').default('INR'), // v1 supports INR only; currency is still a column everywhere
  reference: text(200).optional(),
  description: text(500).optional(),
});

export const createRefundBody = z.object({ amountMinor: minorAmountSchema.optional(), reason: text(500).optional() });
export const createCustomerBody = z.object({ customerId });
export const topUpBody = z.object({ amountMinor: minorAmountSchema, reference: text(200).optional() });

export const listPaymentsQuery = z.object({
  status: z.enum(['created', 'processing', 'succeeded', 'failed', 'partially_refunded', 'refunded']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.string().datetime().optional(),
});

export const createMerchantBody = z.object({
  name: text(100),
  feeBps: z.number().int().min(0).max(10_000).optional(),
  rateLimitPerMin: z.number().int().positive().max(100_000).optional(),
});

export const uuid = z.string().uuid();
