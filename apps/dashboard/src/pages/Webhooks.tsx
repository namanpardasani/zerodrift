import { Badge, Button, Card, DataTable, ErrorNote, Id, KeyValue, PageHeader, Select, Spinner, StatusBadge, formatTime, timeAgo } from '@zerodrift/ui';
import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { Delivery, Endpoint } from '../types.js';

function DeliveryDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: d, error, reload } = useApi<Delivery>(`/api/webhooks/deliveries/${id}`, { pollMs: 3000 });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);

  async function replay() {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/api/webhooks/deliveries/${id}/replay`, { method: 'POST', body: {} });
      reload();
      onChanged();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Delivery" actions={<><Button size="sm" variant="primary" onClick={replay} disabled={busy}>Replay</Button><Button size="sm" onClick={onClose}>Close</Button></>}>
      {error && <ErrorNote error={error} />}
      {actionError && <ErrorNote error={actionError} />}
      {!d ? <Spinner /> : (
        <>
          <KeyValue items={[
            ['Event', <span key="e"><Id id={d.eventId} /> · {d.eventType}</span>],
            ['Endpoint', d.endpointUrl],
            ['Status', <StatusBadge key="s" status={d.status} />],
            ['Attempts', `${d.attemptCount}${d.replayCount ? ` (replayed ${d.replayCount}×)` : ''}`],
            ['Next attempt', d.nextAttemptAt ? formatTime(d.nextAttemptAt) : '-'],
          ]} />
          <h3 className="mb-2 mt-4 text-sm font-semibold">Attempt log</h3>
          <DataTable
            rows={d.attempts ?? []}
            rowKey={(a) => String(a.attemptNo)}
            columns={[
              { header: '#', cell: (a) => a.attemptNo },
              { header: 'When', cell: (a) => formatTime(a.startedAt) },
              { header: 'Result', cell: (a) => (a.error ? <Badge tone="danger">{a.error}</Badge> : <Badge tone={a.responseCode && a.responseCode < 300 ? 'success' : 'danger'}>HTTP {a.responseCode}</Badge>) },
              { header: 'Took', cell: (a) => `${a.durationMs} ms` },
              { header: 'Response', cell: (a) => <span className="text-xs text-muted">{a.responseSnippet?.slice(0, 80) ?? ''}</span> },
            ]}
          />
        </>
      )}
    </Card>
  );
}

export function WebhooksPage() {
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const q = new URLSearchParams({ limit: '50', ...(status ? { status } : {}) });
  const deliveries = useApi<{ deliveries: Delivery[] }>(`/api/webhooks/deliveries?${q}`, { pollMs: 3000 });
  const endpoints = useApi<{ endpoints: Endpoint[] }>('/api/webhooks/endpoints', { pollMs: 10000 });
  const stats = useApi<Record<string, number>>('/api/webhooks/stats', { pollMs: 3000 });

  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="Signed deliveries to merchants, with retries (exponential backoff + jitter) and a dead-letter state. Replay any delivery."
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
        {Object.entries(stats.data ?? {}).map(([s, n]) => <span key={s} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm"><StatusBadge status={s} /> <span className="tabular-nums">{n}</span></span>)}
      </div>
      {deliveries.error && <ErrorNote error={deliveries.error} onRetry={deliveries.reload} />}
      <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
        <Card title="Deliveries">
          {deliveries.loading && !deliveries.data ? <Spinner /> : (
            <DataTable
              rows={deliveries.data?.deliveries ?? []}
              rowKey={(d) => d.id}
              onRowClick={(d) => setSelected(d.id)}
              empty="No deliveries yet. Make a payment in the demo shop."
              columns={[
                { header: 'Event', cell: (d) => <span>{d.eventType} <Id id={d.eventId} /></span> },
                { header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
                { header: 'Attempts', cell: (d) => d.attemptCount, className: 'text-right' },
                { header: 'Last result', cell: (d) => (d.lastError ?? (d.lastResponseCode ? `HTTP ${d.lastResponseCode}` : '-')) },
                { header: 'Created', cell: (d) => <span className="text-muted">{timeAgo(d.createdAt)}</span> },
              ]}
            />
          )}
        </Card>
        {selected ? <DeliveryDetail id={selected} onClose={() => setSelected(null)} onChanged={deliveries.reload} /> : (
          <Card title="Endpoints">
            <DataTable
              rows={endpoints.data?.endpoints ?? []}
              rowKey={(e) => e.id}
              empty="No endpoints registered."
              columns={[
                { header: 'URL', cell: (e) => <span className="break-all text-xs">{e.url}</span> },
                { header: 'Events', cell: (e) => e.eventTypes.join(', ') },
                { header: 'State', cell: (e) => <StatusBadge status={e.active ? 'up' : 'down'} /> },
              ]}
            />
            <p className="mt-3 text-xs text-muted">Select a delivery to see its attempt log and replay it. Signing secrets are never shown here.</p>
          </Card>
        )}
      </div>
    </>
  );
}
