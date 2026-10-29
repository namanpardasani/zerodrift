import { Inject, Injectable } from '@nestjs/common';
import { type DashboardConfig } from './config.js';
import { CONFIG } from './auth.js';

/**
 * The metrics page reads from Prometheus, but only through a FIXED set of queries: the dashboard
 * must not become an open PromQL proxy (expensive queries, data exposure).
 */
const INSTANT: Record<string, string> = {
  paymentsByStatus: 'sum by (to) (payment_transitions_total)',
  httpRatePerService: 'sum by (instance) (rate(http_requests_total[1m]))',
  gatewayCircuitOpen: 'max(gateway_circuit_open)',
  outboxBacklog: 'sum by (service) (outbox_backlog)',
  outboxPublished: 'sum by (service) (outbox_published_total)',
  consumerMessages: 'sum by (result) (consumer_messages_total)',
  webhookAttempts: 'sum by (result) (webhook_attempts_total)',
  webhookFinal: 'sum by (status) (webhook_deliveries_final_total)',
  reconOpen: 'sum by (kind, severity) (recon_open_mismatches)',
  recovered: 'sum by (outcome) (payments_recovered_total)',
  up: 'up',
};

const RANGE: Record<string, string> = {
  throughput: 'sum(rate(payment_transitions_total{to="succeeded"}[1m]))',
  failures: 'sum(rate(payment_transitions_total{to="failed"}[1m]))',
  http5xx: 'sum(rate(http_requests_total{status=~"5.."}[1m]))',
  gatewayCalls: 'sum by (outcome) (rate(gateway_calls_total[1m]))',
};

interface PromVector {
  status: string;
  data: { result: { metric: Record<string, string>; value?: [number, string]; values?: [number, string][] }[] };
}

@Injectable()
export class MetricsService {
  /** Prometheus is optional for the console: after a failure, stop trying for a while (see queryOnce). */
  private downUntil = 0;
  private summaryCache?: { at: number; value: Awaited<ReturnType<MetricsService['computeSummary']>> };

  constructor(@Inject(CONFIG) private readonly config: DashboardConfig) {}

  private async query(path: string, params: Record<string, string>): Promise<PromVector | null> {
    // Negative cache: the summary fires ~11 queries at once. If Prometheus is down (and resolving its name
    // is slow), retrying on every poll would tie up DNS/connection capacity that other calls need.
    if (Date.now() < this.downUntil) return null;
    try {
      const res = await fetch(`${this.config.upstreams.prometheus}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as PromVector;
    } catch {
      this.downUntil = Date.now() + 10_000;
      return null; // Prometheus down: the page shows "unavailable", it does not break
    }
  }

  /** Cached for a few seconds so several open pages (or tabs) share one round of queries. */
  async summary() {
    const hit = this.summaryCache;
    if (hit && Date.now() - hit.at < 4_000) return hit.value;
    const value = await this.computeSummary();
    this.summaryCache = { at: Date.now(), value };
    return value;
  }

  private async computeSummary() {
    const out: Record<string, { labels: Record<string, string>; value: number }[]> = {};
    let available = true;
    await Promise.all(
      Object.entries(INSTANT).map(async ([name, promql]) => {
        const r = await this.query('/api/v1/query', { query: promql });
        if (!r) {
          available = false;
          out[name] = [];
          return;
        }
        out[name] = r.data.result.map((s) => ({ labels: s.metric, value: Number(s.value?.[1] ?? 0) }));
      }),
    );
    return { available, series: out };
  }

  async range(name: string, minutes = 15, stepSeconds = 15) {
    const promql = RANGE[name];
    if (!promql) return null;
    const end = Math.floor(Date.now() / 1000);
    const r = await this.query('/api/v1/query_range', { query: promql, start: String(end - minutes * 60), end: String(end), step: String(stepSeconds) });
    if (!r) return { available: false, series: [] };
    return { available: true, series: r.data.result.map((s) => ({ labels: s.metric, points: (s.values ?? []).map(([t, v]) => ({ t, v: Number(v) })) })) };
  }

  static readonly rangeNames = Object.keys(RANGE);
}
