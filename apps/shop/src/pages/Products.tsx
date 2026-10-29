import { Button, Card, EmptyState, Money, PageHeader, Spinner } from '@zerodrift/ui';
import { useShop } from '../shop-context.js';

export function ProductsPage() {
  const { products, add, cart } = useShop();
  if (products.length === 0) return <Spinner label="Loading products" />;
  return (
    <>
      <PageHeader title="Shop" subtitle="Pay from your wallet. Top up above, then check out." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p) => {
          const inCart = cart.find((l) => l.productId === p.id)?.qty ?? 0;
          return (
            <Card key={p.id}>
              <h2 className="text-base font-semibold">{p.name}</h2>
              <p className="mt-1 min-h-10 text-sm text-muted">{p.description}</p>
              <div className="mt-3 flex items-center justify-between">
                <Money minor={p.priceMinor} className="text-lg font-semibold" />
                <Button variant="primary" onClick={() => add(p.id)} aria-label={`Add ${p.name} to cart`}>{inCart ? `Add another (${inCart})` : 'Add to cart'}</Button>
              </div>
            </Card>
          );
        })}
      </div>
      {products.length === 0 && <EmptyState>No products.</EmptyState>}
    </>
  );
}
