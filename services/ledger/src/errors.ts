/** Domain errors carry a stable machine-readable `code` and the HTTP status they map to. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (msg: string, details?: Record<string, unknown>) => new DomainError('validation_error', msg, 400, details),
  notFound: (what: string, id: string) => new DomainError('not_found', `${what} ${id} not found`, 404),
  insufficientFunds: (accountId: string, available: bigint, needed: bigint) =>
    new DomainError('insufficient_funds', `Account ${accountId} has insufficient funds`, 409, {
      accountId,
      available: available.toString(),
      needed: needed.toString(),
    }),
  /** Same idempotency key reused with a different request body: a client bug, 422 per spec. */
  idempotencyMismatch: (key: string) =>
    new DomainError('idempotency_key_reuse', `Idempotency key ${key} was already used with a different request`, 422),
  idempotencyKeyMissing: () => new DomainError('idempotency_key_required', 'Idempotency-Key header is required', 400),
  holdState: (id: string, status: string, wanted: string) =>
    new DomainError('invalid_hold_state', `Hold ${id} is ${status}, cannot ${wanted}`, 409),
  holdExpired: (id: string) => new DomainError('hold_expired', `Hold ${id} has expired`, 409),
  alreadyReversed: (id: string) => new DomainError('already_reversed', `Transaction ${id} was already reversed`, 409),
  notReversible: (id: string, why: string) => new DomainError('not_reversible', `Transaction ${id} ${why}`, 409),
  accountNotActive: (id: string) => new DomainError('account_not_active', `Account ${id} is not active`, 409),
  currencyMismatch: (msg: string) => new DomainError('currency_mismatch', msg, 400),
};
