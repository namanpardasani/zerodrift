async function json<T>(url: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(5_000) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

export interface GatewayFaults {
  latencyMinMs: number;
  latencyMaxMs: number;
  declineRate: number;
  errorRate: number;
  lostResponseRate: number;
  duplicateCallbackRate: number;
  callbackDropRate: number;
}

/** Controls the mock bank's fault knobs. */
export class GatewayControl {
  constructor(private readonly baseUrl: string) {}
  async get(): Promise<GatewayFaults> {
    return (await json<GatewayFaults>(`${this.baseUrl}/admin/faults`)).data;
  }
  async set(faults: Partial<GatewayFaults>): Promise<{ status: number; data: unknown }> {
    return json(`${this.baseUrl}/admin/faults`, { method: 'PUT', body: JSON.stringify(faults) });
  }
  async reset(): Promise<GatewayFaults> {
    return (await json<GatewayFaults>(`${this.baseUrl}/admin/faults/reset`, { method: 'POST', body: '{}' })).data;
  }
}

export interface ToxiproxyProxy {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics: { name: string; type: string; stream: string; toxicity: number; attributes: Record<string, number> }[];
}

/** Controls Toxiproxy (network faults between services). https://github.com/Shopify/toxiproxy */
export class ToxiproxyControl {
  constructor(private readonly baseUrl: string) {}
  async proxies(): Promise<ToxiproxyProxy[]> {
    const { data } = await json<Record<string, ToxiproxyProxy>>(`${this.baseUrl}/proxies`);
    return Object.values(data);
  }
  async addToxic(proxy: string, toxic: { type: string; name?: string; stream?: 'upstream' | 'downstream'; toxicity?: number; attributes: Record<string, number> }) {
    return json<unknown>(`${this.baseUrl}/proxies/${encodeURIComponent(proxy)}/toxics`, { method: 'POST', body: JSON.stringify({ stream: 'downstream', toxicity: 1, ...toxic, name: toxic.name ?? `${toxic.type}_${toxic.stream ?? 'downstream'}` }) });
  }
  async removeToxic(proxy: string, name: string) {
    const res = await fetch(`${this.baseUrl}/proxies/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(name)}`, { method: 'DELETE', signal: AbortSignal.timeout(5_000) });
    return res.status;
  }
  async setEnabled(proxy: string, enabled: boolean) {
    return json<unknown>(`${this.baseUrl}/proxies/${encodeURIComponent(proxy)}`, { method: 'POST', body: JSON.stringify({ enabled }) });
  }
  /** Remove every toxic and re-enable every proxy. */
  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/reset`, { method: 'POST', signal: AbortSignal.timeout(5_000) });
  }
}
