// k6 load script for the chaos run. Not bundled: k6 runs this file directly.
//
// What it does, per iteration (one "operation"):
//   * 75% a payment through the payments API, 25% a customer-to-customer transfer through the ledger API
//   * ~10% of operations are DUPLICATES: the identical request (same Idempotency-Key) is sent twice at the same time
//   * a retry loop like a real client's: network errors, timeouts and 5xx are retried with the SAME key
//     (a timeout is an unknown outcome, so the only safe retry is with the same key)
// The server must turn all of this into exactly one effect per key; the invariant checker proves it afterwards.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const seed = JSON.parse(open(__ENV.SEED_FILE));
const customers = new SharedArray('customers', () => seed.customers);
const RUN = seed.runId;
const TOTAL = Number(__ENV.TOTAL || 10000);
const VUS = Number(__ENV.VUS || 200);
const DUP_RATE = Number(__ENV.DUP_RATE || 0.1);
const PAYMENTS = __ENV.PAYMENTS_URL;
const LEDGER = __ENV.LEDGER_URL;

export const options = {
  scenarios: {
    load: { executor: 'shared-iterations', vus: VUS, iterations: TOTAL, maxDuration: __ENV.MAX_DURATION || '25m' },
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const uniqueKeys = new Counter('unique_keys');
const duplicatesSent = new Counter('duplicates_sent');
const retries = new Counter('client_retries');
const gaveUp = new Counter('gave_up_unknown'); // retries exhausted: the client does not know the outcome
const definitive = new Counter('definitive_answers');
const paymentMs = new Trend('payment_ms', true);
const transferMs = new Trend('transfer_ms', true);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const amount = () => 100 + Math.floor(Math.random() * 4900); // Rs 1.00 .. Rs 50.00

function send(req) {
  return http.post(req.url, req.body, { headers: req.headers, timeout: '10s', tags: { name: req.name } });
}

// One logical request with client-style retries (same key every time). Returns the last response.
function withRetries(req, maxAttempts) {
  let res;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = send(req);
    if (res.status !== 0 && res.status < 500 && res.status !== 429) return res; // a definitive answer
    if (attempt < maxAttempts) {
      retries.add(1);
      sleep(0.05 + Math.random() * 0.45 * attempt);
    }
  }
  return res;
}

export default function () {
  const key = `${RUN}-${__VU}-${__ITER}`;
  const isPayment = Math.random() < 0.75;
  let req;
  if (isPayment) {
    const merchant = pick(seed.merchants);
    req = {
      name: 'create_payment',
      url: `${PAYMENTS}/v1/payments`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${merchant.apiKey}`, 'idempotency-key': key },
      body: JSON.stringify({ customerId: pick(customers).id, amountMinor: String(amount()), reference: `order-${key}` }),
    };
  } else {
    const from = pick(customers);
    let to = pick(customers);
    while (to.id === from.id) to = pick(customers);
    req = {
      name: 'create_transfer',
      url: `${LEDGER}/transfers`,
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ fromAccountId: from.accountId, toAccountId: to.accountId, amountMinor: String(amount()) }),
    };
  }
  uniqueKeys.add(1);

  const started = Date.now();
  let res;
  if (Math.random() < DUP_RATE) {
    // A double-click / a client that retried too eagerly: two identical requests in flight at once.
    duplicatesSent.add(1);
    const both = http.batch([
      ['POST', req.url, req.body, { headers: req.headers, timeout: '10s', tags: { name: req.name } }],
      ['POST', req.url, req.body, { headers: req.headers, timeout: '10s', tags: { name: req.name } }],
    ]);
    res = both.find((r) => r.status >= 200 && r.status < 500 && r.status !== 429) || both[0];
    if (res.status === 0 || res.status >= 500) res = withRetries(req, 3);
  } else {
    res = withRetries(req, 4);
  }

  const elapsed = Date.now() - started;
  (isPayment ? paymentMs : transferMs).add(elapsed);
  if (res.status === 0 || res.status >= 500 || res.status === 429) gaveUp.add(1);
  else definitive.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (name, stat) => (m[name] && m[name].values[stat] !== undefined ? m[name].values[stat] : null);
  const count = (name) => v(name, 'count') || 0; // a counter that was never incremented is absent from the summary
  const trend = (name) => ({ med: v(name, 'med'), p90: v(name, 'p(90)'), p95: v(name, 'p(95)'), p99: v(name, 'p(99)'), max: v(name, 'max') });
  const summary = {
    runId: RUN,
    iterations: v('iterations', 'count'),
    durationSeconds: data.state.testRunDurationMs / 1000,
    throughputOpsPerSecond: v('iterations', 'rate'),
    httpRequests: v('http_reqs', 'count'),
    uniqueKeys: count('unique_keys'),
    duplicatesSent: count('duplicates_sent'),
    clientRetries: count('client_retries'),
    definitiveAnswers: count('definitive_answers'),
    gaveUpUnknown: count('gave_up_unknown'),
    httpLatencyMs: trend('http_req_duration'),
    paymentLatencyMs: trend('payment_ms'),
    transferLatencyMs: trend('transfer_ms'),
  };
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(summary, null, 2) };
}
