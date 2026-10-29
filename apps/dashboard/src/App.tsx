import { BRAND_NAME } from '@zerodrift/brand';
import { Button } from '@zerodrift/ui';
import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { RequireAuth, useAuth } from './auth.js';
import { AccountDetailPage, AccountsPage } from './pages/Accounts.js';
import { ChaosPage } from './pages/Chaos.js';
import { LedgerPage } from './pages/Ledger.js';
import { LoginPage } from './pages/Login.js';
import { MetricsPage } from './pages/Metrics.js';
import { OverviewPage } from './pages/Overview.js';
import { PaymentDetailPage, PaymentsPage } from './pages/Payments.js';
import { ReconciliationPage } from './pages/Reconciliation.js';
import { WebhooksPage } from './pages/Webhooks.js';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/payments', label: 'Payments' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/webhooks', label: 'Webhooks' },
  { to: '/reconciliation', label: 'Reconciliation' },
  { to: '/metrics', label: 'Metrics' },
  { to: '/chaos', label: 'Chaos' },
];

function Shell() {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-surface md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-4 md:block">
          <div className="text-lg font-semibold tracking-tight">{BRAND_NAME}</div>
          <div className="text-xs text-muted md:mt-0.5">Operator console</div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-0.5 md:overflow-visible md:pb-0">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `block whitespace-nowrap rounded-md px-3 py-2 text-sm ${isActive ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-4 py-4 md:block">
          <div className="mb-2 text-xs text-muted">Signed in as {user}</div>
          <Button size="sm" onClick={logout}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="payments/:id" element={<PaymentDetailPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="accounts/:id" element={<AccountDetailPage />} />
        <Route path="ledger" element={<LedgerPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="reconciliation" element={<ReconciliationPage />} />
        <Route path="metrics" element={<MetricsPage />} />
        <Route path="chaos" element={<ChaosPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
