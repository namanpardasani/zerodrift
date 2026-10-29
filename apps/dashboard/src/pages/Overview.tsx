import { Card, ErrorNote, PageHeader, Spinner, Stat, StatusBadge } from '@zerodrift/ui';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import type { Overview } from '../types.js';

export function OverviewPage() {
  const { data, error, loading, reload } = useApi<Overview>('/api/overview', { pollMs: 5000 });
  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorNote error={error ?? 'No data'} onRetry={reload} />;

  const day = data.payments?.last24hByStatus ?? {};
  const total24 = Object.values(day).reduce((a, b) => a + b, 0);
  const inflight = data.payments?.inFlight;
  const wh = data.webhooks ?? {};
  const inv = data.ledgerInvariants;

  return (
    <>
      <PageHeader title="Overview" subtitle="Live health of the platform. Refreshes every 5 seconds." />
      {error && <div className="mb-4"><ErrorNote error={error} /></div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Payments, last 24h" value={total24} hint={`${day.succeeded ?? 0} succeeded · ${day.failed ?? 0} failed`} />
        <Stat label="In flight" value={inflight?.count ?? '-'} tone={inflight && inflight.count > 0 ? 'warn' : 'success'} hint={inflight && inflight.count > 0 ? `oldest ${inflight.oldestSeconds}s` : 'nothing waiting'} />
        <Stat label="Ledger books" value={inv ? (inv.ok ? 'Balanced' : 'VIOLATION') : '-'} tone={inv ? (inv.ok ? 'success' : 'danger') : undefined} hint={inv ? `sum of all balances: ${inv.totalBalanceMinor}` : 'unavailable'} />
        <Stat label="Webhooks" value={`${wh.succeeded ?? 0} sent`} tone={(wh.dead ?? 0) > 0 ? 'danger' : undefined} hint={`${wh.pending ?? 0} pending · ${wh.dead ?? 0} dead-lettered`} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Services">
          <ul className="divide-y divide-border text-sm">
            {data.services.map((s) => (
              <li key={s.name} className="flex items-center justify-between py-2">
                <span>{s.name}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted">{s.latencyMs === null ? '' : `${s.latencyMs} ms`}</span>
                  <StatusBadge status={s.up ? 'up' : 'down'} />
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Reconciliation" actions={<Link className="text-xs text-accent underline" to="/reconciliation">Details</Link>}>
          <ul className="divide-y divide-border text-sm">
            {(['internal', 'external'] as const).map((k) => {
              const run = data.reconciliation?.[k];
              return (
                <li key={k} className="flex items-center justify-between py-2">
                  <span className="capitalize">{k}</span>
                  {run ? (
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-muted">{run.summary ? `${run.summary.paymentsChecked} payments checked` : run.error}</span>
                      <StatusBadge status={run.status} />
                    </span>
                  ) : (
                    <span className="text-xs text-muted">no run yet</span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Payments by status (all time)">
          <ul className="divide-y divide-border text-sm">
            {Object.entries(data.payments?.byStatus ?? {}).map(([status, n]) => (
              <li key={status} className="flex items-center justify-between py-2">
                <Link to={`/payments?status=${status}`} className="hover:underline"><StatusBadge status={status} /></Link>
                <span className="tabular-nums">{n}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Webhook deliveries">
          <ul className="divide-y divide-border text-sm">
            {Object.entries(wh).map(([status, n]) => (
              <li key={status} className="flex items-center justify-between py-2">
                <StatusBadge status={status} />
                <span className="tabular-nums">{n}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Dead-lettered deliveries can be replayed from the <Link className="underline" to="/webhooks">Webhooks</Link> page.</p>
        </Card>
      </div>
    </>
  );
}
