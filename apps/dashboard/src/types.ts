export interface Account { id: string; ownerType: string; ownerId: string; currency: string; type: string; status: string; allowNegative: boolean; availableMinor: string; heldMinor: string; createdAt: string }
export interface Entry { id: string; transactionId: string; direction: 'debit' | 'credit'; amountMinor: string; currency: string; createdAt: string }
export interface LedgerTx { id: string; type: string; referenceId: string | null; createdAt: string; entries: { accountId: string; direction: 'debit' | 'credit'; amountMinor: string }[] }
export interface Payment { id: string; merchantId: string; merchantName: string; customerId: string; amountMinor: string; currency: string; status: string; reference: string | null; failureReason: string | null; feeMinor: string; refundedMinor: string; ledgerTxId: string | null; createdAt: string; updatedAt: string; events?: { fromStatus: string | null; toStatus: string; reason: string | null; at: string }[]; refunds?: { id: string; amountMinor: string; feeRefundMinor: string; status: string; reason: string | null; failureReason: string | null; createdAt: string }[] }
export interface Delivery { id: string; eventId: string; eventType: string; endpointId: string; endpointUrl: string; status: string; attemptCount: number; replayCount: number; nextAttemptAt: string | null; lastResponseCode: number | null; lastError: string | null; createdAt: string; attempts?: { attemptNo: number; startedAt: string; durationMs: number; responseCode: number | null; error: string | null; responseSnippet: string | null }[] }
export interface Endpoint { id: string; merchantId: string; url: string; description: string | null; eventTypes: string[]; active: boolean; createdAt: string }
export interface Finding { id: string; kind: string; severity: string; reference: string; message: string; expected?: unknown; actual?: unknown }
export interface Run { id: string; kind: 'internal' | 'external'; trigger: string; windowFrom: string; windowTo: string; status: string; summary: { paymentsChecked: number; ledgerTransactionsChecked: number; gatewayChargesChecked: number; mismatchesBySeverity: Record<string, number> } | null; error: string | null; startedAt: string; finishedAt: string | null; mismatches?: Finding[] }
export interface Overview {
  services: { name: string; up: boolean; latencyMs: number | null }[];
  payments: { byStatus: Record<string, number>; last24hByStatus: Record<string, number>; inFlight: { count: number; oldestSeconds: number } } | null;
  webhooks: Record<string, number> | null;
  reconciliation: { internal: Run | null; external: Run | null } | null;
  ledgerInvariants: { ok: boolean; totalBalanceMinor: string } | null;
}
export interface MetricsSummary { available: boolean; series: Record<string, { labels: Record<string, string>; value: number }[]> }
export interface ChaosStatus {
  enabled: boolean;
  services?: { service: string; state: string; status: string }[];
  gateway?: Record<string, number> | { error: string };
  network?: { name: string; listen: string; upstream: string; enabled: boolean; toxics: { name: string; type: string; attributes: Record<string, number> }[] }[] | { error: string };
}
