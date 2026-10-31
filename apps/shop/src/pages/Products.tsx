import { Button, EmptyState, Money, Skeleton } from '@zerodrift/ui';
import { motion } from 'motion/react';
import { useShop } from '../shop-context.js';
import { SHOP_NAME } from '../shopName.js';

export function ProductsPage() {
  const { products, add, cart } = useShop();
  if (products.length === 0) return <Skeleton rows={3} />;
  return (
    <>
      <h1 className="shop-display text-[40px] leading-tight">Today’s menu</h1>
      <p className="mt-1 max-w-lg text-sm text-muted">Pay from your wallet. Add funds above, fill your cart, and {SHOP_NAME} will confirm your order the moment the payment settles.</p>
      <ul className="m-0 mt-7 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p, i) => {
          const inCart = cart.find((l) => l.productId === p.id)?.qty ?? 0;
          return (
            <motion.li key={p.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }} className="flex flex-col rounded-card border border-rule bg-card p-5">
              <h2 className="shop-display text-xl">{p.name}</h2>
              <p className="mt-1 min-h-10 flex-1 text-sm text-muted">{p.description}</p>
              <div className="mt-4 flex items-center justify-between gap-2">
                <Money minor={p.priceMinor} className="text-lg font-medium" />
                <Button variant="signal" onClick={() => add(p.id)} aria-label={`Add ${p.name} to cart`}>{inCart ? `Add another (${inCart})` : 'Add to cart'}</Button>
              </div>
            </motion.li>
          );
        })}
      </ul>
      {products.length === 0 && <EmptyState>No products.</EmptyState>}
    </>
  );
}
