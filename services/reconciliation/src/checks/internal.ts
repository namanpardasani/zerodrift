import type { Mismatch } from '../types.js';

/** Shape of the ledger's own self-audit (`GET /internal/invariants`). */
export interface InvariantReport {
  ok: boolean;
  totalBalanceMinor: string;
  unbalancedTransactions: string[];
  balanceMismatches: { accountId: string; stored: string; fromEntries: string }[];
  heldMismatches: { accountId: string; held: string; activeHolds: string }[];
  negativeBalances: string[];
}

/**
 * Internal consistency of the books. The ledger recomputes everything from the journal with SQL;
 * here we turn each violation into a stored, reportable finding:
 *   - sum of ALL balances must be exactly 0 (money is only ever moved, never created or destroyed)
 *   - every transaction balances (debits == credits)
 *   - every account's stored balance equals credits - debits recomputed from the journal
 *   - held funds equal the sum of that account's active holds
 *   - no account below zero unless it is allowed to be
 */
export function invariantsToMismatches(r: InvariantReport): Mismatch[] {
  const out: Mismatch[] = [];
  if (r.totalBalanceMinor !== '0') {
    out.push({ kind: 'money_not_conserved', severity: 'critical', reference: 'ledger', message: `Sum of all balances is ${r.totalBalanceMinor}, it must be exactly 0: money was created or destroyed`, expected: '0', actual: r.totalBalanceMinor });
  }
  for (const id of r.unbalancedTransactions) {
    out.push({ kind: 'unbalanced_transaction', severity: 'critical', reference: id, message: `Ledger transaction ${id} has debits != credits` });
  }
  for (const m of r.balanceMismatches) {
    out.push({ kind: 'balance_mismatch', severity: 'critical', reference: m.accountId, message: `Account ${m.accountId} stored balance ${m.stored} differs from the journal (${m.fromEntries})`, expected: m.fromEntries, actual: m.stored });
  }
  for (const m of r.heldMismatches) {
    out.push({ kind: 'held_mismatch', severity: 'critical', reference: m.accountId, message: `Account ${m.accountId} holds ${m.held} but its active holds add up to ${m.activeHolds}`, expected: m.activeHolds, actual: m.held });
  }
  for (const id of r.negativeBalances) {
    out.push({ kind: 'negative_balance', severity: 'critical', reference: id, message: `Account ${id} is below zero but is not allowed to be` });
  }
  return out;
}
