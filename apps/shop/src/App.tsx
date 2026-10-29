import { BRAND_NAME } from '@zerodrift/brand';
import { Button, Money } from '@zerodrift/ui';
import { useState } from 'react';
import { newId } from './ids.js';

import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { shopApi } from './api.js';
import { CartPage } from './pages/Cart.js';
import { OrderPage, OrdersPage } from './pages/Orders.js';
import { ProductsPage } from './pages/Products.js';
import { useShop } from './shop-context.js';

const TOPUPS = [50_000, 100_000, 500_000];

function WalletBar() {
  const { customerId, setCustomerId, balance, refreshBalance } = useShop();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function topUp(amountMinor: number) {
    setBusy(true);
    setError(null);
    try {
      // a fresh key per click: one click = one top-up, even if the request is retried by the browser
      await shopApi(`/api/customers/${encodeURIComponent(customerId)}/topup`, { method: 'POST', body: { amountMinor }, idempotencyKey: `topup-${newId()}` });
      refreshBalance();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface-2 px-4 py-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted">Shopping as</span>
        <input aria-label="Customer id" defaultValue={customerId} key={customerId} onBlur={(e) => e.target.value.trim() && e.target.value !== customerId && setCustomerId(e.target.value.trim())} className="w-36 rounded-md border border-border bg-surface px-2 py-1 text-xs" />
      </label>
      <span>Wallet: <strong>{balance ? <Money minor={balance.availableMinor} /> : '…'}</strong>{balance && BigInt(balance.heldMinor) > 0n && <span className="ml-1 text-xs text-muted">(<Money minor={balance.heldMinor} /> on hold)</span>}</span>
      <span className="flex items-center gap-1.5">
        <span className="text-muted">Add funds:</span>
        {TOPUPS.map((a) => <Button key={a} size="sm" disabled={busy} onClick={() => topUp(a)}>+<Money minor={a} /></Button>)}
      </span>
      {error && <span role="alert" className="text-danger">{error}</span>}
    </div>
  );
}

export function App() {
  const { cartCount } = useShop();
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">Demo Shop</Link>
          <nav aria-label="Main" className="flex items-center gap-4 text-sm">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'font-medium' : 'text-muted hover:text-text')}>Shop</NavLink>
            <NavLink to="/orders" className={({ isActive }) => (isActive ? 'font-medium' : 'text-muted hover:text-text')}>Orders</NavLink>
            <NavLink to="/cart" className={({ isActive }) => `rounded-md border border-border px-3 py-1.5 ${isActive ? 'bg-surface-2 font-medium' : 'hover:bg-surface-2'}`}>Cart ({cartCount})</NavLink>
          </nav>
        </div>
      </header>
      <WalletBar />
      <main className="mx-auto max-w-5xl p-4 md:py-8">
        <Routes>
          <Route index element={<ProductsPage />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:id" element={<OrderPage />} />
        </Routes>
      </main>
      <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-muted">A demo merchant. Payments are processed by {BRAND_NAME}: a sandbox, no real money.</footer>
    </div>
  );
}
