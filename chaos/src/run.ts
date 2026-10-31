/**
 * One command: `pnpm chaos`  (from the repo root)
 *
 *   1. make sure the kind cluster is up (creates it if not)
 *   2. seed merchants, funded customers and webhook endpoints through the public APIs
 *   3. run k6 (10,000 payments/transfers, ~10% duplicates, client retries) while injecting faults
 *   4. remove every fault, wait for the system to recover
 *   5. run reconciliation and the invariant checker, print the report, save the results as JSON
 *
 * Options (env): TOTAL=10000 VUS=200 CUSTOMERS=300 MERCHANTS=5 RECOVERY_WINDOW_SECONDS=240 NO_CHAOS=1 FRESH=1
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { ADMIN_TOKEN, ENDPOINTS, NAMESPACE, POSTGRES } from './config.js';
import { call, sleep } from './http.js';
import { type Injection, resetChaos, runInjector } from './injector.js';
import { type CheckResult, type Databases, reconciliationResult, runInvariants } from './invariants.js';
import { CUMULATIVE_FILE, OUT_DIR, readCumulative, seed } from './seed.js';

const REPO = new URL('../../', import.meta.url).pathname;
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO });

function section(title: string) {
  console.log(`\n== ${title}`);
}

async function ensureCluster() {
  const pods = sh('kubectl', ['-n', NAMESPACE, 'get', 'pods', '--no-headers']);
  const up = pods.status === 0 && pods.stdout.split('\n').filter(Boolean).length >= 15;
  if (process.env.FRESH || !up) {
    section(process.env.FRESH ? 'rebuilding the cluster from scratch' : 'cluster not up: creating it (first time takes several minutes)');
    if (process.env.FRESH) {
      spawnSync(`${REPO}deploy/kind/down.sh`, { stdio: 'inherit', cwd: REPO });
      rmSync(CUMULATIVE_FILE, { force: true }); // new databases: the running totals start again from zero
    }
    const r = spawnSync(`${REPO}deploy/kind/up.sh`, { stdio: 'inherit', cwd: REPO, env: { ...process.env, SKIP_BUILD: process.env.SKIP_BUILD ?? '' } });
    if (r.status !== 0) throw new Error('deploy/kind/up.sh failed');
  }
}

/** Wait until every pod is Ready and every service answers /ready. */
async function waitHealthy(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const ports = [ENDPOINTS.ledger, ENDPOINTS.payments, ENDPOINTS.webhook, ENDPOINTS.reconciliation, ENDPOINTS.gateway, ENDPOINTS.chaos];
  while (Date.now() < deadline) {
    const answers = await Promise.all(ports.map((u) => call('GET', `${u}/ready`, { timeoutMs: 3_000 })));
    const pods = sh('kubectl', ['-n', NAMESPACE, 'get', 'pods', '--no-headers']).stdout.split('\n').filter(Boolean);
    const notReady = pods.filter((l) => !/\s1\/1\s+Running/.test(l));
    if (answers.every((a) => a.status === 200) && notReady.length === 0) return;
    await sleep(2_000);
  }
  throw new Error('the cluster did not become healthy in time');
}

function databases(): { db: Databases; close: () => Promise<void> } {
  const pool = (database: string) => new pg.Pool({ ...POSTGRES, database, max: 2 });
  const pools = { ledger: pool('ledger'), payments: pool('payments'), webhook: pool('webhook'), gateway: pool('gateway') };
  return { db: pools, close: async () => void (await Promise.all(Object.values(pools).map((p) => p.end()))) };
}

/** Everything that must reach a final state once faults stop. */
async function unsettled(db: Databases) {
  const [payments, deliveries, ledgerOutbox, paymentsOutbox] = await Promise.all([
    db.payments.query(`SELECT COUNT(*)::int AS n FROM payments WHERE status IN ('created','processing')`),
    db.webhook.query(`SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE status = 'pending'`),
    db.ledger.query(`SELECT COUNT(*)::int AS n FROM outbox WHERE published_at IS NULL`),
    db.payments.query(`SELECT COUNT(*)::int AS n FROM outbox WHERE published_at IS NULL`),
  ]);
  // events that were published but not yet consumed by the webhook service: succeeded payments with no stored event
  const [succeeded, stored] = await Promise.all([
    db.payments.query(`SELECT id::text AS id FROM payments WHERE status IN ('succeeded','partially_refunded','refunded')`),
    db.webhook.query(`SELECT payload->>'aggregateId' AS id FROM webhook_events WHERE event_type = 'payment.succeeded'`),
  ]);
  const have = new Set<string>(stored.rows.map((r) => r.id as string));
  const eventsNotConsumed = succeeded.rows.filter((r) => !have.has(r.id as string)).length;
  return { eventsNotConsumed, payments: payments.rows[0].n as number, deliveries: deliveries.rows[0].n as number, unpublishedEvents: (ledgerOutbox.rows[0].n as number) + (paymentsOutbox.rows[0].n as number) };
}

/** Total lag of a consumer group, read from the broker itself (kafka-consumer-groups.sh in the Kafka pod). */
function consumerLag(group: string): string {
  const r = sh('kubectl', ['-n', NAMESPACE, 'exec', 'kafka-0', '--', '/opt/kafka/bin/kafka-consumer-groups.sh', '--bootstrap-server', 'localhost:9092', '--describe', '--group', group]);
  if (r.status !== 0) return 'n/a';
  const lags = r.stdout.split('\n').slice(1).map((l) => Number(l.trim().split(/\s+/)[5])).filter((n) => Number.isFinite(n));
  return lags.length ? String(lags.reduce((a, b) => a + b, 0)) : 'n/a';
}

async function receiverCounts(): Promise<Record<string, number>> {
  const r = await call<{ received: { eventId: string; outcome: string }[] }>('GET', `${ENDPOINTS.receiver}/received`, { timeoutMs: 60_000 });
  if (r.status !== 200) throw new Error(`could not read the receiver log: HTTP ${r.status}`);
  const counts: Record<string, number> = {};
  for (const x of r.body.received) if (x.outcome === 'ok') counts[x.eventId] = (counts[x.eventId] ?? 0) + 1;
  return counts;
}

async function reconcile(kind: 'internal' | 'external') {
  // Retry: a run in progress answers 409; a freshly written payment may still be inside the grace period.
  let last: { status?: string; mismatches?: unknown[] } | null = null;
  for (let i = 0; i < 6; i++) {
    const r = await call('POST', `${ENDPOINTS.reconciliation}/v1/recon/runs`, { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { kind }, timeoutMs: 180_000 });
    if (r.status === 200) {
      last = r.body;
      if (r.body.status === 'clean') break;
    }
    await sleep(5_000);
  }
  return reconciliationResult(kind, last);
}

async function main() {
  const startedAt = new Date();
  const runId = `r${startedAt.toISOString().replace(/\D/g, '').slice(2, 14)}`;
  const total = num('TOTAL', 10_000);
  const recoveryWindow = num('RECOVERY_WINDOW_SECONDS', 240);
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Zerodrift chaos run ${runId}: ${total} operations, ${process.env.NO_CHAOS ? 'NO chaos (baseline)' : 'with chaos'}`);

  await ensureCluster();
  await waitHealthy();
  await resetChaos();

  section('seeding');
  const data = await seed({ runId, merchants: num('MERCHANTS', 5), customers: num('CUSTOMERS', 300) });
  console.log(`  ${data.merchants.length} merchants, ${data.customers.length} funded customers`);

  section('load + chaos');
  const summaryFile = `${OUT_DIR}k6-summary-${runId}.json`;
  const k6 = spawn('k6', ['run', '--quiet', '-e', `SEED_FILE=${OUT_DIR}seed.json`, '-e', `TOTAL=${total}`, '-e', `VUS=${num('VUS', 200)}`, '-e', `PAYMENTS_URL=${ENDPOINTS.payments}`, '-e', `LEDGER_URL=${ENDPOINTS.ledger}`, '-e', `SUMMARY_FILE=${summaryFile}`, `${REPO}chaos/k6/load.js`], { stdio: ['ignore', 'inherit', 'inherit'] });
  const k6Done = new Promise<number>((resolve) => k6.on('close', (code) => resolve(code ?? 1)));
  const loadStarted = Date.now();
  let injections: Injection[] = [];
  if (process.env.NO_CHAOS) {
    await k6Done;
  } else {
    injections = await runInjector(k6Done.then(() => undefined));
  }
  const k6Code = await k6Done;
  const loadSeconds = (Date.now() - loadStarted) / 1000;
  if (k6Code !== 0) console.log(`  k6 exited with code ${k6Code}`);

  section('recovery');
  await resetChaos();
  await waitHealthy();
  const { db, close } = databases();
  const recoveryStarted = Date.now();
  let state = await unsettled(db);
  while (Date.now() - recoveryStarted < recoveryWindow * 1000 && (state.payments > 0 || state.deliveries > 0 || state.unpublishedEvents > 0 || state.eventsNotConsumed > 0)) {
    console.log(`  waiting: ${state.payments} payments in flight, ${state.deliveries} deliveries pending, ${state.unpublishedEvents} events unpublished, ${state.eventsNotConsumed} not yet consumed by webhooks (broker-side lag: webhook-service ${consumerLag('webhook-service')})`);
    await sleep(5_000);
    state = await unsettled(db);
  }
  const recoverySeconds = Math.round((Date.now() - recoveryStarted) / 1000);
  console.log(`  settled after ${recoverySeconds}s (${state.payments} payments, ${state.deliveries} deliveries, ${state.unpublishedEvents} unpublished and ${state.eventsNotConsumed} unconsumed events still open)`);

  section('reconciliation');
  const recon = [await reconcile('internal'), await reconcile('external')];

  section('invariants');
  const k6Summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as Record<string, unknown>;
  const checks: CheckResult[] = [
    ...(await runInvariants(db, { expectedTopupMinor: BigInt(readCumulative().topupMinor), runKeyPrefix: runId, uniqueKeysSent: k6Summary.uniqueKeys as number, receiver: await receiverCounts() })),
    ...recon,
  ];
  await close();

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failures = checks.filter((c) => !c.passed);
  for (const c of failures) console.log(`\n  ${c.name} violations (first ${c.violations.length}):\n${JSON.stringify(c.violations, null, 2)}`);

  const byKind: Record<string, number> = {};
  for (const i of injections) byKind[i.kind] = (byKind[i.kind] ?? 0) + (i.ok ? 1 : 0);
  const result = {
    runId,
    startedAt: startedAt.toISOString(),
    chaos: !process.env.NO_CHAOS,
    load: { seconds: loadSeconds, ...k6Summary },
    faultsInjected: { total: injections.filter((i) => i.ok).length, rejected: injections.filter((i) => !i.ok).length, byKind },
    recovery: { seconds: recoverySeconds, remaining: state },
    invariants: { passed: checks.filter((c) => c.passed).length, total: checks.length, checks },
    injections,
  };
  writeFileSync(`${OUT_DIR}result-${runId}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${OUT_DIR}result-latest.json`, JSON.stringify(result, null, 2));

  section('summary');
  console.log(`  ${total} operations in ${loadSeconds.toFixed(0)}s, ${(k6Summary.throughputOpsPerSecond as number).toFixed(1)} ops/s`);
  console.log(`  faults injected: ${result.faultsInjected.total} ${JSON.stringify(byKind)}`);
  console.log(`  invariants: ${result.invariants.passed}/${result.invariants.total} passed -> ${failures.length === 0 ? 'ALL INVARIANTS HELD' : 'VIOLATIONS FOUND'}`);
  console.log(`  saved ${OUT_DIR}result-${runId}.json`);
  process.exit(failures.length === 0 && k6Code === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
