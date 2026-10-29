import { registry } from '@zerodrift/common';
import { type Kysely, sql } from 'kysely';
import type { Pool } from 'pg';
import { Counter, Gauge } from 'prom-client';
import { invariantsToMismatches } from './checks/internal.js';
import { compareToSettlement } from './checks/external.js';
import { comparePaymentsToLedger, dedupe } from './checks/payments-ledger.js';
import type { ReconDB } from './db-schema.js';
import { SourceUnavailable, type Sources } from './sources.js';
import { type Mismatch, type Window, key } from './types.js';

export type RunKind = 'internal' | 'external';

export interface ReconConfig {
  /** Records newer than this are still settling; they are left out of a run so in-flight work is not misreported. */
  graceMs: number;
  /** A payment still created/processing after this long is flagged as stuck. */
  stuckAfterMs: number;
  /** Two passes this far apart must BOTH see a finding before it is reported (filters transient states). */
  confirmDelayMs: number;
  /** How far beyond the window records are fetched for lookups (day-boundary safety). */
  paddingMs: number;
}

export const DEFAULT_RECON_CONFIG: ReconConfig = { graceMs: 60_000, stuckAfterMs: 5 * 60_000, confirmDelayMs: 3_000, paddingMs: 24 * 3_600_000 };

export interface RunSummary {
  paymentsChecked: number;
  ledgerTransactionsChecked: number;
  gatewayChargesChecked: number;
  mismatchesBySeverity: Record<string, number>;
  mismatchesByKind: Record<string, number>;
  invariants?: { totalBalanceMinor: string };
}

export interface RunView {
  id: string;
  kind: RunKind;
  trigger: 'scheduled' | 'manual';
  windowFrom: string;
  windowTo: string;
  status: 'running' | 'clean' | 'mismatches' | 'failed';
  summary: RunSummary | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  mismatches?: (Mismatch & { id: string })[];
}

const runsTotal = new Counter({ name: 'recon_runs_total', help: 'Reconciliation runs by kind and outcome', labelNames: ['kind', 'status'], registers: [registry] });
const openMismatches = new Gauge({ name: 'recon_open_mismatches', help: 'Findings in the latest run, by kind and severity', labelNames: ['kind', 'severity'], registers: [registry] });
const lastRun = new Gauge({ name: 'recon_last_run_timestamp_seconds', help: 'Unix time the last run of this kind finished', labelNames: ['kind'], registers: [registry] });

const LOCK_IDS: Record<RunKind, number> = { internal: 75_001, external: 75_002 };
const DAY = 24 * 3_600_000;
const utcDate = (d: Date) => d.toISOString().slice(0, 10);

/** Every UTC date that overlaps [from, to]. */
export function datesBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= to.getTime(); t += DAY) out.push(utcDate(new Date(t)));
  return out;
}

/**
 * Runs reconciliations and stores the reports.
 *
 *  internal: the ledger's self-audit (balanced, conserved, balances == journal, holds)
 *            + payments <-> ledger (every settled payment has exactly its ledger movement, no orphans)
 *  external: payments <-> the bank's settlement file
 *
 * Properties worth knowing:
 *  - ONE run of a kind at a time across all replicas: a Postgres session advisory lock is held for
 *    the duration; a second caller gets `null` ("already running") instead of a duplicate report.
 *  - A source being down makes the run FAIL (with the error); we never report clean or fabricate
 *    mismatches for data we could not read.
 *  - Transient states are not reported: a run takes the findings of two passes `confirmDelayMs`
 *    apart and keeps only those present in BOTH, so a payment mid-flight does not raise an alarm.
 */
export class Reconciler {
  constructor(
    private readonly db: Kysely<ReconDB>,
    private readonly pool: Pool,
    private readonly sources: Sources,
    private readonly config: ReconConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Returns the finished run, or null if another run of this kind holds the lock. */
  async run(kind: RunKind, opts: { from?: Date; to?: Date; trigger?: 'scheduled' | 'manual' } = {}): Promise<RunView | null> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_IDS[kind]]);
      if (!lock.rows[0]?.ok) return null;
      try {
        return await this.execute(kind, opts);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_IDS[kind]]);
      }
    } finally {
      client.release();
    }
  }

  private defaultWindow(): Window {
    const now = this.now();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { from: dayStart, to: new Date(dayStart.getTime() + DAY) };
  }

  private async execute(kind: RunKind, opts: { from?: Date; to?: Date; trigger?: 'scheduled' | 'manual' }): Promise<RunView> {
    const requested = opts.from && opts.to ? { from: opts.from, to: opts.to } : this.defaultWindow();
    // leave out records that are still settling
    const window: Window = { from: requested.from, to: new Date(Math.min(requested.to.getTime(), this.now().getTime() - this.config.graceMs)) };

    const run = await this.db
      .insertInto('recon_runs')
      .values({ kind, trigger: opts.trigger ?? 'manual', window_from: window.from, window_to: window.to, status: 'running', summary: null, error: null })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const first = await this.pass(kind, window);
      let confirmed = first.mismatches;
      let latest = first;
      if (first.mismatches.length > 0 && this.config.confirmDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.config.confirmDelayMs));
        latest = await this.pass(kind, window);
        const firstKeys = new Set(first.mismatches.map(key));
        confirmed = latest.mismatches.filter((m) => firstKeys.has(key(m)));
      }
      const bySeverity: Record<string, number> = {};
      const byKind: Record<string, number> = {};
      for (const m of confirmed) {
        bySeverity[m.severity] = (bySeverity[m.severity] ?? 0) + 1;
        byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      }
      const summary: RunSummary = { ...latest.counts, mismatchesBySeverity: bySeverity, mismatchesByKind: byKind, ...(latest.totalBalanceMinor ? { invariants: { totalBalanceMinor: latest.totalBalanceMinor } } : {}) };
      const reportable = confirmed.filter((m) => m.severity !== 'info');
      const status = reportable.length === 0 ? 'clean' : 'mismatches';

      await this.db.transaction().execute(async (trx) => {
        if (confirmed.length) {
          await trx
            .insertInto('recon_mismatches')
            .values(confirmed.map((m) => ({ run_id: run.id, kind: m.kind, severity: m.severity, reference: m.reference, message: m.message, expected: m.expected === undefined ? null : JSON.stringify(m.expected), actual: m.actual === undefined ? null : JSON.stringify(m.actual) })))
            .execute();
        }
        await trx.updateTable('recon_runs').set({ status, summary: JSON.stringify(summary), finished_at: sql`now()` as never }).where('id', '=', run.id).execute();
      });
      this.record(kind, status, bySeverity);
    } catch (err) {
      const message = err instanceof SourceUnavailable ? err.message : `unexpected error: ${(err as Error).message}`;
      await this.db.updateTable('recon_runs').set({ status: 'failed', error: message, finished_at: sql`now()` as never }).where('id', '=', run.id).execute();
      this.record(kind, 'failed', {});
    }
    return this.getRun(run.id, true);
  }

  private record(kind: RunKind, status: string, bySeverity: Record<string, number>) {
    runsTotal.inc({ kind, status });
    lastRun.set({ kind }, Date.now() / 1000);
    for (const sev of ['critical', 'warning', 'info']) openMismatches.set({ kind, severity: sev }, bySeverity[sev] ?? 0);
  }

  /** One full comparison pass. */
  private async pass(kind: RunKind, window: Window): Promise<{ mismatches: Mismatch[]; counts: Pick<RunSummary, 'paymentsChecked' | 'ledgerTransactionsChecked' | 'gatewayChargesChecked'>; totalBalanceMinor?: string }> {
    const now = this.now();
    const padded = { from: new Date(window.from.getTime() - this.config.paddingMs), to: new Date(window.to.getTime() + this.config.paddingMs) };
    const payments = await this.sources.payments(padded.from, padded.to);
    const inScope = payments.filter((p) => Date.parse(p.createdAt) >= window.from.getTime() && Date.parse(p.createdAt) < window.to.getTime());

    if (kind === 'external') {
      const charges = await this.sources.settlement(datesBetween(padded.from, padded.to));
      const mismatches = compareToSettlement(payments, charges, { window });
      return { mismatches, counts: { paymentsChecked: inScope.length, ledgerTransactionsChecked: 0, gatewayChargesChecked: charges.filter((c) => Date.parse(c.createdAt) >= window.from.getTime() && Date.parse(c.createdAt) < window.to.getTime()).length } };
    }

    const [invariants, paymentTxs, refundTxs] = await Promise.all([
      this.sources.invariants(),
      this.sources.ledgerTransactions('payment', padded.from, padded.to),
      this.sources.ledgerTransactions('refund', padded.from, padded.to),
    ]);
    const ledgerTxs = [...paymentTxs, ...refundTxs];
    const mismatches = dedupe([...invariantsToMismatches(invariants), ...comparePaymentsToLedger(payments, ledgerTxs, { window, now, stuckAfterMs: this.config.stuckAfterMs })]);
    return { mismatches, totalBalanceMinor: invariants.totalBalanceMinor, counts: { paymentsChecked: inScope.length, ledgerTransactionsChecked: ledgerTxs.length, gatewayChargesChecked: 0 } };
  }

  // ------------------------------------------------------------------ reading reports

  async getRun(id: string, withMismatches = false): Promise<RunView> {
    const r = await this.db.selectFrom('recon_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const view: RunView = {
      id: r.id,
      kind: r.kind,
      trigger: r.trigger,
      windowFrom: r.window_from.toISOString(),
      windowTo: r.window_to.toISOString(),
      status: r.status,
      summary: (r.summary as RunSummary | null) ?? null,
      error: r.error,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
    };
    if (withMismatches) {
      const ms = await this.db.selectFrom('recon_mismatches').selectAll().where('run_id', '=', id).orderBy('id').execute();
      // ids are bigserial: @zerodrift/db parses BIGINT to bigint (money safety), which JSON cannot serialise
      view.mismatches = ms.map((m) => ({ id: String(m.id), kind: m.kind as Mismatch['kind'], severity: m.severity, reference: m.reference, message: m.message, expected: m.expected ?? undefined, actual: m.actual ?? undefined }));
    }
    return view;
  }

  async listRuns(q: { kind?: RunKind; limit?: number }): Promise<RunView[]> {
    let query = this.db.selectFrom('recon_runs').select('id').orderBy('started_at', 'desc').limit(Math.min(q.limit ?? 50, 200));
    if (q.kind) query = query.where('kind', '=', q.kind);
    const ids = await query.execute();
    return Promise.all(ids.map((i) => this.getRun(i.id)));
  }

  /** Latest finished run of each kind: what the dashboard shows at a glance. */
  async latest(): Promise<Record<RunKind, RunView | null>> {
    const out: Record<RunKind, RunView | null> = { internal: null, external: null };
    for (const kind of ['internal', 'external'] as const) {
      const row = await this.db.selectFrom('recon_runs').select('id').where('kind', '=', kind).where('status', '!=', 'running').orderBy('started_at', 'desc').limit(1).executeTakeFirst();
      out[kind] = row ? await this.getRun(row.id, true) : null;
    }
    return out;
  }
}
