import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { SIGNATURE_HEADER, verifySignature } from '@zerodrift/webhooks';
import { CartError, PRODUCTS, type OrderLine, priceCart } from './catalog.js';

export type OrderStatus = 'pending' | 'paid' | 'payment_failed';

export interface Order {
  id: string;
  customerId: string;
  lines: OrderLine[];
  totalMinor: number;
  status: OrderStatus;
  paymentId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShopOptions {
  port: number;
  paymentsUrl: string;
  webhookUrl: string;
  adminToken: string;
  /** How the webhook service reaches THIS server (for the webhook endpoint it registers). */
  publicUrl?: string;
  staticDir?: string;
  /** Test hook: skip provisioning and use this merchant key / webhook secret. */
  merchant?: { apiKey: string; webhookSecret: string };
  log?: (msg: string) => void;
}

export interface RunningShop {
  url: string;
  orders: Map<string, Order>;
  state: { provisioned: boolean; merchantKey?: string; webhookSecrets: string[] };
  ready: Promise<void>;
  close(): Promise<void>;
}

const CUSTOMER_ID = /^[A-Za-z0-9_.:@-]{1,100}$/;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 100_000) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

/**
 * The demo merchant. A tiny storefront backend that shows how a REAL merchant integrates Zerodrift:
 *  - the API key stays on the SERVER (a browser must never hold it),
 *  - prices come from the server's catalogue,
 *  - the payment carries an Idempotency-Key derived from the order, so retries cannot double-charge,
 *  - an unknown outcome (timeout / 202) leaves the order PENDING and the signed webhook settles it,
 *  - webhooks are verified (signature + timestamp) and deduplicated by event id.
 */
export async function startShop(opts: ShopOptions): Promise<RunningShop> {
  const log = opts.log ?? (() => {});
  const orders = new Map<string, Order>();
  const byIdempotencyKey = new Map<string, string>();
  const seenEvents = new Set<string>();
  const state: RunningShop['state'] = { provisioned: false, webhookSecrets: [] };

  const paymentsFetch = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${opts.paymentsUrl}${p}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.merchantKey}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return { status: res.status, data: (await res.json().catch(() => null)) as any };
  };

  /** Register this shop as a merchant + webhook endpoint. Retries until the platform is up. */
  async function provision() {
    if (opts.merchant) {
      state.merchantKey = opts.merchant.apiKey;
      state.webhookSecrets = [opts.merchant.webhookSecret];
      state.provisioned = true;
      return;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const m = await fetch(`${opts.paymentsUrl}/admin/merchants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': opts.adminToken }, body: JSON.stringify({ name: `Demo Shop ${new Date().toISOString().slice(0, 16)}` }), signal: AbortSignal.timeout(8_000) });
        if (!m.ok) throw new Error(`create merchant -> HTTP ${m.status}`);
        state.merchantKey = ((await m.json()) as { apiKey: string }).apiKey;
        const ep = await fetch(`${opts.webhookUrl}/v1/webhook-endpoints`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${state.merchantKey}` }, body: JSON.stringify({ url: `${opts.publicUrl}/webhooks`, description: 'demo shop' }), signal: AbortSignal.timeout(8_000) });
        if (!ep.ok) throw new Error(`register webhook -> HTTP ${ep.status}`);
        state.webhookSecrets = [((await ep.json()) as { secret: string }).secret];
        state.provisioned = true;
        log('demo shop provisioned (merchant + webhook endpoint)');
        return;
      } catch (err) {
        log(`provisioning attempt ${attempt} failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, Math.min(5_000, 500 * attempt)));
      }
    }
  }

  const touch = (o: Order, patch: Partial<Order>) => Object.assign(o, patch, { updatedAt: new Date().toISOString() });

  function applyPaymentResult(order: Order, status: string, paymentId: string | null, reason: string | null) {
    if (paymentId && !order.paymentId) order.paymentId = paymentId;
    if (status === 'succeeded' || status === 'partially_refunded' || status === 'refunded') touch(order, { status: 'paid' });
    else if (status === 'failed') touch(order, { status: 'payment_failed', failureReason: reason });
    // anything else (processing/created) = outcome unknown yet: stays pending until the webhook says otherwise
  }

  async function createOrder(body: { customerId?: unknown; items?: unknown }, idemKey: string): Promise<{ status: number; body: unknown }> {
    const customerId = String(body.customerId ?? '');
    if (!CUSTOMER_ID.test(customerId)) return { status: 400, body: { error: 'Invalid customer id' } };
    const { lines, totalMinor } = priceCart(body.items as { productId: string; qty: number }[]);

    // the same checkout attempt (same Idempotency-Key) always yields the SAME order
    const existingId = byIdempotencyKey.get(idemKey);
    if (existingId) return { status: 200, body: orders.get(existingId) };

    const now = new Date().toISOString();
    const order: Order = { id: randomUUID(), customerId, lines, totalMinor, status: 'pending', paymentId: null, failureReason: null, createdAt: now, updatedAt: now };
    orders.set(order.id, order);
    byIdempotencyKey.set(idemKey, order.id);

    try {
      const r = await paymentsFetch('POST', '/v1/payments', { customerId, amountMinor: String(totalMinor), reference: order.id, description: lines.map((l) => `${l.qty} x ${l.name}`).join(', ').slice(0, 480) }, { 'idempotency-key': `order-${order.id}` });
      if (r.status === 201 || r.status === 202 || r.status === 200) applyPaymentResult(order, r.data.status, r.data.id, r.data.failureReason ?? null);
      else if (r.status === 409 || r.status === 503) log(`payment for order ${order.id} not accepted yet (HTTP ${r.status}); stays pending`);
      else touch(order, { status: 'payment_failed', failureReason: r.data?.error?.message ?? `payments answered HTTP ${r.status}` });
    } catch {
      // timeout / network error: the payment may or may not exist. NOT a failure: stay pending, the webhook decides.
      log(`payment call for order ${order.id} had an unknown outcome; staying pending`);
    }
    return { status: 201, body: order };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://shop');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok', provisioned: state.provisioned });
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { provisioned: state.provisioned });
    if (req.method === 'GET' && url.pathname === '/api/products') return send(200, { products: PRODUCTS });

    // ---- webhook receiver: verify -> dedupe -> act -> 2xx
    if (req.method === 'POST' && url.pathname === '/webhooks') {
      const raw = await readBody(req);
      const check = verifySignature(state.webhookSecrets, raw, req.headers[SIGNATURE_HEADER] as string | undefined);
      if (!check.ok) return send(401, { error: 'invalid signature' });
      const event = JSON.parse(raw) as { id: string; type: string; data: { paymentId?: string; reference?: string; reason?: string } };
      if (seenEvents.has(event.id)) return send(200, { duplicate: true });
      seenEvents.add(event.id);
      // match by OUR reference (the order id we sent): works even if the create-payment response was lost and we never learned the payment id
      const order = (event.data.reference ? orders.get(event.data.reference) : undefined) ?? [...orders.values()].find((o) => o.paymentId === event.data.paymentId);
      if (order && event.type === 'payment.succeeded') applyPaymentResult(order, 'succeeded', event.data.paymentId ?? null, null);
      else if (order && event.type === 'payment.failed') applyPaymentResult(order, 'failed', event.data.paymentId ?? null, event.data.reason ?? null);
      return send(200, { received: true });
    }

    if (!state.provisioned && url.pathname.startsWith('/api/')) return send(503, { error: 'Shop is still starting (registering with the payments platform)' });

    const customer = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
    if (req.method === 'GET' && customer) {
      const id = decodeURIComponent(customer[1]!);
      if (!CUSTOMER_ID.test(id)) return send(400, { error: 'Invalid customer id' });
      const r = await paymentsFetch('GET', `/v1/customers/${encodeURIComponent(id)}`);
      return send(r.status === 200 ? 200 : 502, r.status === 200 ? { customerId: id, balance: r.data.balance } : { error: 'Could not load wallet' });
    }

    const topup = url.pathname.match(/^\/api\/customers\/([^/]+)\/topup$/);
    if (req.method === 'POST' && topup) {
      const id = decodeURIComponent(topup[1]!);
      const body = JSON.parse((await readBody(req)) || '{}') as { amountMinor?: number };
      if (!CUSTOMER_ID.test(id)) return send(400, { error: 'Invalid customer id' });
      if (!Number.isInteger(body.amountMinor) || body.amountMinor! < 100 || body.amountMinor! > 10_000_000) return send(400, { error: 'Amount must be between ₹1 and ₹1,00,000' });
      const r = await paymentsFetch('POST', `/v1/customers/${encodeURIComponent(id)}/topups`, { amountMinor: String(body.amountMinor) }, { 'idempotency-key': String(req.headers['idempotency-key'] ?? `topup-${randomUUID()}`) });
      return send(r.status === 201 || r.status === 200 ? 201 : 502, r.status < 300 ? { ok: true } : { error: 'Top-up failed' });
    }

    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const idem = String(req.headers['idempotency-key'] ?? '');
      if (!idem) return send(400, { error: 'Idempotency-Key header is required' });
      const r = await createOrder(body, idem);
      return send(r.status, r.body);
    }

    const one = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && one) {
      const o = orders.get(one[1]!);
      return o ? send(200, o) : send(404, { error: 'Order not found' });
    }
    if (req.method === 'GET' && url.pathname === '/api/orders') {
      const customerId = url.searchParams.get('customerId');
      if (!customerId || !CUSTOMER_ID.test(customerId)) return send(400, { error: 'customerId is required' });
      return send(200, { orders: [...orders.values()].filter((o) => o.customerId === customerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }

    // ---- static storefront (built React app) with SPA fallback
    if (req.method === 'GET' && opts.staticDir && !url.pathname.startsWith('/api')) {
      const dir = path.resolve(opts.staticDir);
      const wanted = path.normalize(path.join(dir, url.pathname));
      const isAsset = /\.\w+$/.test(url.pathname);
      const file = wanted.startsWith(dir) && existsSync(wanted) && isAsset ? wanted : isAsset ? null : path.join(dir, 'index.html');
      if (file && existsSync(file)) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
        return void res.end(readFileSync(file));
      }
    }
    return send(404, { error: 'not found' });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (err instanceof CartError) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: err.message }));
      }
      log(`error: ${err.message}`);
      if (!res.headersSent) res.writeHead(err instanceof SyntaxError ? 400 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof SyntaxError ? 'Invalid JSON' : 'Internal error' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, '0.0.0.0', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!opts.publicUrl) opts.publicUrl = url;

  const ready = provision();
  return { url, orders, state, ready, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
