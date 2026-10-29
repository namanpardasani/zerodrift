import { Card, DataTable, ErrorNote, Id, KeyValue, Money, PageHeader, Select, Spinner, StatusBadge, formatTime, timeAgo } from '@zerodrift/ui';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import type { Payment } from '../types.js';

const STATUSES = ['', 'created', 'processing', 'succeeded', 'failed', 'partially_refunded', 'refunded'];

export function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const nav = useNavigate();
  const q = new URLSearchParams({ limit: '50', ...(status ? { status } : {}) });
  const { data, error, loading, reload } = useApi<{ payments: Payment[] }>(`/api/payments?${q}`, { pollMs: 3000 });

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Newest first. Refreshes every 3 seconds."
        actions={
          <Select aria-label="Filter by status" value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'All statuses'}</option>
            ))}
          </Select>
        }
      />
      {error && <ErrorNote error={error} onRetry={reload} />}
      <Card>
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={data?.payments ?? []}
            rowKey={(p) => p.id}
            onRowClick={(p) => nav(`/payments/${p.id}`)}
            empty="No payments match."
            columns={[
              { header: 'Payment', cell: (p) => <Id id={p.id} /> },
              { header: 'Merchant', cell: (p) => p.merchantName },
              { header: 'Customer', cell: (p) => p.customerId },
              { header: 'Amount', cell: (p) => <Money minor={p.amountMinor} />, className: 'text-right' },
              { header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { header: 'Created', cell: (p) => <span className="text-muted" title={formatTime(p.createdAt)}>{timeAgo(p.createdAt)}</span> },
            ]}
          />
        )}
      </Card>
    </>
  );
}

export function PaymentDetailPage() {
  const { id } = useParams();
  const { data: p, error, loading, reload } = useApi<Payment>(`/api/payments/${id}`, { pollMs: 3000 });
  if (loading && !p) return <Spinner />;
  if (!p) return <ErrorNote error={error ?? 'Not found'} onRetry={reload} />;

  return (
    <>
      <PageHeader title="Payment" subtitle={<code className="font-mono text-xs">{p.id}</code>} actions={<StatusBadge status={p.status} />} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <KeyValue
            items={[
              ['Amount', <Money key="a" minor={p.amountMinor} />],
              ['Platform fee', <Money key="f" minor={p.feeMinor} />],
              ['Refunded', <Money key="r" minor={p.refundedMinor} />],
              ['Merchant', p.merchantName],
              ['Customer', p.customerId],
              ['Merchant reference', p.reference ?? '-'],
              ['Failure reason', p.failureReason ?? '-'],
              ['Ledger transaction', p.ledgerTxId ? <Link key="l" className="text-accent underline" to={`/ledger?tx=${p.ledgerTxId}`}><Id id={p.ledgerTxId} /></Link> : '-'],
              ['Created', formatTime(p.createdAt)],
              ['Updated', formatTime(p.updatedAt)],
            ]}
          />
        </Card>

        <Card title="Timeline">
          <ol className="relative space-y-4 border-l border-border pl-5">
            {(p.events ?? []).map((e, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[1.6rem] top-1 h-2.5 w-2.5 rounded-full bg-accent" aria-hidden />
                <div className="flex items-center gap-2 text-sm">
                  {e.fromStatus && <><StatusBadge status={e.fromStatus} /> <span className="text-muted">→</span></>}
                  <StatusBadge status={e.toStatus} />
                </div>
                <div className="mt-0.5 text-xs text-muted">{formatTime(e.at)}{e.reason ? ` · ${e.reason}` : ''}</div>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title="Refunds" className="mt-4">
        <DataTable
          rows={p.refunds ?? []}
          rowKey={(r) => r.id}
          empty="No refunds."
          columns={[
            { header: 'Refund', cell: (r) => <Id id={r.id} /> },
            { header: 'Amount', cell: (r) => <Money minor={r.amountMinor} />, className: 'text-right' },
            { header: 'Fee returned', cell: (r) => <Money minor={r.feeRefundMinor} />, className: 'text-right' },
            { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { header: 'Reason', cell: (r) => r.failureReason ?? r.reason ?? '-' },
          ]}
        />
      </Card>
    </>
  );
}
