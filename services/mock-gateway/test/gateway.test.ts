import { createTestDatabase } from '@zerodrift/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningGateway, startGateway } from '../src/app.js';

let gw: RunningGateway;
beforeAll(async () => {
  const { url } = await createTestDatabase();
  gw = await startGateway({ databaseUrl: url, port: 0, logLevel: 'silent' });
});
afterAll(() => gw.close());
beforeEach(() => gw.faults.reset());

let n = 0;
const ref = () => `ref-${Date.now()}-${n++}`;
const charge = (reference: string, extra: object = {}, signal?: AbortSignal) =>
  fetch(`${gw.url}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reference, amountMinor: '1000', ...extra }),
    signal,
  });

describe('mock gateway', () => {
  it('charges once per reference and returns the same decision on repeat', async () => {
    const r = ref();
    const a = await (await charge(r)).json();
    const b = await (await charge(r)).json();
    expect(a).toEqual({ reference: r, status: 'succeeded', failureCode: null, amountMinor: '1000', currency: 'INR' });
    expect(b).toEqual(a);
  });

  it('a decline is decided once and sticks, even if the decline rate later drops to 0', async () => {
    gw.faults.set({ declineRate: 1 });
    const r = ref();
    expect((await (await charge(r)).json()).status).toBe('failed');
    gw.faults.reset();
    expect((await (await charge(r)).json()).status).toBe('failed');
  });

  it('errorRate=1 answers HTTP 500 and records nothing', async () => {
    gw.faults.set({ errorRate: 1 });
    const r = ref();
    expect((await charge(r)).status).toBe(500);
    gw.faults.reset();
    expect((await fetch(`${gw.url}/charges/${r}`)).status).toBe(404);
  });

  it('lost response: the charge IS recorded but the caller never gets an answer', async () => {
    gw.faults.set({ lostResponseRate: 1 });
    const r = ref();
    await expect(charge(r, {}, AbortSignal.timeout(500))).rejects.toThrow();
    gw.faults.reset();
    const q = await (await fetch(`${gw.url}/charges/${r}`)).json();
    expect(q.status).toBe('succeeded'); // money moved at the bank even though the client saw a timeout
    // and retrying with the same reference is safe and returns the recorded outcome
    expect((await (await charge(r)).json()).status).toBe('succeeded');
  });

  it('latency is injected', async () => {
    gw.faults.set({ latencyMinMs: 300, latencyMaxMs: 300 });
    const t0 = Date.now();
    await charge(ref());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });

  it('cancel writes a tombstone: a late charge for that reference is refused', async () => {
    const r = ref();
    expect((await (await fetch(`${gw.url}/charges/${r}/cancel`, { method: 'POST' })).json()).status).toBe('cancelled');
    const late = await (await charge(r)).json();
    expect(late.status).toBe('cancelled');
  });

  it('cancel does not undo a charge that already succeeded; void does', async () => {
    const r = ref();
    await charge(r);
    expect((await (await fetch(`${gw.url}/charges/${r}/cancel`, { method: 'POST' })).json()).status).toBe('succeeded');
    expect((await (await fetch(`${gw.url}/charges/${r}/void`, { method: 'POST' })).json()).status).toBe('voided');
  });

  it('sends the async callback with a valid signature, and can duplicate or drop it', async () => {
    const received: { body: string; sig: string }[] = [];
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, sig: String(req.headers['x-gateway-signature']) });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const callbackUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/cb`;
    const { createHmac } = await import('node:crypto');
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await charge(ref(), { callbackUrl });
    await wait(800);
    expect(received).toHaveLength(1);
    expect(received[0]!.sig).toBe(createHmac('sha256', 'dev-gateway-secret').update(received[0]!.body).digest('hex'));

    received.length = 0;
    gw.faults.set({ duplicateCallbackRate: 1 });
    await charge(ref(), { callbackUrl });
    await wait(1_200);
    expect(received.length).toBeGreaterThanOrEqual(2);

    received.length = 0;
    gw.faults.set({ callbackDropRate: 1 });
    await charge(ref(), { callbackUrl });
    await wait(800);
    expect(received).toHaveLength(0);
    server.close();
  });

  it('settlement lists exactly the succeeded, non-voided charges of the day, as JSON and CSV', async () => {
    const ok = ref();
    const voided = ref();
    const declined = ref();
    await charge(ok);
    await charge(voided);
    await fetch(`${gw.url}/charges/${voided}/void`, { method: 'POST' });
    gw.faults.set({ declineRate: 1 });
    await charge(declined);
    gw.faults.reset();
    const today = new Date().toISOString().slice(0, 10);
    const file = await (await fetch(`${gw.url}/settlement?date=${today}`)).json();
    const refs = file.charges.map((c: { reference: string }) => c.reference);
    expect(refs).toContain(ok);
    expect(refs).not.toContain(voided);
    expect(refs).not.toContain(declined);
    const csv = await (await fetch(`${gw.url}/settlement?date=${today}&format=csv`)).text();
    expect(csv.split('\n')[0]).toBe('reference,amount_minor,currency,status,created_at');
    expect(csv).toContain(ok);
  });

  it('validates fault settings', async () => {
    const bad = await fetch(`${gw.url}/admin/faults`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ declineRate: 2 }) });
    expect(bad.status).toBe(400);
  });
});
