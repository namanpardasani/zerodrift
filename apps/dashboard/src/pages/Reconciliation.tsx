import { Badge, Button, Card, DataTable, ErrorNote, KeyValue, PageHeader, Spinner, StatusBadge, formatTime, timeAgo } from '@zerodrift/ui';
import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { Run } from '../types.js';

function RunDetail({ id }: { id: string }) {
  const { data: run, error, loading } = useApi<Run>(`/api/recon/runs/${id}`);
  if (loading && !run) return <Spinner />;
  if (!run) return <ErrorNote error={error ?? 'Not found'} />;
  return (
    <div className="space-y-4">
      <KeyValue items={[
        ['Window', `${formatTime(run.windowFrom)} → ${formatTime(run.windowTo)}`],
        ['Trigger', run.trigger],
        ['Checked', run.summary ? `${run.summary.paymentsChecked} payments · ${run.summary.ledgerTransactionsChecked} ledger txs · ${run.summary.gatewayChargesChecked} bank charges` : '-'],
        ...(run.error ? ([['Error', <span key="e" className="text-danger">{run.error}</span>]] as [string, React.ReactNode][]) : []),
      ]} />
      <DataTable
        rows={run.mismatches ?? []}
        rowKey={(m) => m.id}
        empty={run.status === 'failed' ? 'The run could not read its data sources, so it says nothing about correctness.' : 'No findings: everything agrees.'}
        columns={[
          { header: 'Severity', cell: (m) => <StatusBadge status={m.severity} /> },
          { header: 'Kind', cell: (m) => <Badge>{m.kind.replace(/_/g, ' ')}</Badge> },
          { header: 'Finding', cell: (m) => (
            <div>
              <div>{m.message}</div>
              {(m.expected !== undefined || m.actual !== undefined) && <div className="mt-1 font-mono text-xs text-muted">expected {JSON.stringify(m.expected)} · actual {JSON.stringify(m.actual)}</div>}
            </div>
          ) },
        ]}
      />
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
        subtitle="Do the ledger, the payments and the bank all agree? Internal: books balance and match the payments. External: payments match the bank's settlement file."
        actions={<>
          <Button variant="primary" onClick={() => start('internal')} disabled={!!running}>{running === 'internal' ? 'Running…' : 'Run internal'}</Button>
          <Button variant="primary" onClick={() => start('external')} disabled={!!running}>{running === 'external' ? 'Running…' : 'Run external'}</Button>
        </>}
      />
      {error && <div className="mb-4"><ErrorNote error={error} /></div>}
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {(['internal', 'external'] as const).map((k) => {
          const r = latest.data?.[k];
          return (
            <Card key={k} title={`Latest ${k} run`} actions={r && <StatusBadge status={r.status} />}>
              {r ? (
                <div className="text-sm text-muted">
                  {timeAgo(r.startedAt)} · {r.summary ? `${r.summary.paymentsChecked} payments checked` : r.error}
                  {r.mismatches && r.mismatches.length > 0 && <span className="ml-2 text-danger">{r.mismatches.length} finding(s)</span>}
                </div>
              ) : <span className="text-sm text-muted">No run yet.</span>}
            </Card>
          );
        })}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Runs">
          {runs.error && <ErrorNote error={runs.error} onRetry={runs.reload} />}
          <DataTable
            rows={runs.data?.runs ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r.id)}
            empty="No runs yet."
            columns={[
              { header: 'When', cell: (r) => <span title={formatTime(r.startedAt)}>{timeAgo(r.startedAt)}</span> },
              { header: 'Kind', cell: (r) => r.kind },
              { header: 'Trigger', cell: (r) => <span className="text-muted">{r.trigger}</span> },
              { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
        </Card>
        <Card title={selected ? 'Run report' : 'Run report (select a run)'}>
          {selected ? <RunDetail id={selected} /> : <p className="text-sm text-muted">Select a run to see its findings with expected vs actual values.</p>}
        </Card>
      </div>
    </>
  );
}
