#!/usr/bin/env node
// Demo data for a fresh Zerodrift: merchants, funded customers, a spread of payments (with deliberate duplicates, refunds, one
// failure, and optionally one payment whose bank answer is lost so recovery visibly saves it). Uses only the PUBLIC APIs, exactly
// as a real integration would, then asks the platform whether its books balance.
//
//   ADMIN_TOKEN=... node scripts/seed-demo.mjs                              (against the development compose stack, localhost ports)
//   scripts/seed-demo.sh                                                    (against the production compose stack: runs INSIDE its private network)
//
// Environment (all optional except ADMIN_TOKEN):
//   PAYMENTS_URL    http://localhost:3002      WEBHOOK_URL   http://localhost:3003
//   LEDGER_URL      http://localhost:3001      RECON_URL     http://localhost:3004      (if set, the books are checked at the end)
//   GATEWAY_URL     (the mock bank's admin API; if set, one payment is made with a lost bank response and recovered)
//   WEBHOOK_TARGET  (a PUBLIC https URL that receives signed webhooks; if set, each merchant registers it)
//   MERCHANTS=2  CUSTOMERS=12  PAYMENTS=40   (payments PER merchant)
// Re-running is safe for top-ups and payments (deterministic idempotency keys per RUN id), but creates new merchants each time.
const env = (k, d) => process.env[k] ?? d;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required (the platform admin token).');
  process.exit(2);
}
const U = { payments: env('PAYMENTS_URL', 'http://localhost:3002'), webhook: env('WEBHOOK_URL', 'http://localhost:3003'), ledger: process.env.LEDGER_URL, recon: process.env.RECON_URL, gateway: process.env.GATEWAY_URL };
const N = { merchants: Number(env('MERCHANTS', 2)), customers: Number(env('CUSTOMERS', 12)), payments: Number(env('PAYMENTS', 40)) };
const RUN = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const NAMES = ['Café Aman', 'Pixel Prints', 'Kirana Mart', 'Bookworm'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const must = async (what, p) => {
  const r = await p;
  if (r.status < 200 || r.status >= 300) throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const admin = { 'x-admin-token': ADMIN_TOKEN };
const rupees = (minor) => `₹${(Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const tally = { created: 0, duplicates: 0, replayedSame: 0, settled: 0, failed: 0, other: 0, refunds: 0 };

console.log(`Seeding run ${RUN}: ${N.merchants} merchants, ${N.customers} customers, ${N.payments} payments each\n`);

// 1. merchants (+ webhook endpoint when a public target is given)
const merchants = [];
for (let i = 0; i < N.merchants; i++) {
  const name = `${NAMES[i % NAMES.length]} (demo ${RUN})`;
  const m = await must('create merchant', call('POST', `${U.payments}/admin/merchants`, { headers: admin, body: { name, feeBps: 250, rateLimitPerMin: 6000 } }));
  const merchant = { id: m.id, name, apiKey: m.apiKey, auth: { authorization: `Bearer ${m.apiKey}` } };
  if (process.env.WEBHOOK_TARGET) {
    const ep = await must('register webhook endpoint', call('POST', `${U.webhook}/v1/webhook-endpoints`, { headers: merchant.auth, body: { url: process.env.WEBHOOK_TARGET, eventTypes: ['payment.succeeded', 'payment.failed', 'refund.created'] } }));
    merchant.webhookSecret = ep.secret;
  }
  merchants.push(merchant);
  console.log(`  merchant ${name}  id ${m.id}\n    API key (shown once, store it): ${m.apiKey}${merchant.webhookSecret ? `\n    webhook signing secret (shown once): ${merchant.webhookSecret}` : ''}`);
}

// 2. customers with wallets, funded through the API (idempotent top-ups)
const customers = Array.from({ length: N.customers }, (_, i) => `demo-${RUN}-c${String(i + 1).padStart(2, '0')}`);
for (const c of customers) {
  await must('create customer', call('POST', `${U.payments}/v1/customers`, { headers: merchants[0].auth, body: { customerId: c } }));
  await must('top up', call('POST', `${U.payments}/v1/customers/${c}/topups`, { headers: { ...merchants[0].auth, 'idempotency-key': `seed-topup-${c}` }, body: { amountMinor: '500000' } }));
}
console.log(`\n  ${customers.length} customers, each topped up ${rupees(500000)}`);

// 3. payments: varied amounts, ~10% sent twice with the same key (the second must be answered from the first)
const paid = [];
const AMOUNTS = [4900, 9900, 14900, 24900, 34900, 49900, 99900, 149900, 249900];
for (const m of merchants) {
  for (let i = 0; i < N.payments; i++) {
    const key = `seed-${RUN}-${m.id.slice(0, 6)}-${i}`;
    const body = { customerId: customers[(i * 7 + merchants.indexOf(m)) % customers.length], amountMinor: String(AMOUNTS[i % AMOUNTS.length]), reference: `order-${RUN}-${i}` };
    const r = await call('POST', `${U.payments}/v1/payments`, { headers: { ...m.auth, 'idempotency-key': key }, body });
    tally.created++;
    if (r.data?.status === 'succeeded') { tally.settled++; paid.push({ m, p: r.data }); } else if (r.data?.status === 'failed') tally.failed++; else tally.other++;
    if (i % 10 === 3) {
      const again = await call('POST', `${U.payments}/v1/payments`, { headers: { ...m.auth, 'idempotency-key': key }, body });
      tally.duplicates++;
      if (again.data?.id === r.data?.id) tally.replayedSame++;
    }
  }
}

// 4. refunds: two full, two partial
for (const [j, { m, p }] of paid.slice(0, 4).entries()) {
  const refund = await call('POST', `${U.payments}/v1/payments/${p.id}/refunds`, { headers: { ...m.auth, 'idempotency-key': `seed-refund-${RUN}-${j}` }, body: j < 2 ? {} : { amountMinor: String(Math.floor(Number(p.amountMinor) / 2)), reason: 'demo partial refund' } });
  if (refund.status < 300) tally.refunds++;
}

// 5. one deliberate failure: a customer whose wallet is too small
const poor = `demo-${RUN}-poor`;
await must('create poor customer', call('POST', `${U.payments}/v1/customers`, { headers: merchants[0].auth, body: { customerId: poor } }));
await must('top up poor customer', call('POST', `${U.payments}/v1/customers/${poor}/topups`, { headers: { ...merchants[0].auth, 'idempotency-key': `seed-topup-${poor}` }, body: { amountMinor: '1000' } }));
const broke = await call('POST', `${U.payments}/v1/payments`, { headers: { ...merchants[0].auth, 'idempotency-key': `seed-${RUN}-broke` }, body: { customerId: poor, amountMinor: '50000', reference: 'too-expensive' } });
console.log(`  a payment of ${rupees(50000)} from a wallet holding ${rupees(1000)}: HTTP ${broke.status}, status ${broke.data?.status ?? JSON.stringify(broke.data?.error ?? broke.data)}`);

// 6. optional: a payment whose bank answer is LOST, then recovered (an unknown outcome made visible in the console)
if (U.gateway) {
  await must('gateway faults', call('PUT', `${U.gateway}/admin/faults`, { body: { lostResponseRate: 1 } }));
  const lost = await call('POST', `${U.payments}/v1/payments`, { headers: { ...merchants[0].auth, 'idempotency-key': `seed-${RUN}-lost` }, body: { customerId: customers[0], amountMinor: '19900', reference: 'bank-answer-lost' } });
  await must('gateway reset', call('POST', `${U.gateway}/admin/faults/reset`, { body: {} }));
  console.log(`  a payment whose bank response was lost: HTTP ${lost.status}, status ${lost.data?.status} (an UNKNOWN outcome: funds held, not failed)`);
  for (let i = 0; i < 20; i++) {
    await call('POST', `${U.payments}/internal/recovery/run`, { headers: admin, body: {} });
    const now = await call('GET', `${U.payments}/v1/payments/${lost.data.id}`, { headers: merchants[0].auth });
    if (now.data?.status === 'succeeded') { console.log(`    recovery asked the bank and settled it: ${now.data.status}`); break; }
    await sleep(2000);
  }
}

// 7. are the books right?
console.log('\nPayments: ' + JSON.stringify(tally));
console.log(`Duplicates answered from the first request: ${tally.replayedSame} of ${tally.duplicates} (must be equal)`);
if (U.ledger) {
  const inv = await call('GET', `${U.ledger}/internal/invariants`);
  console.log(`Ledger invariants: ${inv.data?.ok ? 'OK, every transaction balances' : 'VIOLATION'}; drift ${rupees(inv.data?.totalBalanceMinor ?? 0)}; money in system ${rupees(inv.data?.moneyInSystemMinor ?? 0)}`);
  if (!inv.data?.ok) process.exitCode = 1;
}
if (U.recon) {
  const run = await call('POST', `${U.recon}/v1/recon/runs`, { headers: admin, body: { kind: 'internal' } });
  console.log(`Internal reconciliation: ${run.data?.status ?? `HTTP ${run.status}`}, ${run.data?.mismatches?.length ?? '?'} mismatches`);
  if (run.data?.status && run.data.status !== 'clean') process.exitCode = 1;
}
if (tally.replayedSame !== tally.duplicates) process.exitCode = 1;
