import { Badge, BenchMeter, Button, Card, Count, DataTable, ErrorNote, Field, Id, Input, ModuleTile, Money, PageHeader, Rupees, Skeleton, StatusBadge, formatMinorPlain, timeAgo } from '@zerodrift/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import type { ChaosStatus, Overview, Payment, Run } from '../types.js';

interface LoadResult { runId: string; durationMs: number; requested: number; duplicatesSent: number; byHttpStatus: Record<string, number>; byPaymentStatus: Record<string, number>; distinctPayments: number; errors: number }

/** The bench modules: a tile per real service the controller can break, plus the network. */
const MODULES: { tile: string; service: string }[] = [
  { tile: 'payments', service: 'payments' },
  { tile: 'ledger', service: 'ledger' },
  { tile: 'webhooks', service: 'webhook' },
  { tile: 'gateway', service: 'mock-gateway' },
  { tile: 'kafka', service: 'kafka' },
];

const FAULTS: { key: string; label: string; hint: string }[] = [
  { key: 'lostResponseRate', label: 'Lost responses', hint: 'the bank charges but never replies (worst case)' },
  { key: 'errorRate', label: 'Gateway errors (HTTP 500)', hint: 'request fails before the bank does anything' },
  { key: 'declineRate', label: 'Declines', hint: 'the bank refuses: a definite failure' },
  { key: 'duplicateCallbackRate', label: 'Duplicate callbacks', hint: 'async notifications delivered twice' },
  { key: 'callbackDropRate', label: 'Dropped callbacks', hint: 'async notifications never arrive' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (path: string, body: unknown = {}) => api(path, { method: 'POST', body });
const totalPayments = (o?: Overview | null) => Object.values(o?.payments?.byStatus ?? {}).reduce((a, b) => a + b, 0);

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

  // ---- real counters shown on the bench
  const [faults, setFaults] = useState(0); // chaos actions this page sent and the controller accepted
  const [shake, setShake] = useState<Record<string, number>>({});
  const baseline = useRef<number | null>(null); // total payments when a test started
  const [transfers, setTransfers] = useState(0);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [running, setRunning] = useState(false);

  const [gw, setGw] = useState<Record<string, number>>({ lostResponseRate: 0, errorRate: 0, declineRate: 0, duplicateCallbackRate: 0, callbackDropRate: 0, latencyMaxMs: 0 });
  const seeded = useRef(false);
  useEffect(() => {
    const g = status.data?.gateway;
    if (!seeded.current && g && !('error' in g)) {
      seeded.current = true; // seed the sliders once from the live settings, then let the user drive them
      setGw((f) => ({ ...f, ...Object.fromEntries(Object.entries(g).filter(([k]) => k in f)) }));
    }
  }, [status.data]);

  const [load, setLoad] = useState({ count: 30, duplicates: 10 });
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [latencyMs, setLatencyMs] = useState(800);

  // the transfers counter follows the real total of payments since the test began
  useEffect(() => {
    if (baseline.current !== null) setTransfers(Math.max(0, totalPayments(overview.data) - baseline.current));
  }, [overview.data]);

  const refresh = useCallback(() => {
    status.reload();
    events.reload();
    overview.reload();
  }, [status, events, overview]);

  const fault = useCallback(async (tile: string, fn: () => Promise<unknown>) => {
    await fn();
    setFaults((n) => n + 1);
    setShake((s) => ({ ...s, [tile]: (s[tile] ?? 0) + 1 }));
  }, []);

  if (status.loading && !status.data) return <Skeleton rows={6} />;
  if (!status.data) return <ErrorNote error={status.error ?? 'No data'} onRetry={status.reload} />;
  if (!status.data.enabled) {
    return (
      <>
        <PageHeader title="Chaos bench" />
        <Card>
          <p className="text-sm">The chaos controller is <strong>disabled</strong> in this environment. It exists only in test mode (<code className="mono">CHAOS_ENABLED=true</code> and <code className="mono">NODE_ENV</code> not production) and refuses to start in production.</p>
        </Card>
      </>
    );
  }

  const services = status.data.services ?? [];
  const network = Array.isArray(status.data.network) ? status.data.network : [];
  const driftMinor = overview.data?.ledgerInvariants?.totalBalanceMinor ?? '0';
  const ledgerProxy = network.find((p) => p.name === 'ledger');
  const serviceOf = (name: string) => services.find((s) => s.service === name);

  // ------------------------------------------------------------ the real mini chaos test
  async function runTest() {
    setRunning(true);
    setResult(null);
    setFaults(0);
    baseline.current = totalPayments(overview.data);
    setTransfers(0);
    let injected = 0;
    const injectOnce = async () => {
      const pick = Math.random();
      try {
        if (pick < 0.5) {
          const svc = ['payments', 'ledger', 'webhook'][Math.floor(Math.random() * 3)]!;
          await post(`/api/chaos/services/${svc}/kill`, { restartAfterSeconds: 6 });
          setShake((s) => ({ ...s, [svc === 'webhook' ? 'webhooks' : svc]: (s[svc === 'webhook' ? 'webhooks' : svc] ?? 0) + 1 }));
        } else if (pick < 0.8) {
          await api('/api/chaos/gateway', { method: 'PUT', body: { latencyMinMs: 0, latencyMaxMs: 800, errorRate: 0.15, lostResponseRate: 0.15, declineRate: 0, duplicateCallbackRate: 0.2, callbackDropRate: 0.1 } });
          setShake((s) => ({ ...s, gateway: (s.gateway ?? 0) + 1 }));
          setTimeout(() => void post('/api/chaos/gateway/reset').catch(() => undefined), 7000);
        } else {
          await post('/api/chaos/network/ledger/toxics', { type: 'latency', name: 'bench_latency', attributes: { latency: 600, jitter: 200 } });
          setTimeout(() => void api('/api/chaos/network/ledger/toxics/bench_latency', { method: 'DELETE' }).catch(() => undefined), 6000);
        }
        injected++;
        setFaults((n) => n + 1);
      } catch {
        /* a fault that could not be injected is simply not counted */
      }
    };
    let stop = false;
    const injector = (async () => {
      await sleep(1000);
      while (!stop) {
        await injectOnce();
        await sleep(2500);
      }
    })();
    try {
      const r = await api<LoadResult>('/api/chaos/load', { method: 'POST', body: { count: 120, duplicateRate: 0.1 } });
      setLoadResult(r);
      stop = true;
      await injector;
      await post('/api/chaos/reset').catch(() => undefined);
      // wait for recovery: nothing may stay in flight
      let inflight = 1;
      for (let i = 0; i < 40 && inflight > 0; i++) {
        await sleep(3000);
        const o = await api<Overview>('/api/overview');
        inflight = o.payments?.inFlight.count ?? 0;
      }
      const inv = await api<{ ok: boolean; totalBalanceMinor: string }>('/api/ledger/invariants');
      const recon = await api<Run>('/api/recon/runs', { method: 'POST', body: { kind: 'internal' } }).catch(() => null);
      const clean = !!recon && recon.status === 'clean';
      const good = inv.ok && inflight === 0 && r.distinctPayments <= r.requested && (recon ? clean : false);
      setResult({
        ok: good,
        text: `${inv.ok ? 'books balanced' : 'BOOKS DO NOT BALANCE'} · drift ${formatMinorPlain(inv.totalBalanceMinor)} · ${injected} faults injected · ${r.distinctPayments} payments for ${r.requested} requests + ${r.duplicatesSent} duplicates · ${inflight === 0 ? 'nothing left in flight' : `${inflight} still in flight`} · internal reconciliation ${recon ? recon.status : 'unavailable'}`,
      });
    } catch (e) {
      stop = true;
      setResult({ ok: false, text: `the test could not finish: ${(e as Error).message}` });
    } finally {
      stop = true;
      refresh();
      setRunning(false);
    }
  }

  return (
    <>
      <div className="stage-top -m-4 rounded-panel p-5 md:m-0 md:p-8">
        <div className="mb-6">
          <h1 className="text-[40px] font-light leading-none tracking-[-0.04em] md:text-[44px]">chaos bench</h1>
          <p className="mono mt-2 max-w-xl text-xs text-on-stage-2">flip a switch to kill a service. or run the test: payments flood in, duplicates included, while things break at random. the needle should never leave zero.</p>
        </div>
        {act.error && <div className="mb-4"><ErrorNote error={act.error} /></div>}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.35fr)_repeat(3,minmax(0,1fr))]">
          <BenchMeter
            drift={driftMinor}
            kicks={faults}
            transfers={<Count value={transfers} rollIn={false} />}
            faults={<Count value={faults} rollIn={false} />}
            driftText={<Rupees minor={driftMinor} rollIn={false} />}
          />
          {MODULES.map(({ tile, service }) => {
            const s = serviceOf(service);
            const down = !!s && s.state !== 'running';
            return (
              <ModuleTile
                key={tile}
                name={tile}
                status={s ? `${s.state === 'running' ? 'running' : s.state === 'exited' ? 'stopped' : s.state} · ${s.status}` : 'not reported'}
                down={down}
                busy={!!act.busy || running}
                shake={shake[tile] ?? 0}
                onKill={() => act.run(`kill-${service}`, () => fault(tile, () => post(`/api/chaos/services/${service}/kill`, { restartAfterSeconds: 8 })), refresh)}
                onToggle={() => act.run(`toggle-${service}`, () => (down ? post(`/api/chaos/services/${service}/start`) : fault(tile, () => post(`/api/chaos/services/${service}/stop`))), refresh)}
              />
            );
          })}
          <ModuleTile
            name="network"
            status={ledgerProxy ? (!ledgerProxy.enabled ? 'partitioned · ledger link cut' : ledgerProxy.toxics.length ? `${ledgerProxy.toxics.map((t) => t.type).join(' + ')} on the ledger link` : 'clean · no toxics') : 'not reported'}
            down={!!ledgerProxy && (!ledgerProxy.enabled || ledgerProxy.toxics.length > 0)}
            busy={!!act.busy || running || !ledgerProxy}
            shake={shake.network ?? 0}
            killLabel="break network"
            onKill={() =>
              act.run('net-break', () =>
                fault('network', async () => {
                  await post('/api/chaos/network/ledger/toxics', { type: 'latency', name: 'bench_latency', attributes: { latency: 400, jitter: 100 } });
                  await post('/api/chaos/network/ledger/toxics', { type: 'timeout', name: 'bench_drop', toxicity: 0.3, attributes: { timeout: 0 } });
                  setTimeout(() => void Promise.all([api('/api/chaos/network/ledger/toxics/bench_latency', { method: 'DELETE' }), api('/api/chaos/network/ledger/toxics/bench_drop', { method: 'DELETE' })]).then(refresh).catch(() => undefined), 15_000);
                }), refresh)
            }
            onToggle={() => act.run('net-toggle', () => (ledgerProxy?.enabled === false ? post('/api/chaos/network/ledger/enabled', { enabled: true }) : fault('network', () => post('/api/chaos/network/ledger/enabled', { enabled: false }))), refresh)}
          />
          <div className="flex flex-wrap items-center justify-between gap-3.5 rounded-2xl border border-[#2a2a2a] bg-[#161616] px-[18px] py-4 sm:col-span-2 lg:col-span-4">
            <span role="status" aria-live="polite" className={`mono text-[13px] ${result ? (result.ok ? 'text-on-stage' : 'text-[#ff8a8e]') : 'text-on-stage-2'}`}>
              {running ? 'running: payments flooding in while faults land at random…' : result ? <>{result.ok && <b className="font-medium text-code-str">all invariants held · </b>}{result.text}</> : 'ready. press run to send 120 payments (10% duplicates) while services break.'}
            </span>
            <div className="flex gap-2">
              <Button variant="signal" size="lg" onClick={() => void runTest()} disabled={running || !!act.busy}>{running ? 'running…' : result ? 'run again' : 'run chaos test'}</Button>
              <Button variant="line" size="lg" onClick={() => act.run('reset', () => post('/api/chaos/reset'), () => { seeded.current = false; refresh(); })} disabled={running || !!act.busy}>reset</Button>
            </div>
          </div>
        </div>
        <p className="mono mt-4 text-xs text-on-stage-2">every action here is real: pods or containers are actually killed. the full 10,000-operation results are on the <Link className="text-on-stage underline" to="/#chaos-results">landing page</Link>.</p>
      </div>

      <h2 className="mb-3 mt-10 text-[17px] font-medium tracking-[-0.01em]">Fine controls</h2>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Mock bank faults" actions={<Button size="sm" onClick={() => act.run('gw-reset', () => post('/api/chaos/gateway/reset'), () => { seeded.current = false; setGw((f) => Object.fromEntries(Object.keys(f).map((k) => [k, 0]))); refresh(); })} disabled={!!act.busy}>Clear</Button>}>
          <div className="space-y-3">
            {FAULTS.map((f) => (
              <label key={f.key} className="block text-sm">
                <div className="flex justify-between"><span className="font-medium">{f.label}</span><span className="mono text-muted">{Math.round((gw[f.key] ?? 0) * 100)}%</span></div>
                <input type="range" min={0} max={100} step={5} value={Math.round((gw[f.key] ?? 0) * 100)} onChange={(e) => setGw({ ...gw, [f.key]: Number(e.target.value) / 100 })} className="w-full" aria-label={f.label} />
                <div className="text-xs text-muted">{f.hint}</div>
              </label>
            ))}
            <label className="block text-sm">
              <div className="flex justify-between"><span className="font-medium">Added latency (max)</span><span className="mono text-muted">{gw.latencyMaxMs} ms</span></div>
              <input type="range" min={0} max={3000} step={100} value={gw.latencyMaxMs ?? 0} onChange={(e) => setGw({ ...gw, latencyMaxMs: Number(e.target.value) })} className="w-full" aria-label="Added latency" />
            </label>
            <Button variant="primary" disabled={!!act.busy} onClick={() => act.run('gw-apply', () => api('/api/chaos/gateway', { method: 'PUT', body: { ...gw, latencyMinMs: 0 } }), refresh)}>Apply to the mock bank</Button>
          </div>
        </Card>

        <Card title="Network (Toxiproxy)">
          {network.length === 0 ? <p className="text-sm text-muted">No proxies reported.</p> : (
            <ul className="divide-y divide-rule">
              {network.map((p) => (
                <li key={p.name} className="space-y-2 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{p.name} <span className="mono text-xs text-muted">→ {p.upstream}</span></span>
                    <StatusBadge status={p.enabled ? 'up' : 'down'} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`cut-${p.name}`, () => post(`/api/chaos/network/${p.name}/enabled`, { enabled: !p.enabled }), refresh)}>{p.enabled ? 'Cut link' : 'Restore link'}</Button>
                    <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`lat-${p.name}`, () => post(`/api/chaos/network/${p.name}/toxics`, { type: 'latency', name: 'latency_downstream', attributes: { latency: latencyMs, jitter: Math.round(latencyMs / 4) } }), refresh)}>Add {latencyMs} ms latency</Button>
                    <Button size="sm" disabled={!!act.busy} onClick={() => act.run(`to-${p.name}`, () => post(`/api/chaos/network/${p.name}/toxics`, { type: 'timeout', name: 'timeout_downstream', attributes: { timeout: 0 } }), refresh)}>Black-hole traffic</Button>
                  </div>
                  {p.toxics.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {p.toxics.map((t) => (
                        <li key={t.name}><Badge tone="warn">{t.type}</Badge> <button type="button" className="text-xs underline" onClick={() => act.run(`rm-${t.name}`, () => api(`/api/chaos/network/${p.name}/toxics/${t.name}`, { method: 'DELETE' }), refresh)}>remove</button></li>
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
          <div className="mt-3"><Button variant="primary" disabled={!!act.busy || running} onClick={() => act.run('load', async () => setLoadResult(await api<LoadResult>('/api/chaos/load', { method: 'POST', body: { count: load.count, duplicateRate: load.duplicates / 100 } })))}>{act.busy === 'load' ? 'Sending…' : 'Fire payments'}</Button></div>
          {loadResult && (
            <div className="mt-4 rounded-nav bg-paper p-3 text-sm">
              <div><strong>{loadResult.requested}</strong> payments + <strong>{loadResult.duplicatesSent}</strong> duplicate requests in {(loadResult.durationMs / 1000).toFixed(1)}s</div>
              <div className="mt-1">Distinct payments created: <strong>{loadResult.distinctPayments}</strong> {loadResult.distinctPayments <= loadResult.requested ? <Badge tone="success">duplicates did not double-charge</Badge> : <Badge tone="danger">MORE than requested!</Badge>}</div>
              <div className="mono mt-1 text-xs text-muted">HTTP: {Object.entries(loadResult.byHttpStatus).map(([k, v]) => `${k}×${v}`).join('  ')} · results: {Object.entries(loadResult.byPaymentStatus).map(([k, v]) => `${k}×${v}`).join('  ')}{loadResult.errors ? ` · ${loadResult.errors} request errors` : ''}</div>
            </div>
          )}
        </Card>

        <Card title="What you did">
          <DataTable
            rows={events.data?.events ?? []}
            rowKey={(e) => `${e.at}-${e.action}-${e.target}`}
            empty="Nothing yet."
            columns={[
              { header: 'when', cell: (e) => <span className="mono text-[13px] text-muted">{timeAgo(e.at)}</span> },
              { header: 'action', cell: (e) => e.action.replace(/_/g, ' ') },
              { header: 'target', cell: (e) => e.target },
            ]}
          />
        </Card>
      </div>

      <Card title="Live: recent payments" className="mt-4" actions={<Link className="text-xs underline" to="/app/payments">All payments</Link>}>
        <DataTable
          rows={recent.data?.payments ?? []}
          rowKey={(p) => p.id}
          empty="No payments yet: fire some load."
          columns={[
            { header: 'payment', cell: (p) => <Link className="underline" to={`/app/payments/${p.id}`}><Id id={p.id} /></Link> },
            { header: 'amount', cell: (p) => <Money minor={p.amountMinor} />, className: 'text-right' },
            { header: 'status', cell: (p) => <StatusBadge status={p.status} /> },
            { header: 'age', cell: (p) => <span className="mono text-[13px] text-muted">{timeAgo(p.createdAt)}</span> },
          ]}
        />
        <p className="mt-2 text-xs text-muted">A payment stuck in <em>processing</em> is an UNKNOWN outcome: funds stay held until recovery learns the truth from the bank.</p>
      </Card>
    </>
  );
}
