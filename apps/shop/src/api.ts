export class ShopApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function shopApi<T>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ShopApiError(data?.error ?? `Request failed (HTTP ${res.status})`, res.status);
  return data as T;
}

export interface Product { id: string; name: string; description: string; priceMinor: number }
export interface Order {
  id: string;
  customerId: string;
  lines: { productId: string; name: string; qty: number; unitPriceMinor: number }[];
  totalMinor: number;
  status: 'pending' | 'paid' | 'payment_failed';
  paymentId: string | null;
  failureReason: string | null;
  createdAt: string;
}
