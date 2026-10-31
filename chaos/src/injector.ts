import { ADMIN_TOKEN, ENDPOINTS } from './config.js';
import { call, sleep } from './http.js';

export interface Injection {
  at: string;
  kind: string;
  target: string;
  detail?: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

const admin = { 'x-admin-token': ADMIN_TOKEN };
const chaos = (method: string, path: string, body?: unknown) => call(method, `${ENDPOINTS.chaos}/chaos${path}`, { headers: admin, body, timeoutMs: 20_000 });
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

/** One fault = what to do, plus (optionally) how to undo it after a while. Both go through the chaos-controller API. */
interface Fault {
  name: string;
  weight: number;
  run: (record: (i: Omit<Injection, 'at'>) => void) => Promise<void>;
}

const kill = (service: string): Fault => ({
  name: `kill_${service}_pod`,
  weight: service === 'payments' ? 3 : 2,
  run: async (record) => {
    const r = await chaos('POST', `/services/${service}/kill`);
    record({ kind: 'pod_kill', target: service, ok: r.status === 200, ...(r.status === 200 ? {} : { error: JSON.stringify(r.body) }) });
  },
});

const faults: Fault[] = [
  kill('payments'),
  kill('ledger'),
  kill('webhook'),
  {
    // Kafka is down for a while: events pile up in the outbox and are published when it returns.
    name: 'kafka_pause',
    weight: 1,
    run: async (record) => {
      const seconds = Math.round(rand(8, 15));
      const r = await chaos('POST', '/services/kafka/stop');
      record({ kind: 'kafka_pause', target: 'kafka', detail: { seconds }, ok: r.status === 200 });
      await sleep(seconds * 1000);
      const back = await chaos('POST', '/services/kafka/start');
      if (back.status !== 200) record({ kind: 'kafka_resume_failed', target: 'kafka', ok: false, error: JSON.stringify(back.body) });
    },
  },
  {
    // The bank misbehaves for a window: slow, erroring, losing responses, duplicating/dropping callbacks.
    name: 'gateway_faults',
    weight: 3,
    run: async (record) => {
      const seconds = Math.round(rand(10, 20));
      const settings = { latencyMinMs: 100, latencyMaxMs: Math.round(rand(500, 2000)), errorRate: 0.15, lostResponseRate: 0.15, duplicateCallbackRate: 0.2, callbackDropRate: 0.1, declineRate: 0.05 };
      const r = await chaos('PUT', '/gateway', settings);
      record({ kind: 'gateway_faults', target: 'mock-gateway', detail: { seconds, ...settings }, ok: r.status === 200 });
      await sleep(seconds * 1000);
      await chaos('POST', '/gateway/reset');
    },
  },
  {
    // Network trouble between payments and its dependencies (Toxiproxy sits on that path).
    name: 'network_toxic',
    weight: 2,
    run: async (record) => {
      const proxy = pick(['ledger', 'gateway']);
      const seconds = Math.round(rand(8, 15));
      const toxic = pick([
        { type: 'latency', name: 'chaos_latency', toxicity: 1, attributes: { latency: Math.round(rand(300, 1500)), jitter: 300 } },
        // `timeout` with 0 holds the connection open and delivers nothing: the caller sees a timeout, outcome UNKNOWN
        { type: 'timeout', name: 'chaos_drop', toxicity: 0.3, attributes: { timeout: 0 } },
      ] as const);
      const add = await chaos('POST', `/network/${proxy}/toxics`, toxic);
      record({ kind: `network_${toxic.type}`, target: proxy, detail: { seconds, ...toxic.attributes, toxicity: toxic.toxicity }, ok: add.status === 200 });
      await sleep(seconds * 1000);
      await chaos('DELETE', `/network/${proxy}/toxics/${toxic.name}`);
    },
  },
  {
    // A hard partition for a few seconds: every connection through the proxy is cut.
    name: 'network_partition',
    weight: 1,
    run: async (record) => {
      const proxy = pick(['ledger', 'gateway']);
      const seconds = Math.round(rand(4, 8));
      const r = await chaos('POST', `/network/${proxy}/enabled`, { enabled: false });
      record({ kind: 'network_partition', target: proxy, detail: { seconds }, ok: r.status === 200 });
      await sleep(seconds * 1000);
      await chaos('POST', `/network/${proxy}/enabled`, { enabled: true });
    },
  },
];

const weighted = (): Fault => {
  const total = faults.reduce((s, f) => s + f.weight, 0);
  let n = Math.random() * total;
  for (const f of faults) if ((n -= f.weight) < 0) return f;
  return faults[0]!;
};

/**
 * Inject faults at random intervals until `stop` resolves. Faults overlap on purpose (a pod kill during a
 * gateway outage is the interesting case), but each kind of window fault runs at most once at a time.
 * Returns every injection that was attempted, with whether the chaos-controller accepted it.
 */
export async function runInjector(stop: Promise<void>, opts: { warmupMs?: number; minGapMs?: number; maxGapMs?: number } = {}): Promise<Injection[]> {
  const log: Injection[] = [];
  const record = (i: Omit<Injection, 'at'>) => {
    log.push({ at: new Date().toISOString(), ...i });
    console.log(`  chaos: ${i.kind} -> ${i.target}${i.detail ? ' ' + JSON.stringify(i.detail) : ''}${i.ok ? '' : '  (FAILED: ' + i.error + ')'}`);
  };
  let stopped = false;
  void stop.then(() => (stopped = true));
  const inFlight = new Set<Promise<void>>();
  const running = new Set<string>();

  await Promise.race([sleep(opts.warmupMs ?? 5_000), stop]);
  while (!stopped) {
    const fault = weighted();
    if (!running.has(fault.name)) {
      running.add(fault.name);
      const p = fault
        .run(record)
        .catch((err: Error) => record({ kind: fault.name, target: '-', ok: false, error: err.message }))
        .finally(() => running.delete(fault.name));
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    }
    await Promise.race([sleep(rand(opts.minGapMs ?? 4_000, opts.maxGapMs ?? 10_000)), stop]);
  }
  await Promise.all(inFlight); // let every window end and undo itself
  return log;
}

/** Put everything back: gateway faults off, toxics removed, anything chaos stopped started again. */
export async function resetChaos(): Promise<void> {
  const r = await chaos('POST', '/reset');
  if (r.status !== 200 || r.body?.ok === false) throw new Error(`chaos reset failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
}
