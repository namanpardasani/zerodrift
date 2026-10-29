import { DomainError } from '@zerodrift/common';

export interface UpstreamResult<T = unknown> {
  status: number;
  data: T;
}

/** Calls one internal service on behalf of the dashboard. Outages become a clear 502 naming the service. */
export class Upstream {
  /** While set, calls fail immediately instead of waiting on a service that just proved unreachable. */
  private downUntil = 0;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 8_000,
    /**
     * After a connection-level failure, refuse further calls for this long. Why: a dead service can make
     * every call wait seconds (slow DNS failure, connect timeout); with many polling pages that piles up
     * and starves calls to HEALTHY services. Failing fast keeps the rest of the console responsive.
     */
    private readonly failFastMs = 3_000,
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<UpstreamResult<T>> {
    if (Date.now() < this.downUntil) {
      throw new DomainError('upstream_unavailable', `${this.name} is not reachable (failing fast after a recent failure)`, 502, { service: this.name });
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...this.headers, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.downUntil = Date.now() + this.failFastMs;
      throw new DomainError('upstream_unavailable', `${this.name} is not reachable (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'connection failed'})`, 502, { service: this.name });
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: res.status, data: data as T };
  }

  /** Like request(), but 4xx/5xx from the service are rethrown as errors with the service's own message. */
  async ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request<T & { error?: { code?: string; message?: string } }>(method, path, body);
    if (r.status >= 400) {
      const e = (r.data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new DomainError(e?.code ?? 'upstream_error', e?.message ?? `${this.name} answered HTTP ${r.status}`, r.status >= 500 ? 502 : r.status);
    }
    return r.data as T;
  }
}
