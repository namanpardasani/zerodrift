import { Badge, Button, Card, DataTable, ErrorNote, Field, Id, Input, Money, PageHeader, Spinner, Stat, StatusBadge, timeAgo } from '@zerodrift/ui';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { ChaosStatus, Overview, Payment } from '../types.js';

interface LoadResult { runId: string; durationMs: number; requested: number; duplicatesSent: number; byHttpStatus: Record<string, number>; byPaymentStatus: Record<string, number>; distinctPayments: number; errors: number }

const FAULTS: { key: string; label: string; hint: string }[] = [
  { key: 'lostResponseRate', label: 'Lost responses', hint: 'the bank charges but never replies (worst case)' },
  { key: 'errorRate', label: 'Gateway errors (HTTP 500)', hint: 'request fails before the bank does anything' },
  { key: 'declineRate', label: 'Declines', hint: 'the bank refuses: a definite failure' },
  { key: 'duplicateCallbackRate', label: 'Duplicate callbacks', hint: 'async notifications delivered twice' },
  { key: 'callbackDropRate', label: 'Dropped callbacks', hint: 'async notifications never arrive' },
];

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  async function run(name: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, run };
}

export function ChaosPage() {
  const status = useApi<ChaosStatus>('/api/chaos/status', { pollMs: 2000 });
  const overview = useApi<Overview>('/api/overview', { pollMs: 2000 });
  const events = useApi<{ events: { at: string; action: string; target: string; detail?: unknown }[] }>('/api/chaos/events', { pollMs: 2000 });
  const recent = useApi<{ payments: Payment[] }>('/api/payments?limit=8', { pollMs: 1500 });
  const act = useAction();

  const [faults, setFaults] = useState<Record<string, number>>({ lostResponseRate: 0, errorRate: 0, declineRate: 0, duplicateCallbackRate: 0, callbackDropRate: 0, latencyMaxMs: 0 });
  const seeded = useRef(false);
  useEffect(() => {
    const g = status.data?.gateway;
    if (!seeded.current && g && !('error' in g)) {
      seeded.current = true; // seed the sliders once from the live settings, then let the user drive them
      setFaults((f) => ({ ...f, ...Object.fromEntries(Object.entries(g).filter(([k]) => k in f)) }));
    }
  }, [status.data]);

  const [load, setLoad] = useState({ count: 30, duplicates: 10 });
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [latencyMs, setLatencyMs] = useState(800);
  const [autoRestart, setAutoRestart] = useState(true);

  const refresh = () => {
    status.reload();
    events.reload();
  };

  if (status.loading && !status.data) return <Spinner />;
  if (!status.data) return <ErrorNote error={status.error ?? 'No data'} onRetry={status.reload} />;
  if (!status.data.enabled) {
    return (
      <>
        <PageHeader title="Chaos" />
        <Card>
          <p className="text-sm">The chaos controller is <strong>disabled</strong> in this environment. It exists only in development (<code>CHAOS_ENABLED=true</code> and <code>NODE_ENV</code> not production) and refuses to start in production.</p>
        </Card>
      </>
    );
  }

  const inflight = overview.data?.payments?.inFlight;
  const network = Array.isArray(status.data.network) ? status.data.network : [];
  const services = status.data.services ?? [];

  return (
    <>
      <PageHeader
        title="Chaos"
        subtitle="Break things on purpose and watch the system heal. Every action here is real: containers are actually killed."
        actions={<Button variant="danger" onClick={() => act.run('reset', () => api('/api/chaos/reset', { method: 'POST', body: {} }), () => { seeded.current = false; refresh(); })} disabled={!!act.busy}>Reset everything</Button>}
      />
      {act.error && <div className="mb-4"><ErrorNote error={act.error} /></div>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Payments in flight" value={inflight?.count ?? '-'} tone={inflight && inflight.count > 0 ? 'warn' : 'success'} hint={inflight && inflight.count > 0 ? `oldest ${inflight.oldestSeconds}s: waiting for recovery` : 'all settled'} />
        <Stat label="Ledger books" value={overview.data?.ledgerInvariants ? (overview.data.ledgerInvariants.ok ? 'Balanced' : 'VIOLATION') : '-'} tone={overview.data?.ledgerInvariants?.ok ? 'success' : 'danger'} hint="the invariant that must never break" />
        <Stat label="Dead-lettered webhooks" value={overview.data?.webhooks?.dead ?? 0} tone={(overview.data?.webhooks?.dead ?? 0) > 0 ? 'danger' : undefined} />
        <div className="flex items-end"><Button variant="primary" className="w-full" onClick={() => act.run('recovery', () => api('/api/recovery/run', { method: 'POST', body: {} }))} disabled={!!act.busy}>{act.busy === 'recovery' ? 'Running…' : 'Run recovery now'}</Button></div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Services">
          <ul className="divide-y divide-border">
            {services.map((s) => (
              <li key={s.service} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="flex items-center gap-3"><span className="w-32 text-sm font-medium">{s.service}</span><StatusBadge status={s.state === 'running' ? 'up' : s.state} /></div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="danger" disabled={!!act.busy} onClick={() => act.run(`kill-${s.service}`, () => api(`/api/chaos/services/${s.service}/kill`, { method: 'POST', body: { restartAfterSeconds: autoRestart ? 8 : 0 } }), refresh)}>Kill</Button>
                  <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`restart-${s.service}`, () => api(`/api/chaos/services/${s.service}/restart`, { method: 'POST', body: {} }), refresh)}>Restart</Button>
                  {s.state === 'paused' ? (
                    <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`unpause-${s.service}`, () => api(`/api/chaos/services/${s.service}/unpause`, { method: 'POST', body: {} }), refresh)}>Resume</Button>
                  ) : (
                    <Button size="sm" disabled={!!act.busy || s.state !== 'running'} onClick={() => act.run(`pause-${s.service}`, () => api(`/api/chaos/services/${s.service}/pause`, { method: 'POST', body: {} }), refresh)}>{s.service === 'kafka' ? 'Pause Kafka' : 'Freeze'}</Button>
                  )}
                  {s.state === 'exited' && <Button size="sm" variant="primary" disabled={!!act.busy} onClick={() => act.run(`start-${s.service}`, () => api(`/api/chaos/services/${s.service}/start`, { method: 'POST', body: {} }), refresh)}>Start</Button>}
                </div>
              </li>
            ))}
          </ul>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={autoRestart} onChange={(e) => setAutoRestart(e.target.checked)} /> Restart a killed service after 8 seconds <span className="text-xs text-muted">(emulates an orchestrator; Docker alone would leave it dead)</span></label>
          <p className="mt-2 text-xs text-muted">Kill = crash (SIGKILL). Freeze = the process hangs without dying. Databases and the console itself are deliberately not listed.</p>
        </Card>

        <Card title="Mock bank faults" actions={<Button size="sm" onClick={() => act.run('gw-reset', () => api('/api/chaos/gateway/reset', { method: 'POST', body: {} }), () => { seeded.current = false; setFaults((f) => Object.fromEntries(Object.keys(f).map((k) => [k, 0]))); refresh(); })} disabled={!!act.busy}>Clear</Button>}>
          <div className="space-y-3">
            {FAULTS.map((f) => (
              <label key={f.key} className="block text-sm">
                <div className="flex justify-between"><span className="font-medium">{f.label}</span><span className="tabular-nums text-muted">{Math.round((faults[f.key] ?? 0) * 100)}%</span></div>
                <input type="range" min={0} max={100} step={5} value={Math.round((faults[f.key] ?? 0) * 100)} onChange={(e) => setFaults({ ...faults, [f.key]: Number(e.target.value) / 100 })} className="w-full accent-[var(--accent)]" aria-label={f.label} />
                <div className="text-xs text-muted">{f.hint}</div>
              </label>
            ))}
            <label className="block text-sm">
              <div className="flex justify-between"><span className="font-medium">Added latency (max)</span><span className="tabular-nums text-muted">{faults.latencyMaxMs} ms</span></div>
              <input type="range" min={0} max={3000} step={100} value={faults.latencyMaxMs ?? 0} onChange={(e) => setFaults({ ...faults, latencyMaxMs: Number(e.target.value) })} className="w-full accent-[var(--accent)]" aria-label="Added latency" />
            </label>
            <Button variant="primary" disabled={!!act.busy} onClick={() => act.run('gw-apply', () => api('/api/chaos/gateway', { method: 'PUT', body: { ...faults, latencyMinMs: 0 } }), refresh)}>Apply to the mock bank</Button>
          </div>
        </Card>

        <Card title="Network (Toxiproxy)">
          {network.length === 0 ? <p className="text-sm text-muted">No proxies reported.</p> : (
            <ul className="divide-y divide-border">
              {network.map((p) => (
                <li key={p.name} className="space-y-2 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{p.name} <span className="text-xs text-muted">→ {p.upstream}</span></span>
                    <StatusBadge status={p.enabled ? 'up' : 'down'} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`cut-${p.name}`, () => api(`/api/chaos/network/${p.name}/enabled`, { method: 'POST', body: { enabled: !p.enabled } }), refresh)}>{p.enabled ? 'Cut link' : 'Restore link'}</Button>
                    <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`lat-${p.name}`, () => api(`/api/chaos/network/${p.name}/toxics`, { method: 'POST', body: { type: 'latency', name: 'latency_downstream', attributes: { latency: latencyMs, jitter: Math.round(latencyMs / 4) } } }), refresh)}>Add {latencyMs} ms latency</Button>
                    <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`to-${p.name}`, () => api(`/api/chaos/network/${p.name}/toxics`, { method: 'POST', body: { type: 'timeout', name: 'timeout_downstream', attributes: { timeout: 0 } } }), refresh)}>Black-hole traffic</Button>
                  </div>
                  {p.toxics.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {p.toxics.map((t) => (
                        <li key={t.name}><Badge tone="warn">{t.type}</Badge> <button type="button" className="text-xs text-accent underline" onClick={() => act.run(`rm-${t.name}`, () => api(`/api/chaos/network/${p.name}/toxics/${t.name}`, { method: 'DELETE' }), refresh)}>remove</button></li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 max-w-[12rem]"><Field label="Latency to add (ms)"><Input type="number" min={10} max={10000} value={latencyMs} onChange={(e) => setLatencyMs(Number(e.target.value))} /></Field></div>
          <p className="mt-2 text-xs text-muted">Payments reach the ledger and the bank through these proxies, so cutting one is a real network partition.</p>
        </Card>

        <Card title="Generate load">
          <div className="grid max-w-md grid-cols-2 gap-3">
            <Field label="Payments"><Input type="number" min={1} max={500} value={load.count} onChange={(e) => setLoad({ ...load, count: Number(e.target.value) })} /></Field>
            <Field label="Duplicate requests (%)" hint="same Idempotency-Key, resent"><Input type="number" min={0} max={50} value={load.duplicates} onChange={(e) => setLoad({ ...load, duplicates: Number(e.target.value) })} /></Field>
          </div>
          <div className="mt-3"><Button variant="primary" disabled={!!act.busy} onClick={() => act.run('load', async () => setLoadResult(await api<LoadResult>('/api/chaos/load', { method: 'POST', body: { count: load.count, duplicateRate: load.duplicates / 100 } })))}>{act.busy === 'load' ? 'Sending…' : 'Fire payments'}</Button></div>
          {loadResult && (
            <div className="mt-4 rounded-md bg-surface-2 p-3 text-sm">
              <div><strong>{loadResult.requested}</strong> payments + <strong>{loadResult.duplicatesSent}</strong> duplicate requests in {(loadResult.durationMs / 1000).toFixed(1)}s</div>
              <div className="mt-1">Distinct payments created: <strong>{loadResult.distinctPayments}</strong> {loadResult.distinctPayments <= loadResult.requested ? <Badge tone="success">duplicates did not double-charge</Badge> : <Badge tone="danger">MORE than requested!</Badge>}</div>
              <div className="mt-1 text-xs text-muted">HTTP: {Object.entries(loadResult.byHttpStatus).map(([k, v]) => `${k}×${v}`).join('  ')} · results: {Object.entries(loadResult.byPaymentStatus).map(([k, v]) => `${k}×${v}`).join('  ')}{loadResult.errors ? ` · ${loadResult.errors} request errors` : ''}</div>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Live: recent payments" actions={<Link className="text-xs text-accent underline" to="/payments">All payments</Link>}>
          <DataTable
            rows={recent.data?.payments ?? []}
            rowKey={(p) => p.id}
            empty="No payments yet: fire some load."
            columns={[
              { header: 'Payment', cell: (p) => <Link className="text-accent underline" to={`/payments/${p.id}`}><Id id={p.id} /></Link> },
              { header: 'Amount', cell: (p) => <Money minor={p.amountMinor} />, className: 'text-right' },
              { header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { header: 'Age', cell: (p) => <span className="text-muted">{timeAgo(p.createdAt)}</span> },
            ]}
          />
          <p className="mt-2 text-xs text-muted">A payment stuck in <em>processing</em> is an UNKNOWN outcome: funds stay held until recovery learns the truth from the bank.</p>
        </Card>

        <Card title="What you did">
          <DataTable
            rows={events.data?.events ?? []}
            rowKey={(e) => `${e.at}-${e.action}-${e.target}`}
            empty="Nothing yet."
            columns={[
              { header: 'When', cell: (e) => <span className="text-muted">{timeAgo(e.at)}</span> },
              { header: 'Action', cell: (e) => e.action.replace(/_/g, ' ') },
              { header: 'Target', cell: (e) => e.target },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
