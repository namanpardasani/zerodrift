import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startChaos, type ChaosAppOptions, type RunningChaos } from '../src/app.js';

/** A fake Docker daemon on a real unix socket: records the API calls and tracks container states. */
function fakeDocker(socketPath: string) {
  const containers = ['ledger', 'payments', 'webhook', 'mock-gateway', 'kafka', 'postgres', 'chaos-controller'].map((service) => ({ Id: `id-${service}`, State: 'running', Status: 'Up 1 minute', Labels: { 'com.docker.compose.service': service, 'com.docker.compose.project': 'zerodrift' } }));
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url?.startsWith('/containers/json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(containers));
    }
    const m = req.url?.match(/^\/containers\/(id-[\w-]+)\/(\w+)/);
    const c = containers.find((x) => x.Id === m?.[1]);
    if (!c || !m) {
      res.writeHead(404);
      return res.end();
    }
    const states: Record<string, string> = { kill: 'exited', stop: 'exited', start: 'running', restart: 'running', pause: 'paused', unpause: 'running' };
    c.State = states[m[2]!]!;
    res.writeHead(204);
    res.end();
  });
  return new Promise<{ server: Server; containers: typeof containers; calls: string[] }>((resolve) => server.listen(socketPath, () => resolve({ server, containers, calls })));
}

/** Fake HTTP dependency that records what it receives. */
function fakeHttp(handler: (method: string, url: string, body: string) => { status: number; body?: unknown }) {
  const seen: { method: string; url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body });
      const r = handler(req.method!, req.url!, body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  return new Promise<{ server: Server; seen: typeof seen; url: string }>((resolve) => server.listen(0, () => resolve({ server, seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

let dir: string;
let docker: Awaited<ReturnType<typeof fakeDocker>>;
let gateway: Awaited<ReturnType<typeof fakeHttp>>;
let toxi: Awaited<ReturnType<typeof fakeHttp>>;
let chaos: RunningChaos;
const TOKEN = 'chaos-admin-token';

const baseOpts = (): ChaosAppOptions => ({ port: 0, nodeEnv: 'development', chaosEnabled: true, adminToken: TOKEN, dockerSocketPath: join(dir, 'docker.sock'), composeProject: 'zerodrift', gatewayUrl: gateway.url, toxiproxyUrl: toxi.url, logLevel: 'silent' });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chaos-'));
  docker = await fakeDocker(join(dir, 'docker.sock'));
  let faults: Record<string, number> = { declineRate: 0 };
  gateway = await fakeHttp((method, _url, body) => {
    if (method === 'PUT') faults = { ...faults, ...JSON.parse(body) };
    if (method === 'POST') faults = { declineRate: 0 };
    return { status: 200, body: faults };
  });
  toxi = await fakeHttp((method, url) => {
    if (method === 'GET' && url === '/proxies') return { status: 200, body: { ledger: { name: 'ledger', listen: '[::]:13001', upstream: 'ledger:3001', enabled: true, toxics: [] } } };
    if (url.endsWith('/toxics') && method === 'POST') return { status: 200, body: { name: 'latency_downstream' } };
    if (method === 'DELETE') return { status: 204 };
    return { status: 200, body: {} };
  });
  chaos = await startChaos(baseOpts());
});
afterAll(async () => {
  await chaos.close();
  for (const s of [docker.server, gateway.server, toxi.server]) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit & { token?: string | null } = {}) =>
  fetch(`${chaos.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.token === null ? {} : { 'x-admin-token': init.token ?? TOKEN }) } }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : ((await r.json().catch(() => null)) as any) }));

describe('safety', () => {
  it('refuses to start with chaos enabled in production', async () => {
    await expect(startChaos({ ...baseOpts(), nodeEnv: 'production', chaosEnabled: true })).rejects.toThrow(/not allowed when NODE_ENV=production/);
  });

  it('when disabled (the default, and always in production) every /chaos route is a 404, even with the right token', async () => {
    for (const nodeEnv of ['development', 'production']) {
      const off = await startChaos({ ...baseOpts(), nodeEnv, chaosEnabled: false });
      try {
        for (const [path, method] of [['/chaos/status', 'GET'], ['/chaos/services/ledger/kill', 'POST'], ['/chaos/reset', 'POST'], ['/chaos/events', 'GET']] as const) {
          const r = await fetch(`${off.url}${path}`, { method, headers: { 'x-admin-token': TOKEN } });
          expect(r.status, `${nodeEnv} ${method} ${path}`).toBe(404);
        }
        expect((await fetch(`${off.url}/health`)).status).toBe(200); // the service itself is fine
      } finally {
        await off.close();
      }
    }
  });

  it('needs the admin token when enabled', async () => {
    expect((await api('/chaos/status', { token: null })).status).toBe(401);
    expect((await api('/chaos/status', { token: 'nope-nope' })).status).toBe(401);
    expect((await api('/chaos/services/ledger/kill', { method: 'POST', token: null })).status).toBe(401);
  });

  it('only whitelisted services can be targeted: never databases, the controller itself or unknown names', async () => {
    for (const name of ['postgres', 'chaos-controller', 'dashboard-api', 'nope', '..%2F..%2Fetc']) {
      const r = await api(`/chaos/services/${name}/kill`, { method: 'POST', body: '{}' });
      expect(r.status, name).toBe(403);
    }
    expect((await api('/chaos/services/ledger/explode', { method: 'POST', body: '{}' })).status).toBe(400);
    expect(docker.calls.filter((c) => c.includes('/kill') || c.includes('/stop'))).toEqual([]); // nothing was actually sent
  });
});

describe('container chaos (Docker API)', () => {
  it('kill / pause / unpause / restart hit the right container with the right call, and are logged', async () => {
    for (const action of ['kill', 'pause', 'unpause', 'restart']) {
      const r = await api(`/chaos/services/payments/${action}`, { method: 'POST', body: '{}' });
      expect(r.status, action).toBe(200);
    }
    expect(docker.calls).toContain('POST /containers/id-payments/kill');
    expect(docker.calls).toContain('POST /containers/id-payments/pause');
    expect(docker.calls).toContain('POST /containers/id-payments/unpause');
    expect(docker.calls.some((c) => c.startsWith('POST /containers/id-payments/restart'))).toBe(true);
    const events = (await api('/chaos/events')).body.events;
    expect(events.map((e: { action: string }) => e.action)).toEqual(['restart', 'unpause', 'pause', 'kill']); // newest first
  });

  it('status reports state per whitelisted service only (postgres and the controller are not exposed)', async () => {
    await api('/chaos/services/kafka/pause', { method: 'POST', body: '{}' });
    const st = (await api('/chaos/status')).body;
    const byName = Object.fromEntries(st.services.map((s: { service: string; state: string }) => [s.service, s.state]));
    expect(byName.kafka).toBe('paused');
    expect(byName.ledger).toBe('running');
    expect(byName.postgres).toBeUndefined();
    expect(byName['chaos-controller']).toBeUndefined();
  });

  it('kill with restartAfterSeconds emulates an orchestrator: the service is started again after the delay', async () => {
    docker.calls.length = 0;
    const r = await api('/chaos/services/ledger/kill', { method: 'POST', body: JSON.stringify({ restartAfterSeconds: 1 }) });
    expect(r.body).toMatchObject({ ok: true, restartsInSeconds: 1 });
    expect(docker.calls).toContain('POST /containers/id-ledger/kill');
    expect(docker.containers.find((c) => c.Id === 'id-ledger')!.State).toBe('exited');
    await new Promise((res) => setTimeout(res, 1_500));
    expect(docker.calls).toContain('POST /containers/id-ledger/start');
    expect(docker.containers.find((c) => c.Id === 'id-ledger')!.State).toBe('running');
    const actions = (await api('/chaos/events')).body.events.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 2)).toEqual(['auto_restart', 'kill']);
    // validation, and "no restartAfterSeconds" means the service stays down
    expect((await api('/chaos/services/ledger/kill', { method: 'POST', body: JSON.stringify({ restartAfterSeconds: 9999 }) })).status).toBe(400);
    await api('/chaos/services/ledger/start', { method: 'POST', body: '{}' });
  });

  it('reset cancels pending auto-restarts', async () => {
    await api('/chaos/services/ledger/kill', { method: 'POST', body: JSON.stringify({ restartAfterSeconds: 1 }) });
    await api('/chaos/reset', { method: 'POST', body: '{}' });
    docker.calls.length = 0;
    await new Promise((res) => setTimeout(res, 1_400));
    expect(docker.calls.filter((c) => c.includes('/start') && c.includes('id-ledger'))).toEqual([]); // the timer was cancelled
  });

  it('reports a clear 502 when Docker cannot do it (unknown container)', async () => {
    docker.containers.splice(docker.containers.findIndex((c) => c.Labels['com.docker.compose.service'] === 'webhook'), 1);
    const r = await api('/chaos/services/webhook/kill', { method: 'POST', body: '{}' });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain('no container');
  });
});

describe('gateway faults and network chaos', () => {
  it('sets mock-gateway faults (validated) and resets them', async () => {
    const ok = await api('/chaos/gateway', { method: 'PUT', body: JSON.stringify({ lostResponseRate: 0.3, latencyMinMs: 100, latencyMaxMs: 400 }) });
    expect(ok.status).toBe(200);
    const sent = gateway.seen.filter((s) => s.method === 'PUT').pop()!;
    expect(JSON.parse(sent.body)).toEqual({ lostResponseRate: 0.3, latencyMinMs: 100, latencyMaxMs: 400 });
    expect((await api('/chaos/gateway', { method: 'PUT', body: JSON.stringify({ lostResponseRate: 7 }) })).status).toBe(400);
    expect((await api('/chaos/gateway', { method: 'PUT', body: JSON.stringify({ unknownKnob: 1 }) })).status).toBe(400);
    expect((await api('/chaos/gateway/reset', { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('adds and removes Toxiproxy toxics, partitions a proxy, and validates input', async () => {
    const add = await api('/chaos/network/ledger/toxics', { method: 'POST', body: JSON.stringify({ type: 'latency', attributes: { latency: 800, jitter: 200 } }) });
    expect(add.status).toBe(200);
    const sent = toxi.seen.find((s) => s.url === '/proxies/ledger/toxics')!;
    expect(JSON.parse(sent.body)).toMatchObject({ type: 'latency', stream: 'downstream', toxicity: 1, attributes: { latency: 800, jitter: 200 } });
    expect((await api('/chaos/network/ledger/toxics/latency_downstream', { method: 'DELETE' })).status).toBe(204);
    expect((await api('/chaos/network/ledger/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect(JSON.parse(toxi.seen.filter((s) => s.url === '/proxies/ledger').pop()!.body)).toEqual({ enabled: false });
    expect((await api('/chaos/network/ledger/toxics', { method: 'POST', body: JSON.stringify({ type: 'format_disk', attributes: {} }) })).status).toBe(400);
    expect((await api('/chaos/network/ledger/enabled', { method: 'POST', body: JSON.stringify({ enabled: 'yes' }) })).status).toBe(400);
    expect((await api('/chaos/status')).body.network).toHaveLength(1);
  });

  it('reset puts everything back: gateway faults cleared, toxics removed, paused/stopped services resumed', async () => {
    // set up its OWN state (tests above may have reset things): kafka frozen, webhook dead, payments healthy
    docker.containers.find((c) => c.Id === 'id-kafka')!.State = 'paused';
    docker.containers.push({ Id: 'id-webhook', State: 'exited', Status: 'Exited', Labels: { 'com.docker.compose.service': 'webhook', 'com.docker.compose.project': 'zerodrift' } });
    docker.containers.find((c) => c.Id === 'id-payments')!.State = 'running';
    docker.calls.length = 0;
    const r = await api('/chaos/reset', { method: 'POST', body: '{}' });
    expect(r.body).toEqual({ ok: true, errors: [] });
    expect(docker.calls).toContain('POST /containers/id-kafka/unpause'); // kafka was paused earlier
    expect(docker.calls).toContain('POST /containers/id-webhook/start');
    expect(docker.calls.filter((c) => c.includes('id-payments'))).toEqual([]); // payments is running again: reset leaves healthy services alone
  });
});
