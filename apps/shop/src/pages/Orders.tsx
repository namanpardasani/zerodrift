import { Badge, Card, DataTable, EmptyState, ErrorNote, KeyValue, Money, PageHeader, Spinner, formatTime } from '@zerodrift/ui';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type Order } from '../api.js';
import { useShopApi } from '../use-shop-api.js';
import { useShop } from '../shop-context.js';

const TONE = { pending: 'warn', paid: 'success', payment_failed: 'danger' } as const;
const LABEL = { pending: 'Confirming payment', paid: 'Paid', payment_failed: 'Payment failed' } as const;

const REASONS: Record<string, string> = {
  insufficient_funds: 'Your wallet balance was too low. Add funds and try again.',
  declined_by_bank: 'The bank declined the payment.',
  cancelled: 'The payment was cancelled because it could not be confirmed in time.',
};

export function OrderPage() {
  const { id } = useParams();
  const { refreshBalance } = useShop();
  // keep polling while the outcome is unknown; stop as soon as it is final
  const { data: o, error } = useShopApi<Order>(`/api/orders/${id}`, { pollWhile: (d) => d.status === 'pending', onData: () => refreshBalance() });
  if (!o) return error ? <ErrorNote error={error} /> : <Spinner />;
  return (
    <>
      <PageHeader title="Order" subtitle={<code className="font-mono text-xs">{o.id}</code>} actions={<Badge tone={TONE[o.status]}>{LABEL[o.status]}</Badge>} />
      {o.status === 'pending' && (
        <div role="status" className="mb-4 rounded-md border border-border bg-warn-bg px-4 py-3 text-sm text-warn">
          We have not heard back from the bank yet. Your money is <strong>held, not lost</strong>: this page updates by itself the moment the payment is confirmed or released.
        </div>
      )}
      {o.status === 'paid' && <div role="status" className="mb-4 rounded-md bg-success-bg px-4 py-3 text-sm text-success">Thank you, your order is confirmed.</div>}
      {o.status === 'payment_failed' && <div role="alert" className="mb-4 rounded-md bg-danger-bg px-4 py-3 text-sm text-danger">{REASONS[o.failureReason ?? ''] ?? `The payment failed (${o.failureReason ?? 'unknown reason'}).`} You were not charged.</div>}
      <Card title="Items">
        <DataTable
          rows={o.lines}
          rowKey={(l) => l.productId}
          columns={[
            { header: 'Item', cell: (l) => l.name },
            { header: 'Qty', cell: (l) => l.qty, className: 'text-right' },
            { header: 'Each', cell: (l) => <Money minor={l.unitPriceMinor} />, className: 'text-right' },
            { header: 'Subtotal', cell: (l) => <Money minor={l.unitPriceMinor * l.qty} />, className: 'text-right' },
          ]}
        />
        <div className="mt-4 border-t border-border pt-4"><KeyValue items={[['Total', <Money key="t" minor={o.totalMinor} className="font-semibold" />], ['Placed', formatTime(o.createdAt)]]} /></div>
      </Card>
    </>
  );
}

export function OrdersPage() {
  const { customerId } = useShop();
  const nav = useNavigate();
  const { data, error } = useShopApi<{ orders: Order[] }>(`/api/orders?customerId=${encodeURIComponent(customerId)}`, { pollMs: 3000 });
  return (
    <>
      <PageHeader title="Your orders" subtitle={`Orders placed as ${customerId}`} />
      {error && <ErrorNote error={error} />}
      {!data ? <Spinner /> : data.orders.length === 0 ? <EmptyState>No orders yet. <Link className="text-accent underline" to="/">Go shopping</Link>.</EmptyState> : (
        <Card>
          <DataTable
            rows={data.orders}
            rowKey={(o) => o.id}
            onRowClick={(o) => nav(`/orders/${o.id}`)}
            columns={[
              { header: 'Placed', cell: (o) => formatTime(o.createdAt) },
              { header: 'Items', cell: (o) => o.lines.map((l) => `${l.qty}× ${l.name}`).join(', ') },
              { header: 'Total', cell: (o) => <Money minor={o.totalMinor} />, className: 'text-right' },
              { header: 'Status', cell: (o) => <Badge tone={TONE[o.status]}>{LABEL[o.status]}</Badge> },
            ]}
          />
        </Card>
      )}
    </>
  );
}
