import { randomBytes, randomUUID } from 'node:crypto';
import { makeEvent } from '@zerodrift/events';
import { startReceiver, type Receiver } from '@zerodrift/demo-receiver/app';
import { createTestDatabase, waitFor } from '@zerodrift/testing';
import { startWebhook, type RunningWebhook, type WebhookAppOptions } from '../src/app.js';
import type { WebhookConfig } from '../src/config.js';

export interface Env {
  webhook: RunningWebhook;
  receiver: Receiver;
  databaseUrl: string;
  merchant(name?: string): { id: string; key: string };
  api(path: string, opts?: { key?: string | null; method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  /** Create an endpoint through the real API and make the demo receiver trust its secret. */
  createEndpoint(m: { key: string }, opts?: { url?: string; eventTypes?: string[]; trust?: boolean }): Promise<{ id: string; secret: string }>;
  /** Plan deliveries for a new event of `m`, exactly as the Kafka handler does. */
  enqueue(m: { id: string }, type?: 'payment.succeeded' | 'payment.created' | 'refund.created', occurredAt?: Date): Promise<string>;
  /** Run the worker until every delivery is in a final state (or time runs out). */
  pump(timeoutMs?: number): Promise<void>;
  deliveryRows(eventId?: string): Promise<{ id: string; status: string; attempt_count: number; endpoint_id: string; event_id: string }[]>;
  close(): Promise<void>;
}

export async function startEnv(cfg: Partial<WebhookConfig> = {}, extra: Partial<WebhookAppOptions> = {}): Promise<Env> {
  const { url } = await createTestDatabase();
  const keys = new Map<string, string>();
  const receiver = await startReceiver({ secrets: [] });
  const webhook = await startWebhook({
    databaseUrl: url,
    port: 0,
    logLevel: 'silent',
    startWorker: false, // tests drive the worker explicitly
    authenticator: { authenticate: async (k) => (keys.has(k) ? { id: keys.get(k)! } : null) },
    config: {
      encryptionKey: randomBytes(32),
      allowPrivateUrls: true, // the demo receiver is on localhost
      backoffBaseMs: 20,
      backoffMaxMs: 100,
      backoffMinMs: 1,
      timeoutMs: 600,
      maxAttempts: 4,
      ...cfg,
    },
    ...extra,
  });

  const merchant = (name = 'm') => {
    const m = { id: randomUUID(), key: `key-${name}-${randomUUID()}` };
    keys.set(m.key, m.id);
    return m;
  };

  const api: Env['api'] = async (path, opts = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    const res = await fetch(`${webhook.url}${path}`, { method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const createEndpoint: Env['createEndpoint'] = async (m, opts = {}) => {
    const r = await api('/v1/webhook-endpoints', { key: m.key, body: { url: opts.url ?? `${receiver.url}/webhooks`, eventTypes: opts.eventTypes } });
    if (r.status !== 201) throw new Error(`create endpoint failed: ${JSON.stringify(r.body)}`);
    if (opts.trust !== false) receiver.secrets = [r.body.secret];
    return { id: r.body.id, secret: r.body.secret };
  };

  const enqueue: Env['enqueue'] = async (m, type = 'payment.succeeded', occurredAt = new Date()) => {
    const paymentId = randomUUID();
    const payload = { paymentId, merchantId: m.id, customerId: 'c1', amountMinor: '1000', currency: 'INR' };
    const env =
      type === 'payment.succeeded'
        ? makeEvent(type, 'payment', paymentId, { ...payload, gatewayRef: paymentId }, { occurredAt })
        : type === 'payment.created'
          ? makeEvent(type, 'payment', paymentId, payload, { occurredAt })
          : makeEvent(type, 'refund', paymentId, { refundId: paymentId, paymentId, merchantId: m.id, amountMinor: '100', currency: 'INR' }, { occurredAt });
    await webhook.db.transaction().execute((trx) => webhook.deliveries.enqueueForEvent(trx, env, m.id));
    return env.eventId;
  };

  const deliveryRows: Env['deliveryRows'] = async (eventId) => {
    let q = webhook.db.selectFrom('webhook_deliveries').select(['id', 'status', 'attempt_count', 'endpoint_id', 'event_id']);
    if (eventId) q = q.where('event_id', '=', eventId);
    return q.execute();
  };

  const pump: Env['pump'] = async (timeoutMs = 15_000) => {
    await waitFor(async () => {
      await webhook.worker.runOnce();
      const pending = await webhook.db.selectFrom('webhook_deliveries').select('id').where('status', '=', 'pending').execute();
      return pending.length === 0;
    }, timeoutMs, 10);
  };

  return {
    webhook,
    receiver,
    databaseUrl: url,
    merchant,
    api,
    createEndpoint,
    enqueue,
    pump,
    deliveryRows,
    close: async () => {
      await webhook.close();
      await receiver.close();
    },
  };
}
