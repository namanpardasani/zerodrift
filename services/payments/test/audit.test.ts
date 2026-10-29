import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './harness.js';

let s: Stack;
let M: Stack['merchant'];
beforeAll(async () => {
  s = await startStack();
  M = await s.newMerchant('audited');
});
afterAll(() => s.close());

const uid = () => randomUUID().slice(0, 8);
/** Audit rows for an action (optionally one resource), read straight from the database. */
const rows = async (action: string, resourceId?: string) => {
  const r = await sql<Record<string, unknown>>`SELECT * FROM audit_logs WHERE action = ${action} ORDER BY created_at`.execute(s.payments.db);
  return r.rows.filter((x) => !resourceId || x.resource_id === resourceId);
};
const admin = (path: string) => fetch(`${s.payments.url}${path}`, { headers: { 'x-admin-token': s.payments.config.adminToken } }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

async function funded(amount = 20_000) {
  const c = `cust-${uid()}`;
  await s.api(`/v1/customers/${c}/topups`, { key: M.apiKey, idempotencyKey: `tu-${uid()}`, body: { amountMinor: String(amount) } });
  return c;
}

describe('audit log', () => {
  it('records who created a payment, from where, with the correlation id and non-sensitive details', async () => {
    const c = await funded();
    const corr = `audit-corr-${uid()}`;
    const r = await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: `pay-${uid()}`, headers: { 'x-correlation-id': corr }, body: { customerId: c, amountMinor: '1234' } });
    const entry = (await rows('payment.created', r.body.id))[0]!;
    expect(entry).toBeDefined();
    expect(entry.actor).toBe(`merchant:${M.id}`);
    expect(entry.merchant_id).toBe(M.id);
    expect(entry.correlation_id).toBe(corr); // the same id that is in the request logs and the events
    expect(entry.ip).toBeTruthy();
    expect(entry.details).toMatchObject({ amountMinor: '1234', currency: 'INR', customerId: c });
  });

  it('an idempotent replay does not write a second audit entry', async () => {
    const c = await funded();
    const key = `pay-${uid()}`;
    const first = await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: key, body: { customerId: c, amountMinor: '500' } });
    await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: key, body: { customerId: c, amountMinor: '500' } });
    await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: key, body: { customerId: c, amountMinor: '500' } });
    expect(await rows('payment.created', first.body.id)).toHaveLength(1);
  });

  it('records refunds, wallet top-ups, merchant creation and recovery runs; merchant creation never stores the API key', async () => {
    const c = await funded();
    const p = (await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: `pay-${uid()}`, body: { customerId: c, amountMinor: '900' } })).body;
    const ref = (await s.api(`/v1/payments/${p.id}/refunds`, { key: M.apiKey, idempotencyKey: `ref-${uid()}`, body: { amountMinor: '100' } })).body;
    expect((await rows('refund.created', ref.id))).toHaveLength(1);
    expect((await rows('wallet.topped_up', c)).length).toBeGreaterThanOrEqual(1);

    const fresh = await s.newMerchant('audit-new');
    const mc = (await rows('merchant.created', fresh.id))[0]!;
    expect(mc.actor).toBe('admin');
    expect(JSON.stringify(mc)).not.toContain(fresh.apiKey); // secrets never go into the audit trail
    expect(JSON.stringify(mc)).not.toContain('zd_live_');

    await fetch(`${s.payments.url}/internal/recovery/run`, { method: 'POST', headers: { 'x-admin-token': s.payments.config.adminToken } });
    expect((await rows('recovery.run')).length).toBeGreaterThanOrEqual(1);
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
    const c = await funded();
    const r = await s.api('/v1/payments', { key: M.apiKey, idempotencyKey: `pay-${uid()}`, body: { customerId: c, amountMinor: '300' } });
    const id = (await rows('payment.created', r.body.id))[0]!.id as string;
    await expect(sql`UPDATE audit_logs SET actor = 'someone-else' WHERE id = ${id}`.execute(s.payments.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_logs WHERE id = ${id}`.execute(s.payments.db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_logs`.execute(s.payments.db)).rejects.toThrow(/append-only/);
  });

  it('is readable by operators only, filterable by merchant and action', async () => {
    expect((await fetch(`${s.payments.url}/admin/audit-logs`)).status).toBe(401);
    const all = await admin(`/admin/audit-logs?merchantId=${M.id}&action=payment.created`);
    expect(all.status).toBe(200);
    expect(all.body.logs.length).toBeGreaterThanOrEqual(2);
    expect(all.body.logs.every((l: { action: string; merchantId: string }) => l.action === 'payment.created' && l.merchantId === M.id)).toBe(true);
  });
});
