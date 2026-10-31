import { Badge, Button, Card, DataTable, ErrorNote, Id, KeyValue, PageHeader, RetryTrack, Select, Skeleton, StatusBadge, formatClock, formatTime, timeAgo } from '@zerodrift/ui';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { Delivery, Endpoint } from '../types.js';

export function WebhooksPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const q = new URLSearchParams({ limit: '50', ...(status ? { status } : {}) });
  const deliveries = useApi<{ deliveries: Delivery[] }>(`/api/webhooks/deliveries?${q}`, { pollMs: 3000 });
  const endpoints = useApi<{ endpoints: Endpoint[] }>('/api/webhooks/endpoints', { pollMs: 10000 });
  const stats = useApi<Record<string, number>>('/api/webhooks/stats', { pollMs: 3000 });

  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="Signed deliveries to merchants, with retries (exponential backoff and jitter) and a dead-letter state. Open a delivery to see its attempts on a time axis and replay it."
        actions={
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="pending">pending</option>
            <option value="succeeded">succeeded</option>
            <option value="dead">dead-lettered</option>
          </Select>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(stats.data ?? {}).map(([s, n]) => (
          <span key={s} className="flex items-center gap-2.5 rounded-card border border-rule bg-card px-3.5 py-2 text-sm"><StatusBadge status={s} /> <span className="mono">{n}</span></span>
        ))}
      </div>
      {deliveries.error && <ErrorNote error={deliveries.error} onRetry={deliveries.reload} />}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="Deliveries" className="overflow-hidden [&>div]:p-0">
          {deliveries.loading && !deliveries.data ? (
            <div className="p-[18px]"><Skeleton /></div>
          ) : (
            <DataTable
              rows={deliveries.data?.deliveries ?? []}
              rowKey={(d) => d.id}
              onRowClick={(d) => nav(`/app/webhooks/${d.id}`)}
              empty="No deliveries yet. Make a payment in the demo shop."
              columns={[
                { header: 'event', cell: (d) => <span>{d.eventType} <Id id={d.eventId} /></span> },
                { header: 'status', cell: (d) => <StatusBadge status={d.status} /> },
                { header: 'attempts', cell: (d) => <span className="mono">{d.attemptCount}</span>, className: 'text-right' },
                { header: 'last result', cell: (d) => <span className="text-[13px]">{d.lastError ?? (d.lastResponseCode ? `HTTP ${d.lastResponseCode}` : '-')}</span> },
                { header: 'created', cell: (d) => <span className="mono text-[13px] text-muted">{timeAgo(d.createdAt)}</span> },
              ]}
            />
          )}
        </Card>
        <Card title="Endpoints">
          <DataTable
            rows={endpoints.data?.endpoints ?? []}
            rowKey={(e) => e.id}
            empty="No endpoints registered."
            columns={[
              { header: 'url', cell: (e) => <span className="mono break-all text-xs">{e.url}</span> },
              { header: 'events', cell: (e) => e.eventTypes.join(', ') },
              { header: 'state', cell: (e) => <StatusBadge status={e.active ? 'up' : 'down'} /> },
            ]}
          />
          <p className="mt-3 text-xs text-muted">Signing secrets are never shown here.</p>
        </Card>
      </div>
    </>
  );
}

const attemptLabel = (a: NonNullable<Delivery['attempts']>[number]) => (a.error ? a.error : a.responseCode ? (a.responseCode < 300 ? `${a.responseCode} ok` : String(a.responseCode)) : 'no response');

/** One delivery: its attempts on a to-scale time axis (the gaps are the real backoff), the attempt log, and Replay. */
export function WebhookDeliveryPage() {
  const { id } = useParams();
  const { data: d, error, loading, reload } = useApi<Delivery>(`/api/webhooks/deliveries/${id}`, { pollMs: 3000 });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);

  async function replay() {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/api/webhooks/deliveries/${id}/replay`, { method: 'POST', body: {} });
      reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !d) return <Skeleton rows={6} />;
  if (!d) return <ErrorNote error={error ?? 'Not found'} onRetry={reload} />;

  const attempts = [...(d.attempts ?? [])].sort((a, b) => a.attemptNo - b.attemptNo);
  const t0 = attempts[0] ? new Date(attempts[0].startedAt).getTime() : 0;
  const track = attempts.map((a) => ({ atMs: new Date(a.startedAt).getTime() - t0, label: attemptLabel(a), ok: !a.error && !!a.responseCode && a.responseCode < 300 }));

  return (
    <>
      <div className="mono text-[13px] text-muted"><Link to="/app/webhooks" className="hover:underline">webhooks</Link> / <Id id={d.id} /></div>
      <PageHeader
        title={d.eventType}
        subtitle={<span>to <span className="mono">{d.endpointUrl}</span></span>}
        actions={<Button variant="primary" onClick={replay} disabled={busy}>{busy ? 'Replaying…' : 'Replay'}</Button>}
      />
      {error && <ErrorNote error={error} />}
      {actionError && <ErrorNote error={actionError} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Attempts, to scale">
          {attempts.length === 0 ? <p className="text-sm text-muted">No attempt has been made yet.</p> : <RetryTrack key={attempts.length} attempts={track} />}
          <p className="mt-2 text-xs text-muted">Each retry waits longer than the last (exponential backoff with jitter). The distance between dots is the real time between attempts.</p>
        </Card>
        <Card title="Delivery">
          <KeyValue items={[
            ['Event', <Id key="e" id={d.eventId} />],
            ['Status', <StatusBadge key="s" status={d.status} />],
            ['Attempts', `${d.attemptCount}${d.replayCount ? ` (replayed ${d.replayCount}×)` : ''}`],
            ['Next attempt', d.nextAttemptAt && d.status === 'pending' ? formatTime(d.nextAttemptAt) : '-'],
          ]} />
        </Card>
      </div>
      <Card title="Attempt log" className="mt-4 overflow-hidden [&>div]:p-0">
        <DataTable
          rows={attempts}
          rowKey={(a) => String(a.attemptNo)}
          columns={[
            { header: '#', cell: (a) => <span className="mono">{a.attemptNo}</span> },
            { header: 'when', cell: (a) => <span className="mono text-[13px]">{formatClock(a.startedAt)}</span> },
            { header: 'result', cell: (a) => (a.error ? <Badge tone="danger">{a.error}</Badge> : <Badge tone={a.responseCode && a.responseCode < 300 ? 'success' : 'danger'}>HTTP {a.responseCode}</Badge>) },
            { header: 'took', cell: (a) => <span className="mono text-[13px]">{a.durationMs} ms</span> },
            { header: 'response', cell: (a) => <span className="text-xs text-muted">{a.responseSnippet?.slice(0, 80) ?? ''}</span> },
          ]}
        />
      </Card>
    </>
  );
}
