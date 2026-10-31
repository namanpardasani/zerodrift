import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KubernetesBackend } from '../src/kubernetes.js';

const ready = (name: string, app: string) => ({ metadata: { name, labels: { 'app.kubernetes.io/name': app } }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });

/** A tiny fake Kubernetes API: two payments pods, one ledger Deployment with 2 replicas. */
let server: Server;
let backend: KubernetesBackend;
const calls: string[] = [];
const deployment = { metadata: { name: 'ledger', annotations: {} as Record<string, string | null> }, spec: { replicas: 2 } };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url} ${body}`);
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';
      if (req.method === 'GET' && url.includes('/pods?')) return res.end(JSON.stringify({ items: [ready('payments-a', 'payments'), ready('payments-b', 'payments')] }));
      if (req.method === 'DELETE' && url.includes('/pods/')) return res.end('{}');
      if (req.method === 'GET' && url.endsWith('/deployments/ledger')) return res.end(JSON.stringify(deployment));
      if (req.method === 'GET' && url.includes('/deployments/')) return res.writeHead(404).end('{}');
      if (req.method === 'GET' && url.includes('/statefulsets/')) return res.writeHead(404).end('{}');
      if (req.method === 'GET') return res.end(JSON.stringify({ items: [] }));
      if (req.method === 'PATCH') {
        const patch = JSON.parse(body);
        if (url.endsWith('/scale')) deployment.spec.replicas = patch.spec.replicas;
        else Object.assign(deployment.metadata.annotations, patch.metadata?.annotations ?? {});
        return res.end('{}');
      }
      res.writeHead(500).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  backend = new KubernetesBackend({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, namespace: 'zerodrift' });
});
afterAll(() => server.close());

describe('KubernetesBackend', () => {
  it('lists services with ready pod counts', async () => {
    const list = await backend.list();
    expect(list).toContainEqual({ service: 'payments', state: 'running', status: '2/2 pods ready' });
  });

  it('kill force-deletes exactly one pod', async () => {
    await backend.act('payments', 'kill');
    const deletes = calls.filter((c) => c.startsWith('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatch(/pods\/payments-[ab] .*"gracePeriodSeconds":0/);
  });

  it('stop scales to zero remembering replicas; start restores; start is a no-op if chaos did not stop it', async () => {
    await backend.act('ledger', 'start'); // not stopped by chaos: must not touch replicas
    expect(deployment.spec.replicas).toBe(2);
    await backend.act('ledger', 'stop');
    expect(deployment.spec.replicas).toBe(0);
    await backend.act('ledger', 'start');
    expect(deployment.spec.replicas).toBe(2);
    expect(deployment.metadata.annotations['zerodrift.io/replicas-before-stop']).toBeNull();
  });

  it('restart writes the rollout-restart annotation', async () => {
    await backend.act('ledger', 'restart');
    expect(calls.some((c) => c.startsWith('PATCH') && c.includes('kubectl.kubernetes.io/restartedAt'))).toBe(true);
  });

  it('fails clearly for an unknown service', async () => {
    await expect(backend.act('nope', 'restart')).rejects.toThrow(/no deployment or statefulset/);
  });
});
