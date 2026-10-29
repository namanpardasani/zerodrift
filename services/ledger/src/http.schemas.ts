import { z } from '@zerodrift/config';
import { MAX_MINOR } from '@zerodrift/money';

/**
 * Amounts arrive as integer strings ("12500") or safe integers (12500) and become bigint.
 * Floats, negatives, zero and anything above BIGINT max are rejected.
 */
export const amount = z
  .union([z.string().regex(/^\d+$/, 'must be an integer in minor units'), z.number().int().safe()])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'must be greater than zero')
  .refine((v) => v <= MAX_MINOR, 'exceeds maximum');

const id = z.string().uuid();
const feeBps = z.number().int().min(0).max(10_000);
const reference = z.string().min(1).max(200);

export const createAccountBody = z.object({
  ownerType: z.enum(['customer', 'merchant']), // system accounts are created by the service itself
  ownerId: z.string().min(1).max(200),
  currency: z.string().length(3).default('INR'),
});

export const topUpBody = z.object({ accountId: id, amountMinor: amount, referenceId: reference.optional() });

export const transferBody = z.object({
  fromAccountId: id,
  toAccountId: id,
  amountMinor: amount,
  feeBps: feeBps.optional(),
  feeAccountId: id.optional(),
  referenceId: reference.optional(),
});

export const reverseBody = z.object({ referenceId: reference.optional() });

export const createHoldBody = z.object({
  accountId: id,
  amountMinor: amount,
  referenceId: reference.optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

export const captureBody = z.object({
  toAccountId: id,
  amountMinor: amount.optional(),
  feeBps: feeBps.optional(),
  feeAccountId: id.optional(),
  referenceId: reference.optional(),
});

export const listAccountsQuery = z.object({
  ownerType: z.enum(['customer', 'merchant', 'system']).optional(),
  ownerId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const entriesQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  before: z.string().datetime().optional(),
});

export const idParam = id;

export const postTransactionBody = z.object({
  type: z.enum(['payment', 'transfer', 'refund', 'fee']),
  referenceId: reference.optional(),
  entries: z
    .array(z.object({ accountId: id, direction: z.enum(['debit', 'credit']), amountMinor: amount }))
    .min(2)
    .max(20),
});

export const listTransactionsQuery = z.object({
  type: z.enum(['payment', 'transfer', 'refund', 'topup', 'fee', 'reversal']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  after: z.string().max(100).optional(),
  limit: z.coerce.number().int().positive().max(2_000).optional(),
  /** 'desc' = newest first (dashboards); default is oldest first (reconciliation). */
  order: z.enum(['asc', 'desc']).optional(),
});
