import { ActivePill, Brand, Button, Skeleton, IconAccounts, IconAudit, IconChaos, IconLedger, IconMetrics, IconOverview, IconPayments, IconRecon, IconWebhooks, PageTransition, cx } from '@zerodrift/ui';
import { type ComponentType, type SVGProps, Suspense } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { useApi } from '../hooks.js';
import type { ChaosStatus } from '../types.js';

type Item = { to: string; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>>; end?: boolean; chaos?: boolean };
const NAV: Item[] = [
  { to: '/app', label: 'Overview', Icon: IconOverview, end: true },
  { to: '/app/payments', label: 'Payments', Icon: IconPayments },
  { to: '/app/accounts', label: 'Accounts', Icon: IconAccounts },
  { to: '/app/ledger', label: 'Ledger', Icon: IconLedger },
  { to: '/app/webhooks', label: 'Webhooks', Icon: IconWebhooks },
  { to: '/app/reconciliation', label: 'Reconciliation', Icon: IconRecon },
  { to: '/app/audit', label: 'Audit log', Icon: IconAudit },
  { to: '/app/metrics', label: 'Metrics', Icon: IconMetrics },
  { to: '/app/chaos', label: 'Chaos bench', Icon: IconChaos, chaos: true },
];

/** The paper app shell: a calm sidebar (active item = paper background that slides between items) and the page. */
export function Shell() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  // The chaos bench only exists in test mode: the nav item is hidden when the controller says it is disabled/unreachable.
  const chaos = useApi<ChaosStatus>('/api/chaos/status', { pollMs: 30_000 });
  const chaosOn = chaos.data?.enabled === true;
  const items = NAV.filter((n) => !n.chaos || chaosOn);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-rule bg-card md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="md:sticky md:top-0 md:flex md:h-screen md:flex-col md:gap-5 md:px-4 md:py-[22px]">
        <div className="flex items-center justify-between px-4 py-3 md:px-2 md:py-0">
          <Link to="/" aria-label="Home"><Brand /></Link>
          {chaosOn && <span className="mono rounded-full border border-signal px-2.5 py-1 text-[11px] text-signal-text md:hidden">test mode</span>}
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0.5 md:overflow-visible md:px-0 md:pb-0">
          {items.map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('relative isolate flex items-center gap-2.5 whitespace-nowrap rounded-nav px-2.5 py-2 text-sm', isActive ? 'font-medium text-ink' : 'text-ink-2 hover:text-ink')}>
              {({ isActive }) => (
                <>
                  {isActive && <ActivePill />}
                  <Icon className="h-[18px] w-[18px] flex-none" />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-3 md:block">
          {chaosOn && <span className="mono inline-block rounded-full border border-signal px-2.5 py-1 text-[11px] text-signal-text">test mode</span>}
          <div className="text-xs text-muted">Signed in as {user}</div>
          <div className="flex gap-2">
            <Link to="/app/settings" className="rounded-btn border border-rule px-2.5 py-1 text-xs hover:bg-paper">Settings</Link>
            <Button size="sm" onClick={logout}>Sign out</Button>
          </div>
        </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 bg-card p-4 md:p-8">
        <PageTransition key={loc.pathname}>
          <Suspense fallback={<Skeleton rows={6} />}>
            <Outlet />
          </Suspense>
        </PageTransition>
      </main>
    </div>
  );
}
