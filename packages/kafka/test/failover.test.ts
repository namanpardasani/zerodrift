import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inject, waitFor } from '@zerodrift/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxPublisher, type Producer, createProducer } from '../src/index.js';
import { createServiceDb, createTopics, writeOutbox } from './helpers.js';

/**
 * What happens to a consumer group when a member DIES (no goodbye, like a killed pod)? Its partitions must move to a survivor
 * and nothing may be lost or handled twice. This measures how long the hand-over takes with the settings the services use.
 * (It was written while chasing one unexplained chaos run in which webhook consumption stalled for minutes.)
 */
let svc: Awaited<ReturnType<typeof createServiceDb>>;
let producer: Producer;
const children: ChildProcess[] = [];

beforeAll(async () => {
  svc = await createServiceDb();
  producer = await createProducer((await createTopics()).kafka);
});
afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  await producer.disconnect();
  await svc.pool.end();
});

const handled = async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM handled`.execute(svc.db)).rows[0]!.n);
const childFile = fileURLToPath(new URL('./failover-child.ts', import.meta.url));

function startChild(env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', childFile], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += String(d)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child consumer did not start')), 60_000);
    child.stdout!.on('data', (d) => String(d).includes('READY') && (clearTimeout(timer), resolve(child)));
    child.on('exit', (code) => reject(new Error(`child exited early (${code}): ${stderr.slice(0, 600)}`)));
  });
}

describe('consumer group failover', () => {
  it('a consumer killed with SIGKILL hands its partitions to the survivor: nothing lost, nothing handled twice, and how long it took', async () => {
    const t = await createTopics();
    const group = `g-${randomUUID()}`;
    const env = { DATABASE_URL: svc.url, KAFKA_BROKERS: inject('kafkaBrokers'), GROUP: group, TOPIC: t.topic };
    const pub = new OutboxPublisher({ db: svc.db, producer, service: 'failover', topicFor: t.topicFor, lockId: 77 });
    const publishAll = async () => {
      for (let i = 0; i < 20 && Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM outbox WHERE published_at IS NULL`.execute(svc.db)).rows[0]!.n) > 0; i++) await pub.publishOnce();
    };

    const [a, b] = await Promise.all([startChild(env), startChild(env)]);
    // warm-up: both members are in the group and everything flows
    for (let n = 0; n < 30; n++) await writeOutbox(svc.db, `agg-${n % 9}`, n);
    await publishAll();
    await waitFor(async () => (await handled()) === 30, 60_000);

    // crash one member, then keep producing: the 3 partitions must all be served by the survivor
    a.kill('SIGKILL');
    const killedAt = Date.now();
    for (let n = 30; n < 60; n++) await writeOutbox(svc.db, `agg-${n % 9}`, n);
    await publishAll();
    await waitFor(async () => (await handled()) === 60, 150_000, 250);
    const takeoverSeconds = (Date.now() - killedAt) / 1000;
    const line = `failover: all 30 events produced after the kill were handled ${takeoverSeconds.toFixed(1)} s after the kill`;
    console.log(line);
    if (process.env.FAILOVER_REPORT) appendFileSync(process.env.FAILOVER_REPORT, `${line}\n`); // vitest hides test output by default; this lets a human read the number

    const dupes = await sql<{ n: string }>`SELECT count(*)::text AS n FROM (SELECT event_id FROM handled GROUP BY event_id HAVING count(*) > 1) d`.execute(svc.db);
    expect(Number(dupes.rows[0]!.n)).toBe(0); // the inbox: no event handled twice
    expect(await handled()).toBe(60);
    // per-aggregate order survived the hand-over
    for (let k = 0; k < 9; k++) {
      const rows = await sql<{ n: number }>`SELECT n FROM handled WHERE aggregate_id = ${`agg-${k}`} ORDER BY id`.execute(svc.db);
      const ns = rows.rows.map((r) => r.n);
      expect(ns).toEqual([...ns].sort((x, y) => x - y));
    }
    expect(takeoverSeconds, 'the survivor must take over within a few session timeouts').toBeLessThan(30);
    b.kill('SIGKILL');
  }, 300_000);
});
