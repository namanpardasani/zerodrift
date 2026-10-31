import { type ComponentType, Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Skeleton } from '@zerodrift/ui';
import { RequireAuth } from './auth.js';
import { LandingPage } from './landing/Landing.js';
import { LoginPage } from './pages/Login.js';
import { NotFoundPage } from './pages/NotFound.js';
import { Shell } from './shell/Shell.js';

/** The app's pages load on demand: the landing page (the first thing most visitors see) stays small. */
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const OverviewPage = page(() => import('./pages/Overview.js'), 'OverviewPage');
const PaymentsPage = page(() => import('./pages/Payments.js'), 'PaymentsPage');
const PaymentDetailPage = page(() => import('./pages/Payments.js'), 'PaymentDetailPage');
const AccountsPage = page(() => import('./pages/Accounts.js'), 'AccountsPage');
const AccountDetailPage = page(() => import('./pages/Accounts.js'), 'AccountDetailPage');
const LedgerPage = page(() => import('./pages/Ledger.js'), 'LedgerPage');
const WebhooksPage = page(() => import('./pages/Webhooks.js'), 'WebhooksPage');
const WebhookDeliveryPage = page(() => import('./pages/Webhooks.js'), 'WebhookDeliveryPage');
const ReconciliationPage = page(() => import('./pages/Reconciliation.js'), 'ReconciliationPage');
const AuditPage = page(() => import('./pages/Audit.js'), 'AuditPage');
const MetricsPage = page(() => import('./pages/Metrics.js'), 'MetricsPage');
const ChaosPage = page(() => import('./pages/Chaos.js'), 'ChaosPage');
const SettingsPage = page(() => import('./pages/Settings.js'), 'SettingsPage');
const StyleguidePage = page(() => import('./pages/Styleguide.js'), 'StyleguidePage');

/**
 * Routes. Public: the landing page, the style guide, login. The app lives under /app and needs a session.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/styleguide" element={<Suspense fallback={<Skeleton rows={6} className="p-8" />}><StyleguidePage /></Suspense>} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/app"
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
        <Route path="webhooks/:id" element={<WebhookDeliveryPage />} />
        <Route path="reconciliation" element={<ReconciliationPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="metrics" element={<MetricsPage />} />
        <Route path="chaos" element={<ChaosPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage inApp />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
