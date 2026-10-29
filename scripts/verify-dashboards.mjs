// Verifies the Grafana dashboard against the RUNNING stack:
//   1. Grafana has loaded (provisioned) the dashboard
//   2. every panel query is valid PromQL and runs against the live Prometheus
//   3. reports which panels already have data (event-driven metrics only appear after their first event)
// Usage: node scripts/verify-dashboards.mjs   (env: PROMETHEUS_URL, GRAFANA_URL)
import { readFileSync } from 'node:fs';

const PROM = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const dashboard = JSON.parse(readFileSync('infra/grafana/dashboards/zerodrift.json', 'utf8'));
let failed = 0;

const g = await fetch(`${GRAFANA}/api/dashboards/uid/${dashboard.uid}`).catch(() => null);
if (g?.ok) console.log(`ok   Grafana has loaded "${(await g.json()).dashboard.title}"`);
else {
  failed++;
  console.log(`FAIL Grafana does not have dashboard ${dashboard.uid} (HTTP ${g?.status ?? 'unreachable'})`);
}

const panels = dashboard.panels.filter((p) => p.type !== 'row');
let withData = 0;
for (const p of panels) {
  for (const t of p.targets) {
    const res = await fetch(`${PROM}/api/v1/query?${new URLSearchParams({ query: t.expr })}`).catch(() => null);
    const body = res ? await res.json().catch(() => null) : null;
    if (!res?.ok || body?.status !== 'success') {
      failed++;
      console.log(`FAIL "${p.title}" [${t.refId}]: ${body?.error ?? `HTTP ${res?.status ?? 'unreachable'}`}\n     ${t.expr}`);
      continue;
    }
    const n = body.data.result.length;
    if (n > 0) withData++;
    console.log(`${n > 0 ? 'ok  ' : 'ok* '} ${p.title} [${t.refId}] -> ${n} series${n === 0 ? ' (valid query, no data yet)' : ''}`);
  }
}
console.log(`\n${panels.length} panels, ${panels.reduce((n, p) => n + p.targets.length, 0)} queries, ${withData} returning data now, ${failed} failures`);
process.exit(failed ? 1 : 0);
