import type { FeedPayment, GatewayCharge, LedgerTx } from './types.js';
import type { InvariantReport } from './checks/internal.js';

/** A data source could not be read (down, timing out, 5xx). The run FAILS rather than guess. */
export class SourceUnavailable extends Error {}

async function getJson<T>(url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new SourceUnavailable(`${new URL(url).origin} unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new SourceUnavailable(`${new URL(url).origin}${new URL(url).pathname} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Follow `nextCursor` until the feed is exhausted. */
async function collect<T>(fetchPage: (after?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const { items, nextCursor } = await fetchPage(after);
    all.push(...items);
    if (!nextCursor) return all;
    after = nextCursor;
  }
  throw new SourceUnavailable('feed did not terminate (cursor loop?)');
}

export interface Sources {
  invariants(): Promise<InvariantReport>;
  ledgerTransactions(type: 'payment' | 'refund', from: Date, to: Date): Promise<LedgerTx[]>;
  payments(from: Date, to: Date): Promise<FeedPayment[]>;
  settlement(dates: string[]): Promise<GatewayCharge[]>;
}

export interface SourceUrls {
  ledgerUrl: string;
  paymentsUrl: string;
  gatewayUrl: string;
  /** Admin token of the payments service (its reconciliation feed is operator-only). */
  paymentsAdminToken: string;
  pageSize?: number;
}

export function createHttpSources(u: SourceUrls): Sources {
  const limit = u.pageSize ?? 1_000;
  return {
    invariants: () => getJson<InvariantReport>(`${u.ledgerUrl}/internal/invariants`),

    ledgerTransactions: (type, from, to) =>
      collect<LedgerTx>(async (after) => {
        const q = new URLSearchParams({ type, from: from.toISOString(), to: to.toISOString(), limit: String(limit), ...(after ? { after } : {}) });
        const r = await getJson<{ transactions: LedgerTx[]; nextCursor: string | null }>(`${u.ledgerUrl}/internal/transactions?${q}`);
        return { items: r.transactions, nextCursor: r.nextCursor };
      }),

    payments: (from, to) =>
      collect<FeedPayment>(async (after) => {
        const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), limit: String(limit), ...(after ? { after } : {}) });
        const r = await getJson<{ payments: FeedPayment[]; nextCursor: string | null }>(`${u.paymentsUrl}/internal/reconciliation/payments?${q}`, { 'x-admin-token': u.paymentsAdminToken });
        return { items: r.payments, nextCursor: r.nextCursor };
      }),

    settlement: async (dates) => {
      const files = await Promise.all(dates.map((d) => getJson<{ charges: GatewayCharge[] }>(`${u.gatewayUrl}/settlement?date=${d}`)));
      return files.flatMap((f) => f.charges);
    },
  };
}
