import { Card, ErrorNote, PageHeader, Sparkline, Spinner, Stat } from '@zerodrift/ui';
import { useApi } from '../hooks.js';
import type { MetricsSummary } from '../types.js';

interface Range { available: boolean; series: { labels: Record<string, string>; points: { t: number; v: number }[] }[] }

const sum = (rows: { value: number }[] | undefined) => (rows ?? []).reduce((a, r) => a + r.value, 0);
const by = (rows: { labels: Record<string, string>; value: number }[] | undefined, label: string, value: string) => rows?.find((r) => r.labels[label] === value)?.value ?? 0;

function Trend({ name, title, unit }: { name: string; title: string; unit: string }) {
  const { data } = useApi<Range>(`/api/metrics/range/${name}?minutes=15`, { pollMs: 10000 });
  const pts = data?.series[0]?.points.map((p) => p.v) ?? [];
  const latest = pts.length ? pts[pts.length - 1]! : 0;
  return (
    <Card title={title}>
      <div className="mb-2 text-xl font-semibold tabular-nums">{latest.toFixed(2)} <span className="text-sm font-normal text-muted">{unit}</span></div>
      <Sparkline points={pts} label={title} />
      <div className="mt-1 text-xs text-muted">last 15 minutes</div>
    </Card>
  );
}

export function MetricsPage() {
  const { data, error, loading, reload } = useApi<MetricsSummary>('/api/metrics/summary', { pollMs: 5000 });
  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorNote error={error ?? 'No data'} onRetry={reload} />;
  const s = data.series;
  const breaker = s.gatewayCircuitOpen?.[0]?.value ?? 0;

  return (
    <>
      <PageHeader title="Metrics" subtitle="From Prometheus (scraped every 5 seconds). Full dashboards live in Grafana." />
      {!data.available && <div className="mb-4"><ErrorNote error="Prometheus is not reachable: some or all figures below are missing." /></div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Payments succeeded" value={by(s.paymentsByStatus, 'to', 'succeeded')} tone="success" />
        <Stat label="Payments failed" value={by(s.paymentsByStatus, 'to', 'failed')} tone={by(s.paymentsByStatus, 'to', 'failed') > 0 ? 'warn' : undefined} />
        <Stat label="Gateway circuit" value={breaker === 0 ? 'Closed' : breaker === 1 ? 'OPEN' : 'Half-open'} tone={breaker === 0 ? 'success' : 'danger'} hint="open = failing fast, not calling the bank" />
        <Stat label="Recovered by job" value={sum(s.recovered)} hint="stuck payments settled by recovery" />
        <Stat label="Outbox backlog" value={sum(s.outboxBacklog)} tone={sum(s.outboxBacklog) > 50 ? 'warn' : undefined} hint="events waiting to reach Kafka" />
        <Stat label="Events published" value={sum(s.outboxPublished)} />
        <Stat label="Events consumed" value={by(s.consumerMessages, 'result', 'processed')} hint={`${by(s.consumerMessages, 'result', 'duplicate')} duplicates skipped · ${by(s.consumerMessages, 'result', 'dead_lettered')} dead-lettered`} />
        <Stat label="Webhook attempts" value={sum(s.webhookAttempts)} hint={`${by(s.webhookAttempts, 'result', 'failure')} failed`} />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Trend name="throughput" title="Payments succeeded / s" unit="per second" />
        <Trend name="failures" title="Payments failed / s" unit="per second" />
        <Trend name="http5xx" title="Server errors / s" unit="per second" />
      </div>
      <Card title="Request rate by service" className="mt-6">
        <ul className="divide-y divide-border text-sm">
          {(s.httpRatePerService ?? []).map((r) => (
            <li key={r.labels.instance} className="flex justify-between py-2"><span>{r.labels.instance}</span><span className="tabular-nums">{r.value.toFixed(2)} req/s</span></li>
          ))}
        </ul>
      </Card>
    </>
  );
}
