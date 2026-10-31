import { BRAND_NAME } from '@zerodrift/brand';
import { Card, DataTable, DoubleTap, ErrorNote, Id, Journal, type JournalLine, KeyValue, Money, MetroLine, PageHeader, Receipt, Rupees, Select, Skeleton, StatusBadge, Timeline, formatClock, formatMinorPlain, formatTime, statusLabel, timeAgo } from '@zerodrift/ui';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAccountLabels } from '../accountLabels.js';
import { useApi } from '../hooks.js';
import type { LedgerTx, Payment } from '../types.js';

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
              <option key={s} value={s}>{s ? statusLabel(s) : 'All statuses'}</option>
            ))}
          </Select>
        }
      />
      {error && <ErrorNote error={error} onRetry={reload} />}
      <Card className="overflow-hidden [&>div]:p-0">
        {loading && !data ? (
          <div className="p-[18px]"><Skeleton /></div>
        ) : (
          <DataTable
            rows={data?.payments ?? []}
            rowKey={(p) => p.id}
            onRowClick={(p) => nav(`/app/payments/${p.id}`)}
            empty="No payments match."
            columns={[
              { header: 'id', cell: (p) => <Id id={p.id} /> },
              { header: 'merchant', cell: (p) => p.merchantName },
              { header: 'customer', cell: (p) => <span className="mono text-[13px] text-ink-2">{p.customerId}</span> },
              { header: 'amount', cell: (p) => <Money minor={p.amountMinor} />, className: 'text-right' },
              { header: 'status', cell: (p) => <StatusBadge status={p.status} /> },
              { header: 'created', cell: (p) => <span className="mono text-[13px] text-ink-2" title={formatTime(p.createdAt)}>{timeAgo(p.createdAt)}</span> },
            ]}
          />
        )}
      </Card>
    </>
  );
}

const PATH = ['created', 'processing', 'succeeded', 'refunded'];
const FAIL_PATH = ['created', 'processing', 'failed'];

/** The state the metro line should stop at: refunds fold into "refunded"; a failed payment gets its own short line. */
function metro(status: string): { states: string[]; current: string } {
  if (status === 'failed') return { states: FAIL_PATH, current: 'failed' };
  if (status === 'partially_refunded') return { states: PATH, current: 'refunded' };
  return { states: PATH, current: status };
}

export function PaymentDetailPage() {
  const { id } = useParams();
  const { data: p, error, loading, reload } = useApi<Payment>(`/api/payments/${id}`, { pollMs: 3000 });
  const tx = useApi<LedgerTx>(p?.ledgerTxId ? `/api/ledger/transactions/${p.ledgerTxId}` : null);
  const labels = useAccountLabels(tx.data?.entries.map((e) => e.accountId) ?? []);

  if (loading && !p) return <Skeleton rows={6} />;
  if (!p) return <ErrorNote error={error ?? 'Not found'} onRetry={reload} />;

  const { states, current } = metro(p.status);
  const settled = ['succeeded', 'partially_refunded', 'refunded'].includes(p.status);

  const lines: JournalLine[] = (tx.data?.entries ?? []).map((e) => {
    const l = labels[e.accountId];
    const isMerchant = l?.ownerType === 'merchant' && l.ownerId === p.merchantId;
    return {
      account: isMerchant ? p.merchantName : l?.type === 'fees' ? `${BRAND_NAME} fees` : (l?.ownerId ?? <Id id={e.accountId} />),
      sub: isMerchant ? 'merchant' : l?.type === 'fees' ? 'system' : l ? `${l.ownerType} ${l.type.replace(/_/g, ' ')}` : undefined,
      direction: e.direction,
      amountMinor: e.amountMinor,
    };
  });

  const receipt = settled && tx.data
    ? {
        kind: 'payment receipt',
        rows: [['pay', p.id.slice(0, 13)], ['from', p.customerId], ['to', p.merchantName], ['time', formatClock(p.createdAt, false)]] as [string, string][],
        amountMinor: p.amountMinor,
        ledger: [
          ['ledger txn', tx.data.id.slice(0, 13)],
          ['debits', formatMinorPlain(lines.filter((l) => l.direction === 'debit').reduce((sum, l) => sum + BigInt(l.amountMinor), 0n))],
          ['credits', formatMinorPlain(lines.filter((l) => l.direction === 'credit').reduce((sum, l) => sum + BigInt(l.amountMinor), 0n))],
        ] as [string, string][],
        status: statusLabel(p.status).toUpperCase(),
        barcodeSeed: p.id,
        fileName: `receipt-${p.id.slice(0, 8)}`,
      }
    : null;

  return (
    <>
      <div className="mono text-[13px] text-muted"><Link to="/app/payments" className="hover:underline">payments</Link> / <Id id={p.id} /></div>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-4xl"><Rupees minor={p.amountMinor} className="mono" /> to {p.merchantName}</h1>
        {p.idempotencyKey && <span className="mono text-[13px] text-muted">idempotency key {p.idempotencyKey}</span>}
      </div>
      {p.failureReason && <p className="mt-2 text-sm text-failed-ink">Failed: {p.failureReason}</p>}

      <div className="mt-7 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <MetroLine key={current} states={states} current={current} />
          <div className="mt-7">
            {p.ledgerTxId ? (
              tx.data ? (
                <Journal
                  key={tx.data.id}
                  title={<>Journal <Link to={`/app/ledger?tx=${tx.data.id}`} className="underline">{tx.data.id.slice(0, 8)}</Link></>}
                  meta={`${tx.data.type} · posted ${formatClock(tx.data.createdAt)}`}
                  lines={lines}
                />
              ) : tx.error ? (
                <ErrorNote error={tx.error} onRetry={tx.reload} />
              ) : (
                <Skeleton rows={4} />
              )
            ) : (
              <Card title="Journal"><p className="text-sm text-muted">No ledger transaction yet: the money has not moved. {p.status === 'processing' ? 'The funds are held while the payment is in flight.' : ''}</p></Card>
            )}
          </div>
        </div>
        {receipt && <Receipt data={receipt} brand={BRAND_NAME} />}
      </div>

      {(p.duplicatesAbsorbed ?? 0) > 0 && (
        <section className="mt-9" aria-label="Duplicate requests">
          <h2 className="mb-3 text-[17px] font-medium tracking-[-0.01em]">A duplicate request was absorbed</h2>
          <div className="rounded-panel bg-paper p-6">
            <DoubleTap
              key={`${p.id}-${p.duplicatesAbsorbed}`}
              duplicates={p.duplicatesAbsorbed ?? 1}
              counterLabel={`Charges on ${p.customerId}’s wallet`}
              request={
                <>
                  <div className="mono font-medium">POST /v1/payments</div>
                  <div className="mono text-muted">Idempotency-Key: {p.idempotencyKey}</div>
                  <div className="mono">amount {p.amountMinor} · to {p.merchantName}</div>
                </>
              }
              response={`${settled ? '201 created' : '202 accepted'} · ${p.id.slice(0, 8)}`}
            />
            {p.lastDuplicateAt && <p className="mono mt-3 text-xs text-muted">last duplicate at {formatClock(p.lastDuplicateAt)}</p>}
          </div>
        </section>
      )}

      <div className="mt-9 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Timeline">
          <Timeline
            stepDelay={0.18}
            steps={(p.events ?? []).map((e, i, all) => ({
              label: (
                <span>
                  {e.fromStatus ? <>{statusLabel(e.fromStatus)} → </> : null}
                  <b className="font-medium">{statusLabel(e.toStatus)}</b>
                  {e.reason ? <span className="text-muted"> · {e.reason.replace(/_/g, ' ')}</span> : null}
                </span>
              ),
              time: formatClock(e.at),
              tone: e.toStatus === 'failed' ? 'failed' : e.toStatus === 'processing' && i === all.length - 1 ? 'pending' : 'settled',
            }))}
          />
        </Card>
        <Card title="Details">
          <KeyValue
            items={[
              ['Fee', <Money key="f" minor={p.feeMinor} />],
              ['Refunded', <Money key="r" minor={p.refundedMinor} />],
              ['Customer', p.customerId],
              ['Merchant reference', p.reference ?? '-'],
              ['Bank reference', p.gatewayRef ?? '-'],
              ['Created', formatTime(p.createdAt)],
              ['Updated', formatTime(p.updatedAt)],
            ]}
          />
        </Card>
      </div>

      <Card title="Refunds" className="mt-4">
        <DataTable
          rows={p.refunds ?? []}
          rowKey={(r) => r.id}
          empty="No refunds."
          columns={[
            { header: 'refund', cell: (r) => <Id id={r.id} /> },
            { header: 'amount', cell: (r) => <Money minor={r.amountMinor} />, className: 'text-right' },
            { header: 'fee returned', cell: (r) => <Money minor={r.feeRefundMinor} />, className: 'text-right' },
            { header: 'status', cell: (r) => <StatusBadge status={r.status} /> },
            { header: 'reason', cell: (r) => r.failureReason ?? r.reason ?? '-' },
          ]}
        />
      </Card>
    </>
  );
}
