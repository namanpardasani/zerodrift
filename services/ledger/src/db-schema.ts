import type { ColumnType, Generated } from 'kysely';

/** BIGINT columns: read as bigint (see @zerodrift/db type parser), write bigint or numeric string. */
type Big = ColumnType<bigint, bigint | string, bigint | string>;
/** BIGINT with a database default (optional on insert). */
type BigDefault = ColumnType<bigint, bigint | string | undefined, bigint | string>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type OwnerType = 'customer' | 'merchant' | 'system';
export type AccountType = 'wallet' | 'gateway_clearing' | 'fees' | 'suspense';
export type Direction = 'debit' | 'credit';
export type TxType = 'payment' | 'transfer' | 'refund' | 'topup' | 'fee' | 'reversal';
export type HoldStatus = 'active' | 'captured' | 'released' | 'expired';

export interface AccountsTable {
  id: Generated<string>;
  owner_type: OwnerType;
  owner_id: string;
  currency: string;
  type: AccountType;
  status: Generated<'active' | 'frozen' | 'closed'>;
  allow_negative: Generated<boolean>;
  created_at: Generated<Date>;
}
export interface AccountBalancesTable {
  account_id: string;
  available_minor: BigDefault;
  held_minor: BigDefault;
  version: BigDefault;
}
export interface LedgerTransactionsTable {
  id: Generated<string>;
  type: TxType;
  reference_id: string | null;
  idempotency_key: string;
  request_hash: string;
  status: Generated<'posted'>;
  reverses_transaction_id: string | null;
  response: ColumnType<unknown, string | null, string | null>;
  created_at: Generated<Date>;
}
export interface JournalEntriesTable {
  id: Generated<string>;
  transaction_id: string;
  account_id: string;
  direction: Direction;
  amount_minor: Big;
  currency: string;
  created_at: Generated<Date>;
}
export interface HoldsTable {
  id: Generated<string>;
  account_id: string;
  amount_minor: Big;
  captured_minor: ColumnType<bigint | null, bigint | string | null | undefined, bigint | string | null>;
  status: Generated<HoldStatus>;
  reference_id: string | null;
  idempotency_key: string;
  request_hash: string;
  expires_at: Timestamp;
  capture_transaction_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerDB {
  accounts: AccountsTable;
  account_balances: AccountBalancesTable;
  ledger_transactions: LedgerTransactionsTable;
  journal_entries: JournalEntriesTable;
  holds: HoldsTable;
}
