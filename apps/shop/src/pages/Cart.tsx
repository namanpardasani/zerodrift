import { Button, Card, EmptyState, ErrorNote, Money, PageHeader } from '@zerodrift/ui';
import { useRef, useState } from 'react';
import { newId } from '../ids.js';

import { Link, useNavigate } from 'react-router-dom';
import { type Order, shopApi } from '../api.js';
import { totalMinor } from '../cart.js';
import { useShop } from '../shop-context.js';

export function CartPage() {
  const { cart, products, prices, setQuantity, remove, clearCart, customerId, refreshBalance } = useShop();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // ONE idempotency key per checkout attempt. If the request is retried (double click, flaky network,
  // user presses Pay again) the server returns the SAME order: no double charge. A new key is only
  // created after the attempt is finished, or when the cart contents change.
  const attempt = useRef<{ key: string; signature: string } | null>(null);
  const signature = JSON.stringify([customerId, cart]);

  async function pay() {
    if (!attempt.current || attempt.current.signature !== signature) attempt.current = { key: `checkout-${newId()}`, signature };
    setBusy(true);
    setError(null);
    try {
      const order = await shopApi<Order>('/api/orders', { method: 'POST', body: { customerId, items: cart }, idempotencyKey: attempt.current.key });
      attempt.current = null;
      clearCart();
      refreshBalance();
      nav(`/orders/${order.id}`);
    } catch (e) {
      setError(e as Error); // keep the same key: pressing Pay again is a safe retry of the same attempt
    } finally {
      setBusy(false);
    }
  }

  if (cart.length === 0) return <><PageHeader title="Cart" /><EmptyState>Your cart is empty. <Link className="text-accent underline" to="/">Browse the shop</Link>.</EmptyState></>;
  const total = totalMinor(cart, prices);

  return (
    <>
      <PageHeader title="Cart" />
      <Card>
        <ul className="divide-y divide-border">
          {cart.map((l) => {
            const p = products.find((x) => x.id === l.productId);
            return (
              <li key={l.productId} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium">{p?.name ?? l.productId}</div>
                  <Money minor={p?.priceMinor ?? 0} className="text-sm text-muted" />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" aria-label={`Fewer ${p?.name}`} onClick={() => setQuantity(l.productId, l.qty - 1)}>−</Button>
                  <span className="w-6 text-center tabular-nums" aria-label="Quantity">{l.qty}</span>
                  <Button size="sm" aria-label={`More ${p?.name}`} onClick={() => setQuantity(l.productId, l.qty + 1)}>+</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(l.productId)}>Remove</Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
          <span className="text-lg font-semibold">Total <Money minor={total} /></span>
          <Button variant="primary" onClick={pay} disabled={busy}>{busy ? 'Processing payment…' : 'Pay from wallet'}</Button>
        </div>
      </Card>
      {error && <div className="mt-4"><ErrorNote error={error} /></div>}
    </>
  );
}
