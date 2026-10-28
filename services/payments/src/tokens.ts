export const DB = Symbol('PAYMENTS_DB');
export const CONFIG = Symbol('PAYMENTS_CONFIG');
export const LEDGER = Symbol('LEDGER_CLIENT');
export const GATEWAY = Symbol('GATEWAY_CLIENT');

export interface PaymentsConfig {
  /** How long a hold lives. Must comfortably exceed the time recovery needs to learn the truth. */
  holdTtlSeconds: number;
  /** Exclusive per-payment work lease; a crashed worker's lease simply expires. */
  leaseSeconds: number;
  /** A payment untouched this long (and not leased) is "stuck" and picked up by recovery. */
  recoveryStuckAfterSeconds: number;
  /** Recovery gives up on a payment the gateway has never heard of after this long (cancel + fail). */
  recoveryAbandonAfterSeconds: number;
  recoveryIntervalSeconds: number;
  adminToken: string;
  gatewayCallbackSecret: string;
}
