import { Card, DataTable, ErrorNote, Id, PageHeader, Select, Spinner, formatTime } from '@zerodrift/ui';
import { useState } from 'react';
import { useApi } from '../hooks.js';

interface AuditLog { id: string; source: string; actor: string; merchantId: string | null; action: string; resourceType: string; resourceId: string | null; ip: string | null; correlationId: string | null; details: unknown; at: string }

const ACTIONS = ['', 'payment.created', 'refund.created', 'wallet.topped_up', 'merchant.created', 'recovery.run', 'webhook_endpoint.created', 'webhook_endpoint.updated', 'webhook_endpoint.disabled', 'webhook_endpoint.secret_rotated', 'webhook_delivery.replayed'];

export function AuditPage() {
  const [action, setAction] = useState('');
  const q = new URLSearchParams({ limit: '100', ...(action ? { action } : {}) });
  const { data, error, loading, reload } = useApi<{ logs: AuditLog[]; unavailable: string[] }>(`/api/audit?${q}`, { pollMs: 5000 });

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Who did what, from where. Append-only: the database refuses to change or delete these rows."
        actions={
          <Select aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTIONS.map((a) => <option key={a} value={a}>{a || 'All actions'}</option>)}
          </Select>
        }
      />
      {error && <ErrorNote error={error} onRetry={reload} />}
      {data && data.unavailable.length > 0 && <div className="mb-3"><ErrorNote error={`Could not read the audit trail of: ${data.unavailable.join(', ')}`} /></div>}
      <Card>
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={data?.logs ?? []}
            rowKey={(l) => l.id}
            empty="Nothing recorded yet."
            columns={[
              { header: 'When', cell: (l) => <span className="text-muted">{formatTime(l.at)}</span> },
              { header: 'Action', cell: (l) => <span><strong>{l.action}</strong> <span className="text-xs text-muted">({l.source})</span></span> },
              { header: 'Actor', cell: (l) => (l.actor.startsWith('merchant:') ? <span>merchant <Id id={l.actor.slice(9)} /></span> : l.actor) },
              { header: 'Resource', cell: (l) => (l.resourceId ? <span>{l.resourceType} <Id id={l.resourceId} /></span> : l.resourceType) },
              { header: 'From', cell: (l) => <span className="font-mono text-xs">{l.ip ?? '-'}</span> },
              { header: 'Correlation', cell: (l) => (l.correlationId ? <Id id={l.correlationId} /> : '-') },
            ]}
          />
        )}
      </Card>
    </>
  );
}
