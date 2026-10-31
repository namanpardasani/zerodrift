export interface Reply<T = any> {
  status: number;
  body: T;
}

/** fetch + JSON with a hard timeout. Network errors are returned as status 0 (the caller decides what that means). */
export async function call<T = any>(method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<Reply<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: keep the text */
    }
    return { status: res.status, body: body as T };
  } catch (err) {
    return { status: 0, body: { error: (err as Error).message } as T };
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry a call until it gives a 2xx. Used by setup code that must not fail on a single dropped request. */
export async function mustSucceed<T>(what: string, fn: () => Promise<Reply<T>>, attempts = 5): Promise<T> {
  let last: Reply<T> | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.status >= 200 && last.status < 300) return last.body;
    await sleep(500 * (i + 1));
  }
  throw new Error(`${what} failed: HTTP ${last?.status} ${JSON.stringify(last?.body)}`);
}
