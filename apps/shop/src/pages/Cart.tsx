import { BRAND_NAME } from '@zerodrift/brand';
import { Button, ErrorNote, Money } from '@zerodrift/ui';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { newId } from '../ids.js';

import { Link, useNavigate } from 'react-router-dom';
import { type Order, shopApi } from '../api.js';
import { totalMinor } from '../cart.js';
import { useShop } from '../shop-context.js';
import { SHOP_NAME } from '../shopName.js';

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

  if (cart.length === 0) return <><h1 className="shop-display text-[40px] leading-tight">Your order</h1><p className="mt-4 text-sm text-muted">Your cart is empty. <Link className="underline" to="/">Browse the menu</Link>.</p></>;
  const total = totalMinor(cart, prices);

  return (
    <>
      <h1 className="shop-display text-[40px] leading-tight">Your order</h1>
      <section className="mt-6 rounded-card border border-rule bg-card p-5">
        <ul className="divide-y divide-rule">
          {cart.map((l) => {
            const p = products.find((x) => x.id === l.productId);
            return (
              <li key={l.productId} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <div className="shop-display text-lg">{p?.name ?? l.productId}</div>
                  <Money minor={p?.priceMinor ?? 0} className="text-sm text-muted" />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" aria-label={`Fewer ${p?.name}`} onClick={() => setQuantity(l.productId, l.qty - 1)}>−</Button>
                  <span className="mono w-6 text-center" aria-label="Quantity">{l.qty}</span>
                  <Button size="sm" aria-label={`More ${p?.name}`} onClick={() => setQuantity(l.productId, l.qty + 1)}>+</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(l.productId)}>Remove</Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
          <span className="text-lg font-medium">Total <Money minor={total} /></span>
          <Button variant="signal" size="lg" onClick={pay} disabled={busy}>{busy ? 'Processing payment…' : 'Pay from wallet'}</Button>
        </div>
        <p className="mt-3 text-xs text-muted">Payment is handled by {BRAND_NAME}. Pressing Pay twice is safe: the same attempt is never charged twice.</p>
        <AnimatePresence>
          {busy && (
            <motion.div role="status" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="mono mt-4 flex items-center gap-3 rounded-nav bg-shop-accent-soft px-4 py-3 text-xs text-ink-2">
                <span>{SHOP_NAME}</span>
                <span className="relative h-px flex-1 bg-shop-accent/40" aria-hidden="true">
                  <motion.i className="absolute -top-1 block h-2 w-2 rounded-full bg-shop-accent" animate={{ left: ['0%', '100%'] }} transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }} />
                </span>
                <span>handing off to {BRAND_NAME}…</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
      {error && <div className="mt-4"><ErrorNote error={error} /></div>}
    </>
  );
}
