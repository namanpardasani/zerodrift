import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startGateway, type RunningGateway } from '@zerodrift/mock-gateway/app';
import { startLedger, type RunningLedger } from '@zerodrift/ledger/app';
import { createTestDatabase } from '@zerodrift/testing';
import { startPayments, type PaymentsAppOptions, type RunningPayments } from '../src/app.js';

/**
 * A tiny HTTP proxy placed between payments and the ledger so tests can break the link in specific
 * ways: drop requests whose path matches (e.g. only `/capture`), or go fully down. Dropped requests
 * have their socket destroyed, which the caller sees as a network error / unknown outcome.
 */
export interface ToggleProxy {
  url: string;
  down: boolean;
  dropPaths: string[];
  /** Requests that reached the proxy but were NOT dropped, i.e. were forwarded to the ledger. */
  forwarded: string[];
  close(): Promise<void>;
}

export async function startToggleProxy(target: string): Promise<ToggleProxy> {
  const proxy: ToggleProxy = { url: '', down: false, dropPaths: [], forwarded: [], close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    if (proxy.down || proxy.dropPaths.some((p) => req.url?.includes(p))) {
      req.socket.destroy();
      return;
    }
    proxy.forwarded.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)).map(([k, v]) => [k, String(v)])),
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((v, k) => !['content-encoding', 'transfer-encoding', 'connection'].includes(k) && res.setHeader(k, v));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      req.socket.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  proxy.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return proxy;
}

export interface Stack {
  ledger: RunningLedger;
  gateway: RunningGateway;
  payments: RunningPayments;
  ledgerProxy: ToggleProxy;
  api: Api;
  merchant: { id: string; apiKey: string; ledgerAccountId: string; feeBps: number };
  newMerchant(name?: string, feeBps?: number, rateLimitPerMin?: number): Promise<Stack['merchant']>;
  close(): Promise<void>;
}

export interface ApiOptions { key?: string | null; idempotencyKey?: string | null; body?: unknown; method?: string; headers?: Record<string, string> }
export type Api = (path: string, opts?: ApiOptions) => Promise<{ status: number; body: any; headers: Headers }>;

/** Real ledger + real mock-gateway + real payments service, all in-process, on real Postgres. */
export async function startStack(overrides: Partial<PaymentsAppOptions> = {}, kafkaBrokers?: string[]): Promise<Stack> {
  const ledgerDb = await createTestDatabase();
  const gatewayDb = await createTestDatabase();
  const paymentsDb = await createTestDatabase();

  const ledger = await startLedger({ databaseUrl: ledgerDb.url, port: 0, holdSweepIntervalSeconds: 0, logLevel: 'silent', kafkaBrokers });
  const gateway = await startGateway({ databaseUrl: gatewayDb.url, port: 0, logLevel: 'silent' });
  const ledgerProxy = await startToggleProxy(ledger.url);

  const payments = await startPayments({
    databaseUrl: paymentsDb.url,
    port: 0,
    ledgerUrl: ledgerProxy.url,
    gatewayUrl: gateway.url,
    recoveryScheduler: false, // tests trigger the recovery job explicitly
    kafkaBrokers,
    logLevel: 'silent',
    ledgerTimeoutMs: 3_000, // generous: ledger, gateway and payments share one event loop in tests
    config: { recoveryStuckAfterSeconds: 0, leaseSeconds: 5, holdTtlSeconds: 600, recoveryAbandonAfterSeconds: 300 },
    gatewayClient: { timeoutMs: 1_000, retries: 1, retryBaseMs: 10, breaker: { resetTimeoutMs: 400, volumeThreshold: 6 } },
    ...overrides,
  });

  const api: Api = async (path, opts = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
    if (opts.key !== null && opts.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const res = await fetch(`${payments.url}${path}`, { method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };

  async function newMerchant(name = `merchant-${randomUUID().slice(0, 6)}`, feeBps = 250, rateLimitPerMin?: number) {
    const r = await api('/admin/merchants', { method: 'POST', body: { name, feeBps, ...(rateLimitPerMin ? { rateLimitPerMin } : {}) }, headers: { 'x-admin-token': payments.config.adminToken } });
    if (r.status !== 201) throw new Error(`could not create merchant: ${JSON.stringify(r.body)}`);
    return { id: r.body.id as string, apiKey: r.body.apiKey as string, ledgerAccountId: r.body.ledgerAccountId as string, feeBps };
  }

  const merchant = await newMerchant();
  return {
    ledger, gateway, payments, ledgerProxy, api, merchant, newMerchant,
    close: async () => {
      await payments.close();
      await ledgerProxy.close();
      await gateway.close();
      await ledger.close();
    },
  };
}
