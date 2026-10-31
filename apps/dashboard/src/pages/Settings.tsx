import { BRAND_NAME } from '@zerodrift/brand';
import { Button, Card, ErrorNote, KeyValue, PageHeader, Skeleton, StatusBadge } from '@zerodrift/ui';
import { useAuth } from '../auth.js';
import { useApi } from '../hooks.js';
import type { ChaosStatus, Overview } from '../types.js';

/** Who is signed in, which mode the platform is in, and which services answer: everything real, nothing configurable from here. */
export function SettingsPage() {
  const { user, logout } = useAuth();
  const overview = useApi<Overview>('/api/overview', { pollMs: 10_000 });
  const chaos = useApi<ChaosStatus>('/api/chaos/status');
  return (
    <>
      <PageHeader title="Settings" subtitle={`Read-only. ${BRAND_NAME} is configured through environment variables and Helm values, never from the browser.`} actions={<Button onClick={logout}>Sign out</Button>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Session">
          <KeyValue items={[['Signed in as', user ?? '-'], ['Token', 'kept in this tab only (sessionStorage), cleared when it closes']]} />
        </Card>
        <Card title="Mode">
          <KeyValue items={[['Chaos bench', chaos.data ? (chaos.data.enabled ? 'enabled (test mode)' : 'disabled') : '-'], ['Money', 'integer paise everywhere; INR only in v1']]} />
        </Card>
        <Card title="Services" className="lg:col-span-2">
          {overview.error && <ErrorNote error={overview.error} onRetry={overview.reload} />}
          {!overview.data ? (
            <Skeleton rows={4} />
          ) : (
            <ul className="divide-y divide-rule text-sm">
              {overview.data.services.map((s) => (
                <li key={s.name} className="flex items-center justify-between py-2.5">
                  <span>{s.name}</span>
                  <span className="flex items-center gap-4">
                    <span className="mono text-xs text-muted">{s.latencyMs === null ? '' : `${s.latencyMs} ms`}</span>
                    <StatusBadge status={s.up ? 'up' : 'down'} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
