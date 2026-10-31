import { AnimatePresence, motion } from 'motion/react';
import { Card, Count, Dot, ErrorNote, Id, MiniGauge, PageHeader, Percent, Rupees, Skeleton, Stat, StatusBadge, STATUS_TONE, formatClock } from '@zerodrift/ui';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import type { Overview, Payment } from '../types.js';

const SETTLED = ['succeeded', 'partially_refunded', 'refunded'];

/** Newest payments. New rows slide in at the top; a row that was processing turns settled in place when recovery finishes it. */
function RecentPayments() {
  const { data } = useApi<{ payments: Payment[] }>('/api/payments?limit=8', { pollMs: 2000 });
  const rows = data?.payments ?? [];
  return (
    <section className="mt-[18px] overflow-hidden rounded-card border border-rule">
      <div className="flex items-center justify-between border-b border-rule px-[18px] py-3.5">
        <b className="font-medium">Recent payments</b>
        <span className="mono flex items-center gap-2 text-xs text-muted"><Dot />live</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule">
              {['id', 'merchant', 'customer'].map((h) => <th key={h} className="mono px-[18px] py-2.5 text-left text-xs font-normal text-muted">{h}</th>)}
              <th className="mono px-[18px] py-2.5 text-right text-xs font-normal text-muted">amount</th>
              <th className="mono px-[18px] py-2.5 text-left text-xs font-normal text-muted">status</th>
              <th className="mono px-[18px] py-2.5 text-left text-xs font-normal text-muted">time</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {rows.map((p) => (
                <motion.tr key={p.id} layout="position" initial={{ opacity: 0, y: -8, backgroundColor: '#F6F6F2' }} animate={{ opacity: 1, y: 0, backgroundColor: '#FFFFFF' }} transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }} className="border-b border-rule last:border-0">
                  <td className="px-[18px] py-3"><Link to={`/app/payments/${p.id}`} className="underline-offset-2 hover:underline"><Id id={p.id} /></Link></td>
                  <td className="px-[18px] py-3">{p.merchantName}</td>
                  <td className="mono px-[18px] py-3 text-[13px] text-ink-2">{p.customerId}</td>
                  <td className="mono px-[18px] py-3 text-right"><Rupees minor={p.amountMinor} rollIn={false} /></td>
                  <td className="px-[18px] py-3"><StatusBadge status={p.status} /></td>
                  <td className="mono px-[18px] py-3 text-[13px] text-ink-2">{formatClock(p.createdAt, false)}</td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
        {rows.length === 0 && <div className="px-6 py-10 text-center text-sm text-muted">No payments yet. Make one in the demo shop.</div>}
      </div>
    </section>
  );
}

export function OverviewPage() {
  const { data, error, loading, reload } = useApi<Overview>('/api/overview', { pollMs: 5000 });
  if (loading && !data) return <Skeleton rows={6} />;
  if (!data) return <ErrorNote error={error ?? 'No data'} onRetry={reload} />;

  const day = data.payments?.last24hByStatus ?? {};
  const total24 = Object.values(day).reduce((a, b) => a + b, 0);
  const settled24 = SETTLED.reduce((a, s) => a + (day[s] ?? 0), 0);
  const decided = settled24 + (day.failed ?? 0);
  const inflight = data.payments?.inFlight;
  const wh = data.webhooks ?? {};
  const inv = data.ledgerInvariants;

  return (
    <>
      <PageHeader title="Overview" subtitle="Live health of the platform. Refreshes every 5 seconds." />
      {error && <div className="mb-4"><ErrorNote error={error} /></div>}

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Money in system" value={inv?.moneyInSystemMinor !== undefined ? <Rupees minor={inv.moneyInSystemMinor} /> : '-'} hint="held by customers, merchants and fees" />
        <Stat
          label="Drift"
          value={
            <span className="flex items-center justify-between gap-2">
              {inv ? <Rupees minor={inv.totalBalanceMinor} /> : '-'}
              {inv && <MiniGauge drift={inv.totalBalanceMinor} />}
            </span>
          }
          tone={inv && !inv.ok ? 'danger' : undefined}
          hint={inv ? <><Dot tone={inv.ok ? 'settled' : 'failed'} pulse={false} />{inv.ok ? 'steady: every transaction balances' : 'VIOLATION: the books do not balance'}</> : 'unavailable'}
        />
        <Stat label="Payments, last 24 h" value={<Count value={total24} />} hint={`${settled24} settled · ${day.failed ?? 0} failed${inflight && inflight.count > 0 ? ` · ${inflight.count} in flight (oldest ${inflight.oldestSeconds}s)` : ''}`} />
        <Stat label="Success rate, last 24 h" value={decided > 0 ? <Percent value={(settled24 / decided) * 100} /> : '-'} hint={decided > 0 ? 'settled of settled + failed' : 'no decided payments yet'} />
      </div>

      <RecentPayments />

      <div className="mt-[18px] grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Services">
          <ul className="divide-y divide-rule text-sm">
            {data.services.map((s) => (
              <li key={s.name} className="flex items-center justify-between py-2.5">
                <span>{s.name}</span>
                <span className="flex items-center gap-4">
                  <span className="mono text-xs text-muted">{s.latencyMs === null ? '' : `${s.latencyMs} ms`}</span>
                  <StatusBadge status={s.up ? 'up' : 'down'} />
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Reconciliation" actions={<Link className="text-xs underline" to="/app/reconciliation">Details</Link>}>
          <ul className="divide-y divide-rule text-sm">
            {(['internal', 'external'] as const).map((k) => {
              const run = data.reconciliation?.[k];
              return (
                <li key={k} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="capitalize">{k}</span>
                  {run ? (
                    <span className="flex min-w-0 items-center gap-4">
                      <span className="min-w-0 break-words text-xs text-muted">{run.summary ? `${run.summary.paymentsChecked} payments checked` : run.error}</span>
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
          <ul className="divide-y divide-rule text-sm">
            {Object.entries(data.payments?.byStatus ?? {}).map(([status, n]) => (
              <li key={status} className="flex items-center justify-between py-2.5">
                <Link to={`/app/payments?status=${status}`} className="hover:underline"><StatusBadge status={status} /></Link>
                <span className="mono">{n}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Webhook deliveries">
          <ul className="divide-y divide-rule text-sm">
            {Object.entries(wh).map(([status, n]) => (
              <li key={status} className="flex items-center justify-between py-2.5">
                <StatusBadge status={STATUS_TONE[status] ? status : status} />
                <span className="mono">{n}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Dead-lettered deliveries can be replayed from the <Link className="underline" to="/app/webhooks">Webhooks</Link> page.</p>
        </Card>
      </div>
    </>
  );
}
