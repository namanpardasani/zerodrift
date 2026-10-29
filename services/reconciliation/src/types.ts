/** Shapes of the data the reconciler reads from the other services (over their internal HTTP feeds). */

export interface FeedPayment {
  id: string;
  merchantId: string;
  customerAccountId: string;
  merchantLedgerAccountId: string;
  amountMinor: string;
  feeMinor: string;
  currency: string;
  status: 'created' | 'processing' | 'succeeded' | 'failed' | 'partially_refunded' | 'refunded';
  ledgerTxId: string | null;
  refundedMinor: string;
  createdAt: string;
  updatedAt: string;
  refunds: { id: string; amountMinor: string; feeRefundMinor: string; status: 'pending' | 'succeeded' | 'failed'; ledgerTxId: string | null; updatedAt: string }[];
}

export interface LedgerTx {
  id: string;
  type: string;
  referenceId: string | null;
  createdAt: string;
  entries: { accountId: string; direction: 'debit' | 'credit'; amountMinor: string }[];
}

export interface GatewayCharge {
  reference: string;
  amountMinor: string;
  currency: string;
  status: string;
  createdAt: string;
}

export type Severity = 'critical' | 'warning' | 'info';

export type MismatchKind =
  // internal consistency of the ledger
  | 'unbalanced_transaction'
  | 'balance_mismatch'
  | 'held_mismatch'
  | 'negative_balance'
  | 'money_not_conserved'
  // payments <-> ledger
  | 'ledger_tx_missing'
  | 'ledger_amount_mismatch'
  | 'ledger_orphan_payment'
  | 'ledger_refund_missing'
  | 'ledger_orphan_refund'
  | 'stuck_payment'
  // payments <-> the bank's settlement file
  | 'missing_in_gateway'
  | 'bank_charge_without_payment'
  | 'amount_mismatch';

export interface Mismatch {
  kind: MismatchKind;
  severity: Severity;
  /** The payment / transaction / account the finding is about. Identifies the finding across passes. */
  reference: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface Window {
  from: Date;
  to: Date;
}

/** A payment counts as "money settled" once it has succeeded, including after (partial) refunds. */
export const isSettledPayment = (s: FeedPayment['status']): boolean => s === 'succeeded' || s === 'partially_refunded' || s === 'refunded';

export const inWindow = (iso: string, w: Window): boolean => {
  const t = Date.parse(iso);
  return t >= w.from.getTime() && t < w.to.getTime();
};

export const key = (m: Mismatch): string => `${m.kind}:${m.reference}`;
