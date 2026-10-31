import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ContainerAction, ContainerBackend, ContainerInfo } from './docker.js';

export interface KubernetesOptions {
  /** e.g. https://kubernetes.default.svc (or http://127.0.0.1:8001 for tests). */
  apiUrl: string;
  token?: string;
  /** PEM of the cluster CA (in-cluster: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt). */
  ca?: string;
  namespace: string;
}

const STOPPED_FROM = 'zerodrift.io/replicas-before-stop';
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

interface Pod {
  metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string };
  status?: { phase?: string; conditions?: { type: string; status: string }[] };
}
interface Workload {
  kind?: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: { replicas?: number };
}

const isReady = (p: Pod) => p.status?.phase === 'Running' && !p.metadata.deletionTimestamp && p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true;

/**
 * Chaos against a Kubernetes cluster, using the API directly (no kubectl in the image) with the pod's
 * own ServiceAccount. Differences from Docker, on purpose:
 *   kill    deletes ONE pod immediately (grace period 0 = a crash). Its Deployment then replaces it by
 *           itself: that is the orchestrator behaviour a single Docker host does not have.
 *   stop    scales the workload to zero (remembering the previous replica count)
 *   start   scales it back, but ONLY if chaos stopped it (otherwise a no-op: it must never shrink a service)
 *   restart rolling restart (the same annotation `kubectl rollout restart` writes)
 *   pause / unpause have no Kubernetes equivalent for a process; they map to stop / start (an outage, not a freeze).
 */
export class KubernetesBackend implements ContainerBackend {
  constructor(private readonly opts: KubernetesOptions) {}

  /** Configuration from the in-cluster environment (ServiceAccount token, CA, namespace). */
  static inCluster(): KubernetesBackend {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
    if (!host) throw new Error('not running inside a Kubernetes cluster (KUBERNETES_SERVICE_HOST is not set)');
    return new KubernetesBackend({
      apiUrl: `https://${host}:${port}`,
      token: readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
      ca: readFileSync(`${SA_DIR}/ca.crt`, 'utf8'),
      namespace: readFileSync(`${SA_DIR}/namespace`, 'utf8').trim(),
    });
  }

  private call<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; data: T | null }> {
    const url = new URL(path, this.opts.apiUrl);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = send(
        url,
        { method, ca: this.opts.ca, timeout: 15_000, headers: { accept: 'application/json', ...(payload ? { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) } : {}), ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data: T | null = null;
            try {
              data = text ? (JSON.parse(text) as T) : null;
            } catch {
              data = null;
            }
            resolve({ status: res.statusCode ?? 0, data });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('kubernetes API timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private ns = (p: string) => `/api/v1/namespaces/${this.opts.namespace}${p}`;
  private appsNs = (p: string) => `/apis/apps/v1/namespaces/${this.opts.namespace}${p}`;

  private async pods(selector: string): Promise<Pod[]> {
    const { status, data } = await this.call<{ items: Pod[] }>('GET', `${this.ns('/pods')}?labelSelector=${encodeURIComponent(selector)}`);
    if (status !== 200 || !data) throw new Error(`listing pods failed (HTTP ${status})`);
    return data.items;
  }

  async list(): Promise<(ContainerInfo & { id?: string })[]> {
    const all = await this.pods('app.kubernetes.io/part-of in (zerodrift,zerodrift-infra)');
    const byService = new Map<string, Pod[]>();
    for (const p of all) {
      const name = p.metadata.labels?.['app.kubernetes.io/name'];
      if (name) byService.set(name, [...(byService.get(name) ?? []), p]);
    }
    const out: ContainerInfo[] = [...byService].map(([service, pods]) => {
      const ready = pods.filter(isReady).length;
      return { service, state: ready > 0 ? 'running' : 'restarting', status: `${ready}/${pods.length} pods ready` };
    });
    // workloads scaled to zero have no pods at all: report them as stopped so the panel can offer "Start"
    for (const kind of ['deployments', 'statefulsets']) {
      const { data } = await this.call<{ items: Workload[] }>('GET', this.appsNs(`/${kind}`));
      for (const w of data?.items ?? []) {
        if (!byService.has(w.metadata.name) && w.metadata.annotations?.[STOPPED_FROM]) out.push({ service: w.metadata.name, state: 'exited', status: 'scaled to 0' });
      }
    }
    return out;
  }

  private async workload(service: string): Promise<{ kind: 'deployments' | 'statefulsets'; w: Workload }> {
    for (const kind of ['deployments', 'statefulsets'] as const) {
      const { status, data } = await this.call<Workload>('GET', this.appsNs(`/${kind}/${encodeURIComponent(service)}`));
      if (status === 200 && data) return { kind, w: data };
    }
    throw new Error(`no deployment or statefulset named "${service}"`);
  }

  private async patch(path: string, body: unknown) {
    const r = await this.call('PATCH', path, body, 'application/merge-patch+json');
    if (r.status >= 300) throw new Error(`kubernetes PATCH ${path} failed (HTTP ${r.status})`);
  }

  async act(service: string, action: ContainerAction): Promise<void> {
    if (action === 'kill') {
      const running = (await this.pods(`app.kubernetes.io/name=${service}`)).filter((p) => p.status?.phase === 'Running' && !p.metadata.deletionTimestamp);
      if (running.length === 0) throw new Error(`no running pod for "${service}"`);
      const victim = running[Math.floor(Math.random() * running.length)]!;
      const r = await this.call('DELETE', this.ns(`/pods/${victim.metadata.name}`), { gracePeriodSeconds: 0 });
      if (r.status >= 300) throw new Error(`deleting pod ${victim.metadata.name} failed (HTTP ${r.status})`);
      return;
    }
    const { kind, w } = await this.workload(service);
    const base = this.appsNs(`/${kind}/${w.metadata.name}`);
    if (action === 'restart') {
      await this.patch(base, { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } });
    } else if (action === 'stop' || action === 'pause') {
      const current = w.spec.replicas ?? 1;
      if (current === 0) return; // already stopped
      await this.patch(base, { metadata: { annotations: { [STOPPED_FROM]: String(current) } } });
      await this.patch(`${base}/scale`, { spec: { replicas: 0 } });
    } else if (action === 'start' || action === 'unpause') {
      const before = w.metadata.annotations?.[STOPPED_FROM];
      if (!before) return; // chaos did not stop it: never touch the replica count
      await this.patch(`${base}/scale`, { spec: { replicas: Number(before) } });
      await this.patch(base, { metadata: { annotations: { [STOPPED_FROM]: null } } });
    }
  }
}
