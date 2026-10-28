import { DomainError } from '@zerodrift/common';

export { DomainError };

export const Errors = {
  validation: (msg: string, details?: Record<string, unknown>) => new DomainError('validation_error', msg, 400, details),
  unauthorized: () => new DomainError('unauthorized', 'Missing or invalid API key', 401),
  forbidden: () => new DomainError('forbidden', 'Not allowed', 403),
  notFound: (what: string, id: string) => new DomainError('not_found', `${what} ${id} not found`, 404),
  idempotencyKeyMissing: () => new DomainError('idempotency_key_required', 'Idempotency-Key header is required', 400),
  /** Same key, different request body: a client bug. 422 per the brief. */
  idempotencyMismatch: (key: string) =>
    new DomainError('idempotency_key_reuse', `Idempotency key ${key} was already used with a different request`, 422),
  /** Same key, same request, first one still running: never execute twice; ask the client to retry. */
  requestInProgress: () =>
    new DomainError('request_in_progress', 'A request with this idempotency key is still being processed', 409, { retryAfterSeconds: 1 }),
  paymentNotRefundable: (id: string, status: string) =>
    new DomainError('payment_not_refundable', `Payment ${id} is ${status} and cannot be refunded`, 409),
  refundExceedsPayment: (refundable: bigint) =>
    new DomainError('refund_exceeds_payment', 'Refund amount exceeds the refundable balance', 409, { refundableMinor: refundable.toString() }),
  ledgerUnavailable: () => new DomainError('ledger_unavailable', 'Ledger is temporarily unavailable, retry with the same Idempotency-Key', 503),
  rateLimited: (retryAfterSeconds: number) =>
    new DomainError('rate_limited', 'Too many requests', 429, { retryAfterSeconds }),
};
