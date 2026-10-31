import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ADMIN_TOKEN, ENDPOINTS, RECEIVER_URL_IN_CLUSTER } from './config.js';
import { call, mustSucceed } from './http.js';

export const OUT_DIR = new URL('../out/', import.meta.url).pathname;
export const CUMULATIVE_FILE = `${OUT_DIR}cumulative.json`;

export interface SeedData {
  runId: string;
  merchants: { id: string; name: string; apiKey: string; ledgerAccountId: string }[];
  customers: { id: string; accountId: string }[];
  /** Money that entered the system in THIS seed, in paise: the independent expectation for conservation. */
  topupMinor: string;
}

/** Totals over every seed since the cluster was created (the databases are not wiped between runs). */
export interface Cumulative {
  topupMinor: string;
  webhookSecrets: string[];
}

export function readCumulative(): Cumulative {
  try {
    return JSON.parse(readFileSync(CUMULATIVE_FILE, 'utf8')) as Cumulative;
  } catch {
    return { topupMinor: '0', webhookSecrets: [] };
  }
}

const TOPUP_PER_CUSTOMER = 1_000_000n; // Rs 10,000: far more than a run can spend, so declines are never "insufficient funds"
const batches = async <T>(items: T[], size: number, fn: (item: T) => Promise<void>) => {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
};

/**
 * Create merchants (with webhook endpoints pointing at the in-cluster demo receiver) and funded customers.
 * Everything goes through the public APIs, exactly as a real integration would.
 */
export async function seed(opts: { runId: string; merchants?: number; customers?: number }): Promise<SeedData> {
  const { runId } = opts;
  const merchantCount = opts.merchants ?? 5;
  const customerCount = opts.customers ?? 300;
  const admin = { 'x-admin-token': ADMIN_TOKEN };

  const merchants: SeedData['merchants'] = [];
  const secrets: string[] = [];
  for (let i = 1; i <= merchantCount; i++) {
    const m = await mustSucceed('create merchant', () => call('POST', `${ENDPOINTS.payments}/admin/merchants`, { headers: admin, body: { name: `chaos-${runId}-m${i}`, feeBps: 250, rateLimitPerMin: 100_000 } }));
    merchants.push({ id: m.id, name: m.name, apiKey: m.apiKey, ledgerAccountId: m.ledgerAccountId });
    const ep = await mustSucceed('create webhook endpoint', () => call('POST', `${ENDPOINTS.webhook}/v1/webhook-endpoints`, { headers: { authorization: `Bearer ${m.apiKey}` }, body: { url: RECEIVER_URL_IN_CLUSTER, eventTypes: ['payment.succeeded'] } }));
    secrets.push(ep.secret);
  }

  // The receiver verifies signatures, so it must trust every secret (this run's and earlier runs').
  const cumulative = readCumulative();
  const allSecrets = [...cumulative.webhookSecrets, ...secrets];
  await mustSucceed('register secrets with receiver', () => call('POST', `${ENDPOINTS.receiver}/admin/secrets`, { body: { secrets: allSecrets } }));

  const bearer = { authorization: `Bearer ${merchants[0]!.apiKey}` };
  const ids = Array.from({ length: customerCount }, (_, i) => `chaos-${runId}-c${String(i + 1).padStart(4, '0')}`);
  const customers: SeedData['customers'] = [];
  await batches(ids, 20, async (id) => {
    const c = await mustSucceed('create customer', () => call('POST', `${ENDPOINTS.payments}/v1/customers`, { headers: bearer, body: { customerId: id } }));
    await mustSucceed('top up customer', () => call('POST', `${ENDPOINTS.payments}/v1/customers/${id}/topups`, { headers: { ...bearer, 'idempotency-key': `seed-topup-${id}` }, body: { amountMinor: TOPUP_PER_CUSTOMER.toString() } }));
    customers.push({ id, accountId: c.walletAccountId });
  });

  const topupMinor = (TOPUP_PER_CUSTOMER * BigInt(customerCount)).toString();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CUMULATIVE_FILE, JSON.stringify({ topupMinor: (BigInt(cumulative.topupMinor) + BigInt(topupMinor)).toString(), webhookSecrets: allSecrets } satisfies Cumulative, null, 2));
  const data: SeedData = { runId, merchants, customers, topupMinor };
  writeFileSync(`${OUT_DIR}seed.json`, JSON.stringify(data, null, 2));
  return data;
}
