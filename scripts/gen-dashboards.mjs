// Generates the Grafana dashboard JSON from code, so dashboards are reviewable, diffable and reproducible.
//   node scripts/gen-dashboards.mjs      -> writes infra/grafana/dashboards/zerodrift.json
// Grafana loads it automatically (provisioning); verify the queries with scripts/verify-dashboards.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';

const DS = { type: 'prometheus', uid: 'prometheus' };
let nextId = 1;
const targets = (list) => list.map((t, i) => ({ refId: String.fromCharCode(65 + i), datasource: DS, expr: t.expr, legendFormat: t.legend ?? '', range: true }));

const timeseries = (title, list, x, y, w, h, { unit = 'short', description = '', stack = false } = {}) => ({
  id: nextId++, type: 'timeseries', title, description, datasource: DS, gridPos: { x, y, w, h },
  fieldConfig: { defaults: { unit, custom: { lineWidth: 2, fillOpacity: stack ? 30 : 8, stacking: { mode: stack ? 'normal' : 'none' }, showPoints: 'never' } }, overrides: [] },
  options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'desc' } },
  targets: targets(list),
});

const stat = (title, expr, x, y, w, h, { unit = 'short', description = '', steps, mappings = [] } = {}) => ({
  id: nextId++, type: 'stat', title, description, datasource: DS, gridPos: { x, y, w, h },
  fieldConfig: { defaults: { unit, mappings, thresholds: { mode: 'absolute', steps: steps ?? [{ color: 'green', value: null }] } }, overrides: [] },
  options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'area', textMode: 'auto' },
  targets: targets([{ expr }]),
});

const row = (title, y) => ({ id: nextId++, type: 'row', title, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] });
const green = { color: 'green', value: null };
const red = (v) => ({ color: 'red', value: v });
const orange = (v) => ({ color: 'orange', value: v });

const circuitMap = [{ type: 'value', options: { '0': { text: 'Closed', color: 'green' }, '0.5': { text: 'Half-open', color: 'orange' }, '1': { text: 'OPEN', color: 'red' } } }];

const panels = [
  row('Health at a glance', 0),
  stat('Payments succeeded (5m)', 'sum(increase(payment_transitions_total{to="succeeded"}[5m]))', 0, 1, 3, 4),
  stat('Payments failed (5m)', 'sum(increase(payment_transitions_total{to="failed"}[5m]))', 3, 1, 3, 4, { steps: [green, orange(1), red(20)] }),
  stat('Server errors (5m)', 'sum(increase(http_requests_total{status=~"5.."}[5m]))', 6, 1, 3, 4, { steps: [green, red(1)], description: 'HTTP 5xx responses across all services. Should be 0.' }),
  stat('Gateway circuit', 'max(gateway_circuit_open)', 9, 1, 3, 4, { mappings: circuitMap, steps: [green, orange(0.4), red(0.9)], description: 'OPEN = payments is failing fast instead of calling a struggling bank.' }),
  stat('Outbox backlog', 'sum(outbox_backlog)', 12, 1, 3, 4, { steps: [green, orange(100), red(1000)], description: 'Events written to the database but not yet published to Kafka.' }),
  stat('Max consumer lag', 'max(kafka_consumer_lag)', 15, 1, 3, 4, { steps: [green, orange(100), red(1000)], description: 'Messages the slowest consumer group has not processed yet.' }),
  stat('Open reconciliation findings', 'sum(recon_open_mismatches{severity=~"critical|warning"})', 18, 1, 3, 4, { steps: [green, red(1)], description: 'Findings in the latest reconciliation runs. Should be 0.' }),
  stat('Dead-lettered', '(sum(consumer_messages_total{result="dead_lettered"}) or vector(0)) + (sum(webhook_deliveries_final_total{status="dead"}) or vector(0))', 21, 1, 3, 4, { steps: [green, red(1)], description: 'Kafka messages and webhook deliveries that exhausted their retries.' }),

  row('Throughput and errors', 5),
  timeseries('Payments per second by outcome', [{ expr: 'sum by (to) (rate(payment_transitions_total{to=~"succeeded|failed"}[1m]))', legend: '{{to}}' }], 0, 6, 8, 8, { unit: 'reqps', stack: true }),
  timeseries('HTTP requests per second by service', [{ expr: 'sum by (job) (rate(http_requests_total[1m]))', legend: '{{job}}' }], 8, 6, 8, 8, { unit: 'reqps' }),
  timeseries('Server error ratio (5xx) by service', [{ expr: 'sum by (job) (rate(http_requests_total{status=~"5.."}[1m])) / sum by (job) (rate(http_requests_total[1m]))', legend: '{{job}}' }], 16, 6, 8, 8, { unit: 'percentunit', description: 'Share of requests that failed with a server error.' }),

  row('Latency', 14),
  timeseries('HTTP latency percentiles (all services)', [
    { expr: 'histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', legend: 'p50' },
    { expr: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', legend: 'p95' },
    { expr: 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', legend: 'p99' },
  ], 0, 15, 8, 8, { unit: 's' }),
  timeseries('p95 latency by service', [{ expr: 'histogram_quantile(0.95, sum by (le, job) (rate(http_request_duration_seconds_bucket[5m])))', legend: '{{job}}' }], 8, 15, 8, 8, { unit: 's' }),
  timeseries('Webhook attempt duration p95', [{ expr: 'histogram_quantile(0.95, sum by (le) (rate(webhook_attempt_duration_seconds_bucket[5m])))', legend: 'p95' }], 16, 15, 8, 8, { unit: 's', description: 'How long merchants take to answer our webhook calls.' }),

  row('Kafka and the outbox', 23),
  timeseries('Consumer lag by group and topic', [{ expr: 'sum by (group, topic) (kafka_consumer_lag)', legend: '{{group}} / {{topic}}' }], 0, 24, 6, 8, { description: '0 = keeping up. Growing = events arrive faster than they are handled, or the consumer is down.' }),
  timeseries('Outbox backlog by service', [{ expr: 'sum by (service) (outbox_backlog)', legend: '{{service}}' }], 6, 24, 6, 8, { description: 'Grows while Kafka is unavailable; drains in order once it returns.' }),
  timeseries('Events published per second', [{ expr: 'sum by (service) (rate(outbox_published_total[1m]))', legend: '{{service}}' }], 12, 24, 6, 8, { unit: 'ops' }),
  timeseries('Messages consumed per second by result', [{ expr: 'sum by (consumer, result) (rate(consumer_messages_total[1m]))', legend: '{{consumer}} {{result}}' }], 18, 24, 6, 8, { unit: 'ops', description: 'processed / duplicate (skipped by the inbox) / dead_lettered.' }),

  row('Resilience', 32),
  timeseries('Gateway calls by outcome', [{ expr: 'sum by (op, outcome) (rate(gateway_calls_total[1m]))', legend: '{{op}} {{outcome}}' }], 0, 33, 8, 8, { unit: 'ops', description: 'unknown = timeout/5xx/open circuit: the payment stays processing until recovery.' }),
  timeseries('Stuck payments settled by recovery (5m)', [{ expr: 'sum by (outcome) (increase(payments_recovered_total[5m]))', legend: '{{outcome}}' }], 8, 33, 8, 8, { description: 'The recovery job resolving payments whose outcome was unknown.' }),
  timeseries('Webhook attempts by result', [{ expr: 'sum by (result) (rate(webhook_attempts_total[1m]))', legend: '{{result}}' }], 16, 33, 8, 8, { unit: 'ops' }),
  timeseries('Rate limiter decisions', [{ expr: 'sum by (limiter, result) (rate(rate_limit_decisions_total[1m]))', legend: '{{limiter}} {{result}}' }], 0, 41, 8, 8, { unit: 'ops', description: 'error_allowed = Redis was unreachable and the limiter failed open.' }),
  timeseries('Reconciliation runs (1h)', [{ expr: 'sum by (kind, status) (increase(recon_runs_total[1h]))', legend: '{{kind}} {{status}}' }], 8, 41, 8, 8),
  timeseries('Webhook deliveries reaching a final state (1h)', [{ expr: 'sum by (status) (increase(webhook_deliveries_final_total[1h]))', legend: '{{status}}' }], 16, 41, 8, 8),

  row('Node runtime', 49),
  timeseries('CPU usage by service', [{ expr: 'sum by (job) (rate(process_cpu_seconds_total[1m]))', legend: '{{job}}' }], 0, 50, 8, 7, { unit: 'percentunit' }),
  timeseries('Memory (resident) by service', [{ expr: 'sum by (job) (process_resident_memory_bytes)', legend: '{{job}}' }], 8, 50, 8, 7, { unit: 'bytes' }),
  timeseries('Event loop lag p99', [{ expr: 'max by (job) (nodejs_eventloop_lag_p99_seconds)', legend: '{{job}}' }], 16, 50, 8, 7, { unit: 's', description: 'If this climbs, the process is too busy to serve requests promptly.' }),
];

const dashboard = {
  uid: 'zerodrift-overview',
  title: 'Zerodrift: system overview',
  tags: ['zerodrift'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '10s',
  time: { from: 'now-30m', to: 'now' },
  links: [{ title: 'Traces (Jaeger)', type: 'link', url: 'http://localhost:16686', targetBlank: true, icon: 'external link' }],
  panels,
};

mkdirSync('infra/grafana/dashboards', { recursive: true });
writeFileSync('infra/grafana/dashboards/zerodrift.json', JSON.stringify(dashboard, null, 2) + '\n');
console.log(`wrote infra/grafana/dashboards/zerodrift.json (${panels.filter((p) => p.type !== 'row').length} panels)`);
