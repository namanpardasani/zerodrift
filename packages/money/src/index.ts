/**
 * Money utilities. Every amount is an integer number of MINOR units (paise for INR) held in a
 * bigint. `number` is never used for money: floats cannot represent 0.1 exactly, and even integer
 * `number`s silently lose precision above 2^53.
 */

import { z } from 'zod';

export type Minor = bigint;

/** Postgres BIGINT max; ledger amounts must fit so they round-trip to the database safely. */
export const MAX_MINOR = 9_223_372_036_854_775_807n;

export class MoneyError extends Error {}

/** Accepts bigint, or a base-10 integer string ("12345"). Rejects floats, negatives, overflow. */
export function parseMinor(input: unknown): Minor {
  let value: bigint;
  if (typeof input === 'bigint') value = input;
  else if (typeof input === 'string' && /^-?\d+$/.test(input)) value = BigInt(input);
  else throw new MoneyError(`Amount must be an integer in minor units, got ${String(input)}`);
  if (value < 0n) throw new MoneyError('Amount must not be negative');
  if (value > MAX_MINOR) throw new MoneyError('Amount exceeds maximum');
  return value;
}

export function assertPositive(amount: Minor): Minor {
  if (amount <= 0n) throw new MoneyError('Amount must be greater than zero');
  return amount;
}

/**
 * Fee in basis points (1 bp = 0.01%). RULE: round HALF UP to the nearest paisa, computed purely in
 * integers: (amount * bps + 5000) / 10000. The fee can never exceed the amount.
 */
export function feeFor(amount: Minor, bps: number): Minor {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError('Fee basis points must be an integer between 0 and 10000');
  }
  const fee = (amount * BigInt(bps) + 5_000n) / 10_000n; // bigint division truncates; +5000 = half up
  return fee > amount ? amount : fee;
}

/** Split `amount` into the platform fee and the merchant's net. fee + net === amount, always. */
export function splitFee(amount: Minor, bps: number): { fee: Minor; net: Minor } {
  const fee = feeFor(amount, bps);
  return { fee, net: amount - fee };
}

/**
 * Proportional refund of a fee: when a payment is partially refunded the platform returns the
 * fee share rounded DOWN (the platform never over-refunds). Full refund returns the whole fee.
 */
export function proportionalFee(fee: Minor, refunded: Minor, total: Minor): Minor {
  if (total <= 0n) throw new MoneyError('Total must be positive');
  if (refunded >= total) return fee;
  return (fee * refunded) / total;
}

/** Format for humans/logs only ("₹1,234.50"); never parse this back. */
export function formatInr(amount: Minor): string {
  const rupees = amount / 100n;
  const paise = (amount % 100n).toString().padStart(2, '0');
  return `₹${rupees.toLocaleString('en-IN')}.${paise}`;
}

/** JSON.stringify cannot serialise bigint; amounts cross the wire as decimal strings. */
export const minorToString = (m: Minor): string => m.toString();

/**
 * Zod schema for an amount in an HTTP body: an integer string ("12500") or safe integer (12500),
 * becoming a positive bigint. Floats, negatives, zero and overflow are rejected. Shared so every
 * service validates money identically.
 */
export const minorAmountSchema = z
  .union([z.string().regex(/^\d+$/, 'must be an integer in minor units'), z.number().int().safe()])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'must be greater than zero')
  .refine((v) => v <= MAX_MINOR, 'exceeds maximum');
