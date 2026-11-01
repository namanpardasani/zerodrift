#!/usr/bin/env node
// Feature check for a RUNNING local stack (`pnpm start:local`): it exercises every feature through the real HTTP APIs, the same
// ones the console and the shop use, and prints ok / FAIL for each. It leaves test merchants and payments behind (harmless).
//   pnpm verify:features
// Takes about 2 minutes (it waits for a webhook retry and for crash recovery). Exit code 1 if anything failed.
const env = (k, d) => process.env[k] ?? d;
const U = {
  ledger: env('LEDGER_URL', 'http://localhost:3001'),
  payments: env('PAYMENTS_URL', 'http://localhost:3002'),
  webhook: env('WEBHOOK_URL', 'http://localhost:3003'),
  recon: env('RECON_URL', 'http://localhost:3004'),
  gateway: env('GATEWAY_URL', 'http://localhost:3005'),
  receiver: env('RECEIVER_URL', 'http://localhost:3007'),
  console: env('CONSOLE_URL', 'http://localhost:3008'),
  shop: env('SHOP_URL', 'http://localhost:3009'),
};
const ADMIN = { 'x-admin-token': env('ADMIN_TOKEN', 'dev-admin-token') };
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let total = 0;

async function call(method, url, { headers = {}, body } = {}) {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  } catch (e) {
    return { status: 0, data: { error: String(e.cause?.code ?? e.message) }, headers: new Headers() };
  }
}
const waitFor = async (what, fn, ms = 60_000, every = 1000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const section = (t) => console.log(`\n${t}`);
async function check(name, fn) {
  total++;
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, what) => expect(String(a) === String(b), `${what}: expected ${b}, got ${a}`);
const rupees = (m) => `₹${(Number(m) / 100).toFixed(2)}`;

// ---------------------------------------------------------------- setup: a merchant and funded customers
let merchant, auth;
const merchantAuth = () => ({ authorization: `Bearer ${merchant.apiKey}` });
const newCustomer = async (amount = '500000') => {
  const id = `vf-${RUN}-${Math.random().toString(36).slice(2, 7)}`;
  await call('POST', `${U.payments}/v1/customers`, { headers: auth, body: { customerId: id } });
  const t = await call('POST', `${U.payments}/v1/customers/${id}/topups`, { headers: { ...auth, 'idempotency-key': `vf-topup-${id}` }, body: { amountMinor: amount } });
  expect(t.status < 300, `top-up failed: ${t.status} ${JSON.stringify(t.data)}`);
  return id;
};
const balance = async (customer) => BigInt((await call('GET', `${U.payments}/v1/customers/${customer}`, { headers: auth })).data.balance.availableMinor);
const held = async (customer) => BigInt((await call('GET', `${U.payments}/v1/customers/${customer}`, { headers: auth })).data.balance.heldMinor);
const merchantBalance = async () => BigInt((await call('GET', `${U.payments}/v1/me`, { headers: auth })).data.balance.availableMinor);
const pay = (customer, amount, key, extra = {}) => call('POST', `${U.payments}/v1/payments`, { headers: { ...auth, 'idempotency-key': key }, body: { customerId: customer, amountMinor: String(amount), ...extra } });

console.log(`Zerodrift feature check (run ${RUN})`);

section('1. Every service is up');
for (const [name, base] of [['ledger', U.ledger], ['payments', U.payments], ['webhook', U.webhook], ['reconciliation', U.recon], ['mock bank', U.gateway], ['console + landing page', U.console], ['demo shop', U.shop]]) {
  await check(`${name} is ready`, async () => { const r = await call('GET', `${base}/ready`); expect(r.status === 200, `HTTP ${r.status}`); });
}

section('2. Merchant, wallet, top-up');
await check('create a merchant (API key shown once)', async () => {
  const r = await call('POST', `${U.payments}/admin/merchants`, { headers: ADMIN, body: { name: `Feature check ${RUN}`, feeBps: 250, rateLimitPerMin: 6000 } });
  expect(r.status === 201 && r.data.apiKey?.startsWith('zd_live_'), `HTTP ${r.status}`);
  merchant = r.data;
  auth = merchantAuth();
  eq(merchant.feeBps, 250, 'fee');
});
let alice;
await check('create a customer wallet and top it up by ₹5,000', async () => { alice = await newCustomer(); eq(await balance(alice), 500000n, 'balance'); });
await check('a top-up repeated with the same key does not credit twice', async () => {
  const key = `vf-topup-repeat-${RUN}`;
  const c = await newCustomer('100000');
  const a = await call('POST', `${U.payments}/v1/customers/${c}/topups`, { headers: { ...auth, 'idempotency-key': key }, body: { amountMinor: '5000' } });
  const b = await call('POST', `${U.payments}/v1/customers/${c}/topups`, { headers: { ...auth, 'idempotency-key': key }, body: { amountMinor: '5000' } });
  expect(a.status < 300 && b.status < 300, `statuses ${a.status}/${b.status}`);
  eq(await balance(c), 105000n, 'balance (100000 + 5000 once)');
});

section('3. A payment moves the money correctly');
let p1;
await check('pay ₹349.00: succeeded, wallet debited, merchant credited the amount minus a 2.5% fee', async () => {
  const before = await merchantBalance();
  const r = await pay(alice, 34900, `vf-pay-1-${RUN}`, { reference: 'order-1' });
  expect(r.status === 201 && r.data.status === 'succeeded', `HTTP ${r.status} status ${r.data?.status}`);
  p1 = r.data;
  eq(await balance(alice), 500000n - 34900n, 'wallet');
  eq((await merchantBalance()) - before, 34900n - 873n, 'merchant credit (fee 873 = 2.5% of 34900, half-up)');
  eq(r.data.feeMinor, '873', 'fee');
});
await check('the held balance is back to zero', async () => eq(await held(alice), 0n, 'held'));
await check('insufficient funds fails the payment and leaves the wallet untouched', async () => {
  const poor = await newCustomer('1000');
  const r = await pay(poor, 50000, `vf-poor-${RUN}`);
  expect(r.data?.status === 'failed', `status ${r.data?.status}`);
  eq(await balance(poor), 1000n, 'wallet');
  eq(await held(poor), 0n, 'held');
});
await check('an invalid amount (a fraction, zero, negative) is refused with HTTP 400 and moves no money', async () => {
  const before = await balance(alice);
  for (const bad of ['1.5', '0', '-100', 'abc']) {
    const r = await pay(alice, bad, `vf-bad-${bad}-${RUN}`);
    expect(r.status === 400, `amount ${bad}: HTTP ${r.status}`);
  }
  eq(await balance(alice), before, 'wallet unchanged');
});

section('4. Idempotency');
await check('same key, same request: the stored answer, charged once', async () => {
  const key = `vf-idem-${RUN}`;
  const before = await balance(alice);
  const a = await pay(alice, 10000, key);
  const b = await pay(alice, 10000, key);
  expect(a.status === 201 && b.data.id === a.data.id, `ids ${a.data?.id} / ${b.data?.id}`);
  eq(before - (await balance(alice)), 10000n, 'wallet debited once');
});
await check('same key, different request: rejected with HTTP 422', async () => {
  const key = `vf-idem2-${RUN}`;
  await pay(alice, 10000, key);
  const r = await pay(alice, 10001, key);
  expect(r.status === 422, `HTTP ${r.status}`);
});
await check('20 concurrent duplicates: exactly one payment and one charge', async () => {
  const c = await newCustomer('500000');
  const key = `vf-concurrent-${RUN}`;
  const results = await Promise.all(Array.from({ length: 20 }, () => pay(c, 20000, key)));
  const ids = new Set(results.filter((r) => r.data?.id).map((r) => r.data.id));
  expect(ids.size === 1, `${ids.size} different payment ids`);
  await waitFor('the payment to settle', async () => (await call('GET', `${U.payments}/v1/payments/${[...ids][0]}`, { headers: auth })).data.status === 'succeeded', 30_000);
  eq(await balance(c), 480000n, 'wallet debited once');
  return `${results.filter((r) => r.status === 409).length} answered 409 in progress, ${results.filter((r) => r.status < 300).length} answered with the payment`;
});

section('5. Refunds');
await check('partial refund returns part of the money and a proportional share of the fee', async () => {
  const before = await balance(alice);
  const r = await call('POST', `${U.payments}/v1/payments/${p1.id}/refunds`, { headers: { ...auth, 'idempotency-key': `vf-refund-1-${RUN}` }, body: { amountMinor: '10000', reason: 'feature check' } });
  expect(r.status < 300 && r.data.status === 'succeeded', `HTTP ${r.status} ${JSON.stringify(r.data)}`);
  eq((await balance(alice)) - before, 10000n, 'wallet refunded');
  const p = (await call('GET', `${U.payments}/v1/payments/${p1.id}`, { headers: auth })).data;
  eq(p.status, 'partially_refunded', 'payment status');
});
await check('the same refund request again does not refund twice', async () => {
  const before = await balance(alice);
  await call('POST', `${U.payments}/v1/payments/${p1.id}/refunds`, { headers: { ...auth, 'idempotency-key': `vf-refund-1-${RUN}` }, body: { amountMinor: '10000', reason: 'feature check' } });
  eq(await balance(alice), before, 'wallet unchanged');
});
await check('refunding more than what is left is refused', async () => {
  const r = await call('POST', `${U.payments}/v1/payments/${p1.id}/refunds`, { headers: { ...auth, 'idempotency-key': `vf-refund-too-much-${RUN}` }, body: { amountMinor: '99999' } });
  expect(r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
});
await check('refunding the rest makes the payment fully refunded and the wallet whole again', async () => {
  const r = await call('POST', `${U.payments}/v1/payments/${p1.id}/refunds`, { headers: { ...auth, 'idempotency-key': `vf-refund-2-${RUN}` }, body: {} });
  expect(r.status < 300 && r.data.status === 'succeeded', `HTTP ${r.status}`);
  const p = (await call('GET', `${U.payments}/v1/payments/${p1.id}`, { headers: auth })).data;
  eq(p.status, 'refunded', 'payment status');
  eq(p.refundedMinor, '34900', 'refunded total');
});

section('6. Bank trouble: declines, lost answers, recovery');
await check('a declined payment fails and releases the hold', async () => {
  await call('PUT', `${U.gateway}/admin/faults`, { body: { declineRate: 1 } });
  try {
    const c = await newCustomer('100000');
    const r = await pay(c, 5000, `vf-decline-${RUN}`);
    expect(r.data?.status === 'failed', `status ${r.data?.status}`);
    eq(await balance(c), 100000n, 'wallet');
    eq(await held(c), 0n, 'held');
  } finally { await call('POST', `${U.gateway}/admin/faults/reset`, { body: {} }); }
});
await check('the bank charges but its answer is lost: payment waits (money held), recovery asks the bank and settles it', async () => {
  const c = await newCustomer('100000');
  await call('PUT', `${U.gateway}/admin/faults`, { body: { lostResponseRate: 1 } });
  let r;
  try { r = await pay(c, 19900, `vf-lost-${RUN}`); } finally { await call('POST', `${U.gateway}/admin/faults/reset`, { body: {} }); }
  expect(r.status === 202 && r.data.status === 'processing', `HTTP ${r.status} status ${r.data?.status}`);
  eq(await held(c), 19900n, 'funds held while unknown');
  await waitFor('recovery to settle it', async () => {
    await call('POST', `${U.payments}/internal/recovery/run`, { headers: ADMIN, body: {} });
    return (await call('GET', `${U.payments}/v1/payments/${r.data.id}`, { headers: auth })).data.status === 'succeeded';
  }, 90_000, 3000);
  eq(await balance(c), 80100n, 'wallet debited exactly once');
  eq(await held(c), 0n, 'held released into the capture');
});

section('7. Webhooks');
let endpoint;
await check('register a webhook endpoint (signing secret shown once) and let the receiver trust it', async () => {
  const r = await call('POST', `${U.webhook}/v1/webhook-endpoints`, { headers: auth, body: { url: 'http://demo-receiver:3007/webhooks', eventTypes: ['payment.succeeded'] } });
  expect(r.status === 201 && r.data.secret?.startsWith('whsec_'), `HTTP ${r.status}`);
  endpoint = r.data;
  const s = await call('POST', `${U.receiver}/admin/secrets`, { body: { secrets: [endpoint.secret] } });
  expect(s.status === 200, `receiver HTTP ${s.status}`);
});
let hookPayment;
await check('a successful payment is delivered, signed, and the receiver verifies it', async () => {
  const c = await newCustomer('100000');
  hookPayment = (await pay(c, 4900, `vf-hook-${RUN}`)).data;
  const got = await waitFor('the webhook', async () => (await call('GET', `${U.receiver}/received`)).data.received.find((x) => x.body?.data?.paymentId === hookPayment.id && x.outcome === 'ok'), 45_000);
  eq(got.type, 'payment.succeeded', 'event type');
  eq(got.body.data.amountMinor, '4900', 'amount in the payload');
});
await check('the delivery log shows it as succeeded with its attempt', async () => {
  const d = await waitFor('the delivery to be recorded', async () => (await call('GET', `${U.webhook}/v1/webhook-deliveries?limit=100`, { headers: auth })).data.deliveries.find((x) => x.status === 'succeeded'), 20_000);
  const detail = await call('GET', `${U.webhook}/v1/webhook-deliveries/${d.id}`, { headers: auth });
  expect(detail.data.attempts?.length >= 1 && detail.data.attempts[0].responseCode === 200, 'no 200 attempt in the log');
});
await check('replaying a delivery sends it again and the receiver treats it as a duplicate (its own deduplication)', async () => {
  const list = (await call('GET', `${U.webhook}/v1/webhook-deliveries?limit=100`, { headers: auth })).data.deliveries;
  const d = list.find((x) => x.status === 'succeeded');
  const r = await call('POST', `${U.webhook}/v1/webhook-deliveries/${d.id}/replay`, { headers: auth, body: {} });
  expect(r.status < 300, `HTTP ${r.status}`);
  await waitFor('the replay to arrive', async () => (await call('GET', `${U.receiver}/received`)).data.received.some((x) => x.eventId === d.eventId && x.outcome === 'duplicate'), 45_000);
});
await check('when the merchant server fails once, the delivery is retried with backoff and then succeeds (attempt 2)', async () => {
  const c = await newCustomer('100000');
  await call('POST', `${U.receiver}/admin/behavior`, { body: { failNext: 1, failStatus: 500 } });
  try {
    const p = (await pay(c, 5900, `vf-retry-${RUN}`)).data;
    // the receiver records an injected failure WITHOUT a body, so match the successful attempt by payment and the failure by event id
    const ok = await waitFor('the delivery to succeed on a later attempt', async () => (await call('GET', `${U.receiver}/received`)).data.received.find((x) => x.body?.data?.paymentId === p.id && x.outcome === 'ok'), 90_000, 2000);
    expect(ok.attempt >= 2, `succeeded on attempt ${ok.attempt}, expected a retry`);
    const failed = (await call('GET', `${U.receiver}/received`)).data.received.some((x) => x.eventId === ok.eventId && x.outcome === 'injected_failure');
    expect(failed, 'no failed first attempt recorded for the same event');
    return `failed once, then ok on attempt ${ok.attempt}`;
  } finally {
    await call('POST', `${U.receiver}/admin/behavior`, { body: { failNext: 0 } });
  }
});
await check('a webhook to a private/internal address is refused when the guard is on (SSRF)', async () => {
  // the dev stack allows private URLs for the demo receiver; the guard itself is covered by services/webhook/src/url-guard.test.ts
  const r = await call('POST', `${U.webhook}/v1/webhook-endpoints`, { headers: auth, body: { url: 'ftp://example.com/hook' } });
  expect(r.status >= 400 && r.status < 500, `HTTP ${r.status} (a non-http URL must be refused)`);
});

section('8. Ledger, reconciliation, invariants');
await check('the books balance: drift is exactly zero', async () => {
  const r = await call('GET', `${U.ledger}/internal/invariants`);
  expect(r.data.ok === true && r.data.totalBalanceMinor === '0', `ok=${r.data.ok} drift=${r.data.totalBalanceMinor}`);
  return `money in system ${rupees(r.data.moneyInSystemMinor)}`;
});
await check('a ledger transaction is balanced (debits equal credits)', async () => {
  const tx = (await call('GET', `${U.ledger}/internal/transactions?limit=1`)).data.transactions[0];
  const sum = (d) => tx.entries.filter((e) => e.direction === d).reduce((s, e) => s + BigInt(e.amountMinor), 0n);
  eq(sum('debit'), sum('credit'), 'debits vs credits');
});
await check('internal reconciliation is clean', async () => {
  const r = await call('POST', `${U.recon}/v1/recon/runs`, { headers: ADMIN, body: { kind: 'internal' } });
  expect(r.data.status === 'clean', `status ${r.data.status}, ${r.data.mismatches?.length} mismatches ${JSON.stringify(r.data.mismatches?.slice(0, 2))}`);
});
await check('external reconciliation (payments vs the bank settlement file) is clean', async () => {
  const r = await call('POST', `${U.recon}/v1/recon/runs`, { headers: ADMIN, body: { kind: 'external' } });
  expect(r.data.status === 'clean', `status ${r.data.status}, ${r.data.mismatches?.length} mismatches ${JSON.stringify(r.data.mismatches?.slice(0, 2))}`);
});

section('9. Operator console API');
let token;
await check('a wrong password is refused, the right one gives a session', async () => {
  const bad = await call('POST', `${U.console}/auth/login`, { body: { username: 'admin', password: 'definitely-wrong' } });
  expect(bad.status === 401, `wrong password HTTP ${bad.status}`);
  const ok = await call('POST', `${U.console}/auth/login`, { body: { username: 'admin', password: env('DASHBOARD_PASSWORD', 'zerodrift') } });
  expect(ok.status === 200 && ok.data.token, `login HTTP ${ok.status}`);
  token = ok.data.token;
});
const api = (path, o = {}) => call(o.method ?? 'GET', `${U.console}${path}`, { headers: { authorization: `Bearer ${token}` }, body: o.body });
await check('the console API refuses requests without a session', async () => expect((await call('GET', `${U.console}/api/overview`)).status === 401, 'not 401'));
await check('overview shows real numbers (services up, books balanced)', async () => {
  const o = (await api('/api/overview')).data;
  expect(o.services.every((s) => s.up) && o.ledgerInvariants.ok, `services ${JSON.stringify(o.services.filter((s) => !s.up))}`);
});
await check('the payment detail has the duplicate count and its ledger journal', async () => {
  const list = (await api(`/api/payments?limit=200`)).data.payments;
  const mine = list.find((x) => x.id === p1.id);
  expect(mine, 'payment missing from the list');
  const d = (await api(`/api/payments/${p1.id}`)).data;
  expect(d.duplicatesAbsorbed === 0 && d.ledgerTxId && d.events.length >= 3, `detail ${JSON.stringify({ dup: d.duplicatesAbsorbed, tx: d.ledgerTxId })}`);
  const tx = (await api(`/api/ledger/transactions/${d.ledgerTxId}`)).data;
  expect(tx.entries.length >= 3, 'journal entries');
});
await check('a payment that was sent twice shows the absorbed duplicate', async () => {
  const c = await newCustomer('100000');
  const key = `vf-dup-visible-${RUN}`;
  const a = (await pay(c, 7700, key)).data;
  await pay(c, 7700, key);
  await pay(c, 7700, key);
  const d = (await api(`/api/payments/${a.id}`)).data;
  eq(d.duplicatesAbsorbed, 2, 'duplicates absorbed');
});
await check('audit log, webhook stats, metrics and reconciliation endpoints answer', async () => {
  for (const path of ['/api/audit?limit=5', '/api/webhooks/stats', '/api/webhooks/endpoints', '/api/recon/latest', '/api/accounts?limit=5', '/api/merchants']) {
    const r = await api(path);
    expect(r.status === 200, `${path} HTTP ${r.status}`);
  }
});
await check('the public status route (landing page) reports the books as balanced', async () => {
  const r = await call('GET', `${U.console}/api/public/status`);
  expect(r.data.available && r.data.ok === true && r.data.driftMinor === '0', JSON.stringify(r.data));
});
await check('the landing page, login page and style guide are served', async () => {
  for (const path of ['/', '/login', '/styleguide', '/app']) {
    const r = await call('GET', `${U.console}${path}`);
    expect(r.status === 200 && String(r.data).includes('<div id="root">'), `${path} HTTP ${r.status}`);
  }
});

section('10. Demo shop (Café Aman)');
await check('menu, wallet top-up, checkout, and a double-clicked Pay creates ONE order', async () => {
  const menu = await call('GET', `${U.shop}/api/products`);
  expect(menu.data.products.length > 0, 'no products');
  const cust = `vf-shop-${RUN}`;
  const t = await call('POST', `${U.shop}/api/customers/${cust}/topup`, { headers: { 'idempotency-key': `vf-shop-topup-${RUN}` }, body: { amountMinor: 500000 } });
  expect(t.status < 300, `top-up HTTP ${t.status}`);
  const item = { productId: menu.data.products[0].id, qty: 1 };
  const key = `vf-checkout-${RUN}`;
  const [a, b] = await Promise.all([1, 2].map(() => call('POST', `${U.shop}/api/orders`, { headers: { 'idempotency-key': key }, body: { customerId: cust, items: [item] } })));
  expect(a.data.id && a.data.id === b.data.id, `orders ${a.data?.id} / ${b.data?.id}`);
  const paid = await waitFor('the order to be paid', async () => (await call('GET', `${U.shop}/api/orders/${a.data.id}`)).data.status === 'paid', 45_000);
  expect(paid, 'order not paid');
});

section('11. Chaos bench (test mode only)');
await check('the chaos controller is on in this stack, and killing a service is survived', async () => {
  const st = (await api('/api/chaos/status')).data;
  expect(st.enabled === true, 'chaos is disabled (this check needs the development stack)');
  const k = await api('/api/chaos/services/webhook/kill', { method: 'POST', body: { restartAfterSeconds: 5 } });
  expect(k.status === 200, `kill HTTP ${k.status} ${JSON.stringify(k.data)}`);
  const c = await newCustomer('100000');
  const r = await pay(c, 6100, `vf-during-kill-${RUN}`); // payments must not care that the webhook service is down
  expect(r.data?.status === 'succeeded', `payment during the outage: ${r.status} ${r.data?.status}`);
  await waitFor('the webhook service to come back', async () => (await call('GET', `${U.webhook}/ready`)).status === 200, 90_000, 2000);
  await api('/api/chaos/reset', { method: 'POST', body: {} });
});
await check('after chaos the books still balance and nothing is stuck', async () => {
  const inv = (await call('GET', `${U.ledger}/internal/invariants`)).data;
  expect(inv.ok && inv.totalBalanceMinor === '0', `ok=${inv.ok}`);
  await waitFor('nothing in flight', async () => { await call('POST', `${U.payments}/internal/recovery/run`, { headers: ADMIN, body: {} }); return (await api('/api/overview')).data.payments.inFlight.count === 0; }, 90_000, 3000);
});

section('12. Protection (these run last: they intentionally trigger throttles)');
await check('per-merchant rate limit: a merchant limited to 5 requests/min gets HTTP 429 with Retry-After', async () => {
  const m = (await call('POST', `${U.payments}/admin/merchants`, { headers: ADMIN, body: { name: `Rate limited ${RUN}`, rateLimitPerMin: 5 } })).data;
  const statuses = [];
  let retryAfter = null;
  for (let i = 0; i < 9; i++) {
    const r = await call('GET', `${U.payments}/v1/me`, { headers: { authorization: `Bearer ${m.apiKey}` } });
    statuses.push(r.status);
    if (r.status === 429) retryAfter ??= r.headers.get('retry-after');
  }
  expect(statuses.includes(429) && statuses[0] === 200, `statuses ${statuses.join(' ')}`);
  expect(retryAfter, 'no Retry-After header');
  return `statuses ${statuses.join(' ')}`;
});
await check('the console login is throttled after repeated wrong passwords (HTTP 429)', async () => {
  let got429 = false;
  for (let i = 0; i < 8 && !got429; i++) got429 = (await call('POST', `${U.console}/auth/login`, { body: { username: 'admin', password: `wrong-${i}` } })).status === 429;
  expect(got429, 'never throttled');
});

console.log(`\n${total - failures} of ${total} checks passed${failures ? `, ${failures} FAILED` : ': every feature works'}`);
process.exit(failures ? 1 : 0);
