import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSignatureHeader, generateSecret } from '@zerodrift/webhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRODUCTS, priceCart } from '../src/catalog.js';
import { type RunningShop, startShop } from '../src/shop.js';

/** A fake payments API that records requests and answers as scripted. */
let payments: Server;
let paymentsUrl: string;
const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
let respond: (req: { method: string; url: string; body: any }, res: import('node:http').ServerResponse) => void;

let shop: RunningShop;
let staticDir: string;
const SECRET = generateSecret();

beforeAll(async () => {
  payments = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      respond(entry, res);
    });
  });
  await new Promise<void>((r) => payments.listen(0, r));
  paymentsUrl = `http://127.0.0.1:${(payments.address() as AddressInfo).port}`;
  staticDir = mkdtempSync(join(tmpdir(), 'shop-'));
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shop</title>');
  writeFileSync(join(staticDir, 'assets', 'a.js'), '1');
  shop = await startShop({ port: 0, paymentsUrl, webhookUrl: 'http://unused', adminToken: 'x', staticDir, merchant: { apiKey: 'zd_live_test', webhookSecret: SECRET } });
  await shop.ready;
});
afterAll(async () => {
  await shop.close();
  payments.close();
  rmSync(staticDir, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  respond = (_r, res) => {
    res.writeHead(404);
    res.end();
  };
});

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const api = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${shop.url}${path}`, init);
  return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
};
const order = (items: unknown, customerId = 'cust-1', idem = `idem-${Math.random()}`) =>
  api('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idem }, body: JSON.stringify({ customerId, items }) });
const webhook = (event: object, secret = SECRET, tamper = false) => {
  const body = JSON.stringify(event);
  return api('/webhooks', { method: 'POST', headers: { 'content-type': 'application/json', 'zerodrift-signature': buildSignatureHeader([secret], tamper ? body.replace('payment', 'paymenT') : body) }, body });
};

describe('catalogue and pricing', () => {
  it('lists products and prices carts from the server catalogue only', () => {
    expect(PRODUCTS.length).toBeGreaterThan(3);
    const kurta = PRODUCTS.find((p) => p.id === 'kurta-cotton')!;
    const chai = PRODUCTS.find((p) => p.id === 'chai-tin')!;
    expect(priceCart([{ productId: 'kurta-cotton', qty: 2 }, { productId: 'chai-tin', qty: 1 }]).totalMinor).toBe(kurta.priceMinor * 2 + chai.priceMinor);
    for (const bad of [[], [{ productId: 'nope', qty: 1 }], [{ productId: 'chai-tin', qty: 0 }], [{ productId: 'chai-tin', qty: 11 }], [{ productId: 'chai-tin', qty: 1.5 }]]) {
      expect(() => priceCart(bad as never)).toThrow();
    }
  });

  it('a client-supplied price is ignored: payments receives the catalogue total', async () => {
    respond = (r, res) => json(res, 201, { id: 'pay-1', status: 'succeeded', amountMinor: r.body.amountMinor });
    const chai = PRODUCTS.find((p) => p.id === 'chai-tin')!;
    await order([{ productId: 'chai-tin', qty: 2, priceMinor: 1, unitPriceMinor: 1 }]);
    const sent = seen.find((s) => s.url === '/v1/payments')!;
    expect(sent.body.amountMinor).toBe(String(chai.priceMinor * 2));
    expect(sent.headers.authorization).toBe('Bearer zd_live_test');
  });
});

describe('checkout outcomes', () => {
  it('a succeeded payment marks the order paid', async () => {
    respond = (_r, res) => json(res, 201, { id: 'pay-ok', status: 'succeeded' });
    const r = await order([{ productId: 'jute-bag', qty: 1 }]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'paid', paymentId: 'pay-ok', totalMinor: PRODUCTS.find((p) => p.id === 'jute-bag')!.priceMinor });
    expect((await api(`/api/orders/${r.body.id}`)).body.status).toBe('paid');
  });

  it('a declined or insufficient-funds payment marks the order payment_failed with the reason', async () => {
    respond = (_r, res) => json(res, 201, { id: 'pay-no', status: 'failed', failureReason: 'insufficient_funds' });
    const r = await order([{ productId: 'jute-bag', qty: 1 }]);
    expect(r.body).toMatchObject({ status: 'payment_failed', failureReason: 'insufficient_funds' });
  });

  it('the payment carries an Idempotency-Key derived from the order, and a repeated checkout attempt returns the SAME order without a second payment', async () => {
    respond = (_r, res) => json(res, 201, { id: 'pay-1', status: 'succeeded' });
    const first = await order([{ productId: 'spice-box', qty: 1 }], 'cust-2', 'attempt-A');
    const again = await order([{ productId: 'spice-box', qty: 1 }], 'cust-2', 'attempt-A');
    expect(again.body.id).toBe(first.body.id);
    expect(again.status).toBe(200);
    const posts = seen.filter((s) => s.url === '/v1/payments');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers['idempotency-key']).toBe(`order-${first.body.id}`);
    expect(posts[0]!.body.reference).toBe(first.body.id);
  });

  it('UNKNOWN outcome (payment call times out / connection drops): the order stays PENDING, never "failed"; the signed webhook then settles it by reference', async () => {
    respond = (r, res) => {
      if (r.url === '/v1/payments') return void res.socket?.destroy(); // the response is lost
      res.writeHead(404);
      res.end();
    };
    const r = await order([{ productId: 'brass-diya', qty: 1 }]);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    expect(r.body.paymentId).toBeNull(); // we never learned the payment id

    const w = await webhook({ id: 'evt-1', type: 'payment.succeeded', createdAt: new Date().toISOString(), data: { paymentId: 'pay-late', reference: r.body.id, merchantId: 'm', amountMinor: '1', currency: 'INR' } });
    expect(w.status).toBe(200);
    const after = (await api(`/api/orders/${r.body.id}`)).body;
    expect(after.status).toBe('paid');
    expect(after.paymentId).toBe('pay-late');
  });

  it('a payment that answers 202 (processing) stays pending until the webhook says failed', async () => {
    respond = (_r, res) => json(res, 202, { id: 'pay-slow', status: 'processing' });
    const r = await order([{ productId: 'notebook-set', qty: 1 }]);
    expect(r.body.status).toBe('pending');
    await webhook({ id: 'evt-2', type: 'payment.failed', createdAt: new Date().toISOString(), data: { paymentId: 'pay-slow', reference: r.body.id, reason: 'declined_by_bank' } });
    expect((await api(`/api/orders/${r.body.id}`)).body).toMatchObject({ status: 'payment_failed', failureReason: 'declined_by_bank' });
  });
});

describe('webhook receiver', () => {
  it('rejects a bad signature, a tampered body and a wrong secret; ignores duplicates and unknown references', async () => {
    respond = (_r, res) => json(res, 202, { id: 'pay-w', status: 'processing' });
    const r = await order([{ productId: 'chai-tin', qty: 1 }]);
    const ev = (id: string, ref = r.body.id) => ({ id, type: 'payment.succeeded', createdAt: new Date().toISOString(), data: { paymentId: 'pay-w', reference: ref } });

    expect((await webhook(ev('e-bad'), generateSecret())).status).toBe(401); // wrong secret
    expect((await webhook(ev('e-tamper'), SECRET, true)).status).toBe(401); // body changed after signing
    expect((await api('/webhooks', { method: 'POST', body: JSON.stringify(ev('e-nosig')) })).status).toBe(401); // unsigned
    expect((await api(`/api/orders/${r.body.id}`)).body.status).toBe('pending'); // none of those changed anything

    expect((await webhook(ev('e-ok'))).status).toBe(200);
    expect((await api(`/api/orders/${r.body.id}`)).body.status).toBe('paid');
    const dup = await webhook(ev('e-ok'));
    expect(dup.body).toEqual({ duplicate: true }); // at-least-once delivery: duplicates are acknowledged and ignored
    expect((await webhook(ev('e-unknown', '11111111-2222-4333-8444-555555555555'))).status).toBe(200); // not ours: 2xx so it is not retried forever
  });
});

describe('input validation and wallet', () => {
  it('rejects bad carts, bad customers, missing idempotency key and invalid JSON', async () => {
    expect((await order([])).status).toBe(400);
    expect((await order([{ productId: 'ghost', qty: 1 }])).status).toBe(400);
    expect((await order([{ productId: 'chai-tin', qty: 99 }])).status).toBe(400);
    expect((await order([{ productId: 'chai-tin', qty: 1 }], 'bad customer!')).status).toBe(400);
    expect((await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: 'c', items: [{ productId: 'chai-tin', qty: 1 }] }) })).status).toBe(400); // no idempotency key
    expect((await api('/api/orders', { method: 'POST', headers: { 'idempotency-key': 'k' }, body: '{not json' })).status).toBe(400);
    expect(seen.filter((s) => s.url === '/v1/payments')).toHaveLength(0); // nothing reached payments
  });

  it('shows the wallet and tops up within bounds, forwarding an idempotency key', async () => {
    respond = (r, res) => (r.method === 'GET' ? json(res, 200, { customerId: 'c', balance: { availableMinor: '5000', heldMinor: '0' } }) : json(res, 201, {}));
    expect((await api('/api/customers/cust-9')).body.balance.availableMinor).toBe('5000');
    const ok = await api('/api/customers/cust-9/topup', { method: 'POST', headers: { 'idempotency-key': 'tu-1' }, body: JSON.stringify({ amountMinor: 250_000 }) });
    expect(ok.status).toBe(201);
    expect(seen.find((s) => s.url.endsWith('/topups'))!.headers['idempotency-key']).toBe('tu-1');
    for (const amountMinor of [0, 99, -5, 10_000_001, 12.5, '100']) {
      expect((await api('/api/customers/cust-9/topup', { method: 'POST', body: JSON.stringify({ amountMinor }) })).status, String(amountMinor)).toBe(400);
    }
    expect((await api('/api/customers/bad%20id')).status).toBe(400);
  });

  it('lists a customer\'s orders, newest first; needs a customerId', async () => {
    respond = (_r, res) => json(res, 201, { id: 'p', status: 'succeeded' });
    await order([{ productId: 'chai-tin', qty: 1 }], 'lister');
    await order([{ productId: 'jute-bag', qty: 1 }], 'lister');
    const list = (await api('/api/orders?customerId=lister')).body.orders;
    expect(list).toHaveLength(2);
    expect(list[0]!.createdAt >= list[1]!.createdAt).toBe(true);
    expect((await api('/api/orders')).status).toBe(400);
    expect((await api('/api/orders/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('static storefront', () => {
  it('serves the app and SPA routes, with security headers, and cannot be tricked into reading other files', async () => {
    const home = await fetch(`${shop.url}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('x-frame-options')).toBe('DENY');
    expect(home.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect((await fetch(`${shop.url}/cart`)).status).toBe(200); // client-side route
    expect((await fetch(`${shop.url}/assets/a.js`)).status).toBe(200);
    expect((await fetch(`${shop.url}/assets/nope.js`)).status).toBe(404);
    const traversal = await fetch(`${shop.url}/..%2f..%2f..%2fetc%2fpasswd.txt`);
    expect(traversal.status).toBe(404);
    expect((await traversal.text()).includes('root:')).toBe(false);
  });
});
