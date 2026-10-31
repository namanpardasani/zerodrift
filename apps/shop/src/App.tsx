import { BRAND_NAME } from '@zerodrift/brand';
import { ActivePill, Button, MotionRoot, Money, PageTransition, cx } from '@zerodrift/ui';
import { useState } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { shopApi } from './api.js';
import { newId } from './ids.js';
import { CartPage } from './pages/Cart.js';
import { OrderPage, OrdersPage } from './pages/Orders.js';
import { ProductsPage } from './pages/Products.js';
import { useShop } from './shop-context.js';
import { SHOP_NAME, SHOP_TAGLINE } from './shopName.js';

const TOPUPS = [50_000, 100_000, 500_000];

/** A small line drawing of a cup: the only illustration the shop needs. */
function Cup({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M6 12h17v7a7 7 0 0 1-7 7h-3a7 7 0 0 1-7-7z" />
      <path d="M23 14h2.5a3 3 0 0 1 0 6H22" />
      <path d="M11 4c-1 1.5 1 2.5 0 4M16 4c-1 1.5 1 2.5 0 4" />
    </svg>
  );
}

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
    <div className="border-b border-rule bg-card">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">Shopping as</span>
          <input aria-label="Customer id" defaultValue={customerId} key={customerId} onBlur={(e) => e.target.value.trim() && e.target.value !== customerId && setCustomerId(e.target.value.trim())} className="mono w-36 rounded-nav border border-rule bg-paper px-2 py-1 text-xs" />
        </label>
        <span>Wallet <strong className="mono font-medium">{balance ? <Money minor={balance.availableMinor} /> : '…'}</strong>{balance && BigInt(balance.heldMinor) > 0n && <span className="ml-1 text-xs text-muted">(<Money minor={balance.heldMinor} /> on hold)</span>}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">Add funds</span>
          {TOPUPS.map((a) => <Button key={a} size="sm" disabled={busy} onClick={() => topUp(a)}>+<Money minor={a} /></Button>)}
        </span>
        {error && <span role="alert" className="text-failed-ink">{error}</span>}
      </div>
    </div>
  );
}

function ShopLayout() {
  const { cartCount } = useShop();
  const loc = useLocation();
  const link = (isActive: boolean) => cx('relative isolate rounded-nav px-3 py-1.5 text-sm', isActive ? 'font-medium text-ink' : 'text-muted hover:text-ink');
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="bg-paper">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
          <Link to="/" className="flex items-center gap-2.5 text-ink no-underline">
            <Cup className="h-8 w-8 text-shop-accent" />
            <span>
              <span className="shop-display block text-[26px] leading-none">{SHOP_NAME}</span>
              <span className="mt-1 block text-xs text-muted">{SHOP_TAGLINE}</span>
            </span>
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink to="/" end className={({ isActive }) => link(isActive)}>{({ isActive }) => <>{isActive && <ActivePill group="shop" className="bg-shop-accent-soft" />}Menu</>}</NavLink>
            <NavLink to="/orders" className={({ isActive }) => link(isActive)}>{({ isActive }) => <>{isActive && <ActivePill group="shop" className="bg-shop-accent-soft" />}Orders</>}</NavLink>
            <NavLink to="/cart" className={({ isActive }) => cx(link(isActive), 'ml-1 border border-rule bg-card')}>{({ isActive }) => <>{isActive && <ActivePill group="shop" className="bg-shop-accent-soft" />}Cart ({cartCount})</>}</NavLink>
          </nav>
        </div>
      </header>
      <WalletBar />
      <main className="mx-auto max-w-5xl p-4 md:py-8">
        <PageTransition key={loc.pathname}>
          <Outlet />
        </PageTransition>
      </main>
      <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-muted">{SHOP_NAME} is a demo merchant. Payments are processed by {BRAND_NAME}: a sandbox, no real money.</footer>
    </div>
  );
}

export function App() {
  return (
    <MotionRoot>
      <Routes>
        <Route element={<ShopLayout />}>
          <Route index element={<ProductsPage />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:id" element={<OrderPage />} />
        </Route>
      </Routes>
    </MotionRoot>
  );
}
