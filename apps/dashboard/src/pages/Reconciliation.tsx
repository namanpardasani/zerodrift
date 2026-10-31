import { Badge, Button, Card, DataTable, ErrorNote, KeyValue, PageHeader, Skeleton, StatusBadge, Zipper, type ZipRow, formatTime, timeAgo } from '@zerodrift/ui';
import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { Finding, Run } from '../types.js';

/**
 * Findings as a zipper: "expected" (what one side says) against "actual". A finding with both sides is drawn as a
 * mismatch row with its explanation; the matched total is the number of records checked minus the findings.
 */
function toZipRows(findings: Finding[]): ZipRow[] {
  const show = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return findings.map((m) => ({ ref: m.reference.length > 18 ? `${m.reference.slice(0, 8)}…` : m.reference, left: show(m.expected), right: show(m.actual), note: `${m.message}. Flagged for review, nothing changed automatically.` }));
}

function RunDetail({ id }: { id: string }) {
  const { data: run, error, loading } = useApi<Run>(`/api/recon/runs/${id}`);
  if (loading && !run) return <Skeleton rows={5} />;
  if (!run) return <ErrorNote error={error ?? 'Not found'} />;
  const findings = run.mismatches ?? [];
  const checked = run.summary ? run.summary.paymentsChecked + run.summary.gatewayChargesChecked : 0;
  const leftTitle = run.kind === 'internal' ? 'our ledger' : 'our payments';
  const rightTitle = run.kind === 'internal' ? 'our payments' : 'gateway report';
  return (
    <div className="space-y-5">
      <KeyValue items={[
        ['Window', `${formatTime(run.windowFrom)} → ${formatTime(run.windowTo)}`],
        ['Trigger', run.trigger],
        ['Checked', run.summary ? `${run.summary.paymentsChecked} payments · ${run.summary.ledgerTransactionsChecked} ledger txs · ${run.summary.gatewayChargesChecked} bank charges` : '-'],
        ...(run.error ? ([['Error', <span key="e" className="text-failed-ink">{run.error}</span>]] as [string, React.ReactNode][]) : []),
      ]} />
      {findings.length === 0 ? (
        <p className="text-sm text-muted">{run.status === 'failed' ? 'The run could not read its data sources, so it says nothing about correctness.' : 'No findings: everything agrees.'}</p>
      ) : (
        <Zipper key={run.id} rows={toZipRows(findings)} leftTitle={leftTitle} rightTitle={rightTitle} />
      )}
      <p className="mono text-[13px] text-ink-2">{checked > 0 ? `${Math.max(0, checked - findings.length)} matched · ` : ''}{findings.length} {findings.length === 1 ? 'mismatch' : 'mismatches'} flagged for review</p>
      {findings.length > 0 && (
        <DataTable
          rows={findings}
          rowKey={(m) => m.id}
          columns={[
            { header: 'severity', cell: (m) => <StatusBadge status={m.severity} /> },
            { header: 'kind', cell: (m) => <Badge>{m.kind.replace(/_/g, ' ')}</Badge> },
            { header: 'finding', cell: (m) => <span className="text-[13px]">{m.message}</span> },
          ]}
        />
      )}
    </div>
  );
}

export function ReconciliationPage() {
  const runs = useApi<{ runs: Run[] }>('/api/recon/runs?limit=30', { pollMs: 5000 });
  const latest = useApi<{ internal: Run | null; external: Run | null }>('/api/recon/latest', { pollMs: 5000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  async function start(kind: 'internal' | 'external') {
    setRunning(kind);
    setError(null);
    try {
      const r = await api<Run>('/api/recon/runs', { method: 'POST', body: { kind } });
      setSelected(r.id);
      runs.reload();
      latest.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setRunning(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Our books, their report, side by side. Internal: the ledger balances and matches the payments. External: payments match the bank’s settlement file. Anything that does not match is flagged, never silently fixed."
        actions={<>
          <Button variant="primary" onClick={() => start('internal')} disabled={!!running}>{running === 'internal' ? 'Running…' : 'Run internal'}</Button>
          <Button variant="primary" onClick={() => start('external')} disabled={!!running}>{running === 'external' ? 'Running…' : 'Run external'}</Button>
        </>}
      />
      {error && <div className="mb-4"><ErrorNote error={error} /></div>}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(['internal', 'external'] as const).map((k) => {
          const r = latest.data?.[k];
          return (
            <Card key={k} title={`Latest ${k} run`} actions={r && <StatusBadge status={r.status} />}>
              {r ? (
                <div className="text-sm text-muted">
                  {timeAgo(r.startedAt)} · {r.summary ? `${r.summary.paymentsChecked} payments checked` : r.error}
                  {r.mismatches && r.mismatches.length > 0 && <span className="ml-2 text-failed-ink">{r.mismatches.length} finding(s)</span>}
                </div>
              ) : <span className="text-sm text-muted">No run yet.</span>}
            </Card>
          );
        })}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Runs" className="overflow-hidden [&>div]:p-0">
          {runs.error && <ErrorNote error={runs.error} onRetry={runs.reload} />}
          <DataTable
            rows={runs.data?.runs ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r.id)}
            empty="No runs yet."
            columns={[
              { header: 'when', cell: (r) => <span className="mono text-[13px]" title={formatTime(r.startedAt)}>{timeAgo(r.startedAt)}</span> },
              { header: 'kind', cell: (r) => r.kind },
              { header: 'status', cell: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
        </Card>
        <Card title={selected ? 'Run report' : 'Run report (select a run)'}>
          {selected ? <RunDetail id={selected} /> : <p className="text-sm text-muted">Select a run to see its findings: what each side says, side by side.</p>}
        </Card>
      </div>
    </>
  );
}
