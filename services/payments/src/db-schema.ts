import type { ColumnType, Generated } from 'kysely';

type Big = ColumnType<bigint, bigint | string, bigint | string>;
type BigDefault = ColumnType<bigint, bigint | string | undefined, bigint | string>;

export type PaymentStatus = 'created' | 'processing' | 'succeeded' | 'failed' | 'partially_refunded' | 'refunded';
export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export interface MerchantsTable {
  id: string;
  name: string;
  api_key_hash: string;
  api_key_prefix: string;
  rate_limit_per_min: Generated<number>;
  fee_bps: Generated<number>;
  ledger_account_id: string;
  status: Generated<'active' | 'disabled'>;
  created_at: Generated<Date>;
}

export interface PaymentsTable {
  id: Generated<string>;
  merchant_id: string;
  customer_id: string;
  customer_account_id: string;
  amount_minor: Big;
  currency: Generated<string>;
  status: PaymentStatus;
  reference: string | null;
  description: string | null;
  gateway_ref: string | null;
  idempotency_key: string;
  failure_reason: string | null;
  hold_id: string | null;
  ledger_tx_id: string | null;
  fee_bps: number;
  fee_minor: Big;
  refund_reserved_minor: BigDefault;
  fee_refund_reserved_minor: BigDefault;
  refunded_minor: BigDefault;
  lease_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  version: BigDefault;
}

export interface PaymentEventsTable {
  id: Generated<string>;
  payment_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  created_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  merchant_id: string;
  key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  resource_type: string | null;
  resource_id: string | null;
  response_status: number | null;
  response_snapshot: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: Generated<Date>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

export interface RefundsTable {
  id: Generated<string>;
  payment_id: string;
  amount_minor: Big;
  fee_refund_minor: Big;
  status: RefundStatus;
  reason: string | null;
  failure_reason: string | null;
  idempotency_key: string;
  ledger_tx_id: string | null;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface OutboxTable {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: ColumnType<unknown, string, string>;
  created_at: Generated<Date>;
  published_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface PaymentsDB {
  merchants: MerchantsTable;
  payments: PaymentsTable;
  payment_events: PaymentEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  refunds: RefundsTable;
  outbox: OutboxTable;
}
