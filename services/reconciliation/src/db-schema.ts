import type { ColumnType, Generated } from 'kysely';

export interface ReconRunsTable {
  id: Generated<string>;
  kind: 'internal' | 'external';
  trigger: 'scheduled' | 'manual';
  window_from: Date;
  window_to: Date;
  status: 'running' | 'clean' | 'mismatches' | 'failed';
  summary: ColumnType<unknown, string | null | undefined, string | null>;
  error: string | null;
  started_at: Generated<Date>;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface ReconMismatchesTable {
  id: Generated<string>;
  run_id: string;
  kind: string;
  severity: 'critical' | 'warning' | 'info';
  reference: string;
  message: string;
  expected: ColumnType<unknown, string | null | undefined, string | null>;
  actual: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}

export interface ReconDB {
  recon_runs: ReconRunsTable;
  recon_mismatches: ReconMismatchesTable;
}
