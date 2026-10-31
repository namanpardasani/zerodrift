import { BRAND_NAME } from '@zerodrift/brand';
import { Dot, ErrorNote, Money, Receipt, Skeleton, formatClock, formatTime } from '@zerodrift/ui';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type Order } from '../api.js';
import { useShop } from '../shop-context.js';
import { SHOP_NAME } from '../shopName.js';
import { useShopApi } from '../use-shop-api.js';

const LABEL = { pending: 'Confirming payment', paid: 'Paid', payment_failed: 'Payment failed' } as const;
const DOT = { pending: 'pending', paid: 'settled', payment_failed: 'failed' } as const;

const REASONS: Record<string, string> = {
  insufficient_funds: 'Your wallet balance was too low. Add funds and try again.',
  declined_by_bank: 'The bank declined the payment.',
  cancelled: 'The payment was cancelled because it could not be confirmed in time.',
};

function OrderStatus({ status }: { status: Order['status'] }) {
  return <span className="inline-flex items-center gap-2 text-sm"><Dot tone={DOT[status]} />{LABEL[status]}</span>;
}

export function OrderPage() {
  const { id } = useParams();
  const { refreshBalance } = useShop();
  // keep polling while the outcome is unknown; stop as soon as it is final
  const { data: o, error } = useShopApi<Order>(`/api/orders/${id}`, { pollWhile: (d) => d.status === 'pending', onData: () => refreshBalance() });
  if (!o) return error ? <ErrorNote error={error} /> : <Skeleton rows={4} />;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="shop-display text-[40px] leading-tight">Order</h1>
          <code className="mono text-xs text-muted">{o.id}</code>
        </div>
        <OrderStatus status={o.status} />
      </div>
      {o.status === 'pending' && (
        <div role="status" className="mt-5 rounded-nav border border-pending-dot/50 bg-pending-bg px-4 py-3 text-sm text-pending">
          We have not heard back from the bank yet. Your money is <strong>held, not lost</strong>: this page updates by itself the moment the payment is confirmed or released.
        </div>
      )}
      {o.status === 'paid' && <div role="status" className="mt-5 rounded-nav bg-shop-accent-soft px-4 py-3 text-sm text-ink">Thank you, your order is confirmed. Your receipt is printing.</div>}
      {o.status === 'payment_failed' && <div role="alert" className="mt-5 rounded-nav border border-failed-rule bg-failed-bg px-4 py-3 text-sm text-failed-ink">{REASONS[o.failureReason ?? ''] ?? `The payment failed (${o.failureReason ?? 'unknown reason'}).`} You were not charged.</div>}

      <div className="mt-7 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="rounded-card border border-rule bg-card p-5" aria-label="Items">
          <ul className="m-0 list-none divide-y divide-rule p-0">
            {o.lines.map((l) => (
              <li key={l.productId} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span><span className="shop-display text-lg">{l.name}</span> <span className="mono text-muted">× {l.qty}</span></span>
                <Money minor={l.unitPriceMinor * l.qty} />
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between border-t border-rule pt-4 text-lg font-medium"><span>Total</span><Money minor={o.totalMinor} /></div>
          <p className="mt-2 text-xs text-muted">Placed {formatTime(o.createdAt)}</p>
        </section>
        {o.status === 'paid' && (
          <Receipt
            brand={BRAND_NAME}
            data={{
              kind: `payment receipt for ${SHOP_NAME}`,
              rows: [['order', o.id.slice(0, 13)], ['paid by', o.customerId], ['to', SHOP_NAME], ['time', formatClock(o.createdAt, false)]],
              amountMinor: String(o.totalMinor),
              ledger: o.paymentId ? [['payment', o.paymentId.slice(0, 13)]] : [],
              status: 'PAID',
              barcodeSeed: o.id,
              fileName: `receipt-${o.id.slice(0, 8)}`,
            }}
          />
        )}
      </div>
    </>
  );
}

export function OrdersPage() {
  const { customerId } = useShop();
  const nav = useNavigate();
  const { data, error } = useShopApi<{ orders: Order[] }>(`/api/orders?customerId=${encodeURIComponent(customerId)}`, { pollMs: 3000 });
  return (
    <>
      <h1 className="shop-display text-[40px] leading-tight">Your orders</h1>
      <p className="mt-1 text-sm text-muted">Orders placed as <span className="mono">{customerId}</span></p>
      {error && <div className="mt-4"><ErrorNote error={error} /></div>}
      <div className="mt-6">
        {!data ? <Skeleton rows={3} /> : data.orders.length === 0 ? <p className="py-6 text-sm text-muted">No orders yet. <Link className="underline" to="/">Go to the menu</Link>.</p> : (
          <ul className="m-0 list-none overflow-hidden rounded-card border border-rule bg-card p-0">
            {data.orders.map((o) => (
              <li key={o.id} className="border-b border-rule last:border-0">
                <button type="button" onClick={() => nav(`/orders/${o.id}`)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-3.5 text-left hover:bg-paper sm:grid-cols-[150px_minmax(0,1fr)_110px_170px]">
                  <span className="mono hidden text-[13px] text-muted sm:block">{formatTime(o.createdAt)}</span>
                  <span className="truncate text-sm">{o.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}</span>
                  <Money minor={o.totalMinor} className="text-right text-sm" />
                  <span className="hidden justify-end sm:flex"><OrderStatus status={o.status} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
