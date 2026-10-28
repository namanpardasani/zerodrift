import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import type { LedgerDB } from './db-schema.js';
import { DB } from './tokens.js';

export interface InvariantReport {
  ok: boolean;
  checkedAt: string;
  /** Sum of (available + held) over ALL accounts. Must be exactly 0: money is only ever moved. */
  totalBalanceMinor: string;
  unbalancedTransactions: string[];
  balanceMismatches: { accountId: string; stored: string; fromEntries: string }[];
  heldMismatches: { accountId: string; held: string; activeHolds: string }[];
  negativeBalances: string[];
}

/**
 * Self-audit of the books, computed from scratch with SQL. Used by tests, the reconciliation
 * service (over HTTP, since services never read each other's tables) and the chaos checker.
 */
@Injectable()
export class InvariantsService {
  constructor(@Inject(DB) private readonly db: Kysely<LedgerDB>) {}

  async check(): Promise<InvariantReport> {
    const unbalanced = await sql<{ transaction_id: string }>`
      SELECT transaction_id FROM journal_entries
      GROUP BY transaction_id
      HAVING SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`.execute(this.db);

    // Stored balance (available + held) must equal credits - debits recomputed from the journal.
    const mismatches = await sql<{ account_id: string; stored: string; computed: string }>`
      SELECT b.account_id,
             (b.available_minor + b.held_minor)::text AS stored,
             COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS computed
      FROM account_balances b
      LEFT JOIN journal_entries e ON e.account_id = b.account_id
      GROUP BY b.account_id, b.available_minor, b.held_minor
      HAVING (b.available_minor + b.held_minor) <>
             COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0)`.execute(this.db);

    // held_minor must equal the sum of that account's active holds.
    const held = await sql<{ account_id: string; held: string; active: string }>`
      SELECT b.account_id, b.held_minor::text AS held,
             COALESCE(SUM(h.amount_minor) FILTER (WHERE h.status = 'active'), 0)::text AS active
      FROM account_balances b
      LEFT JOIN holds h ON h.account_id = b.account_id
      GROUP BY b.account_id, b.held_minor
      HAVING b.held_minor <> COALESCE(SUM(h.amount_minor) FILTER (WHERE h.status = 'active'), 0)`.execute(this.db);

    const negative = await sql<{ account_id: string }>`
      SELECT b.account_id FROM account_balances b JOIN accounts a ON a.id = b.account_id
      WHERE b.available_minor < 0 AND NOT a.allow_negative`.execute(this.db);

    const total = await sql<{ total: string }>`
      SELECT COALESCE(SUM(available_minor + held_minor), 0)::text AS total FROM account_balances`.execute(this.db);

    const report: InvariantReport = {
      ok: false,
      checkedAt: new Date().toISOString(),
      totalBalanceMinor: total.rows[0]!.total,
      unbalancedTransactions: unbalanced.rows.map((r) => r.transaction_id),
      balanceMismatches: mismatches.rows.map((r) => ({ accountId: r.account_id, stored: r.stored, fromEntries: r.computed })),
      heldMismatches: held.rows.map((r) => ({ accountId: r.account_id, held: r.held, activeHolds: r.active })),
      negativeBalances: negative.rows.map((r) => r.account_id),
    };
    report.ok =
      report.totalBalanceMinor === '0' &&
      report.unbalancedTransactions.length === 0 &&
      report.balanceMismatches.length === 0 &&
      report.heldMismatches.length === 0 &&
      report.negativeBalances.length === 0;
    return report;
  }
}
