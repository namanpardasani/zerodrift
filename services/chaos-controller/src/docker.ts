import { request } from 'node:http';

export type ContainerAction = 'kill' | 'restart' | 'pause' | 'unpause' | 'start' | 'stop';
export const CONTAINER_ACTIONS: readonly ContainerAction[] = ['kill', 'restart', 'pause', 'unpause', 'start', 'stop'];

export interface ContainerInfo {
  service: string;
  state: string; // running | paused | exited | restarting ...
  status: string; // human readable, e.g. "Up 5 minutes (healthy)"
}

/** What chaos can act on. Everything else (databases, this controller itself, the dashboard) is off limits. */
export const CHAOS_TARGETS = ['ledger', 'payments', 'webhook', 'reconciliation', 'mock-gateway', 'demo-shop', 'demo-receiver', 'kafka', 'redis'] as const;

/**
 * Minimal Docker Engine API client over the unix socket (no docker CLI needed inside the container).
 * Containers are found through the labels docker compose puts on them.
 * (A Kubernetes backend with the same shape is added in Phase 9 for pod kills.)
 */
export class DockerBackend {
  constructor(
    private readonly socketPath: string,
    private readonly project: string,
  ) {}

  private call<T>(method: 'GET' | 'POST', path: string): Promise<{ status: number; data: T | null }> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path, method, timeout: 30_000 }, (res) => {
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
      });
      req.on('timeout', () => req.destroy(new Error('docker socket timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  async list(): Promise<(ContainerInfo & { id: string })[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${this.project}`] }));
    const { status, data } = await this.call<{ Id: string; State: string; Status: string; Labels: Record<string, string> }[]>('GET', `/containers/json?all=true&filters=${filters}`);
    if (status !== 200 || !data) throw new Error(`docker list failed (HTTP ${status})`);
    return data.map((c) => ({ id: c.Id, service: c.Labels['com.docker.compose.service'] ?? 'unknown', state: c.State, status: c.Status }));
  }

  async act(service: string, action: ContainerAction): Promise<void> {
    const target = (await this.list()).find((c) => c.service === service);
    if (!target) throw new Error(`no container for service "${service}"`);
    const path = action === 'stop' ? `/containers/${target.id}/stop?t=2` : action === 'restart' ? `/containers/${target.id}/restart?t=2` : `/containers/${target.id}/${action}`;
    const { status } = await this.call('POST', path);
    // 204 = done, 304 = already in that state (e.g. start on a running container): both fine
    if (status !== 204 && status !== 304) throw new Error(`docker ${action} ${service} failed (HTTP ${status})`);
  }
}
