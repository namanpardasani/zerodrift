import type { PaymentStatus } from './db-schema.js';

/**
 * The payment state machine. ONLY these transitions are legal:
 *
 *   created ──> processing ──> succeeded ──> partially_refunded ──> refunded
 *      │             │              └─────────────────────────────────^
 *      └──> failed <─┘
 *
 * `partially_refunded -> partially_refunded` is allowed (a second partial refund). `failed` and
 * `refunded` are terminal. Everything that changes `payments.status` goes through `assertTransition`
 * (see PaymentsRepo.transition) so a bug elsewhere cannot, say, mark a failed payment succeeded.
 */
export const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['processing', 'failed'],
  processing: ['succeeded', 'failed'],
  succeeded: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  failed: [],
  refunded: [],
};

export const ALL_STATUSES = Object.keys(TRANSITIONS) as PaymentStatus[];

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`Invalid payment transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Money has settled (or definitively not): no more saga work is needed. */
export const isSettled = (s: PaymentStatus): boolean => s !== 'created' && s !== 'processing';
