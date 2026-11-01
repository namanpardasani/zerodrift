/**
 * The REAL chaos-test numbers shown on the landing page. They are copied from docs/CHAOS_RESULTS.md (measured by
 * `pnpm chaos` on one laptop kind node) and test/landing.test.ts parses that document and fails if this file disagrees,
 * so a number can never be changed here without changing the measured record (or the other way round).
 */
export interface ChaosRun {
  run: number;
  mode: 'chaos' | 'baseline';
  loadSeconds: number;
  opsPerSecond: number;
  paymentP50Ms: number;
  paymentP99Ms: number;
  transferP50Ms: number;
  transferP99Ms: number;
  duplicatePairs: number;
  clientRetries: number;
  gaveUp: number;
  faults: number;
  recoverySeconds: number;
  invariants: string;
}

export const CHAOS_RUNS: ChaosRun[] = [
  { run: 1, mode: 'chaos', loadSeconds: 222, opsPerSecond: 46.3, paymentP50Ms: 5035, paymentP99Ms: 11903, transferP50Ms: 1052, transferP99Ms: 3897, duplicatePairs: 984, clientRetries: 1580, gaveUp: 339, faults: 27, recoverySeconds: 759, invariants: '9/9' },
  { run: 2, mode: 'chaos', loadSeconds: 205, opsPerSecond: 51.5, paymentP50Ms: 4390, paymentP99Ms: 11909, transferP50Ms: 967, transferP99Ms: 3558, duplicatePairs: 965, clientRetries: 211, gaveUp: 0, faults: 27, recoverySeconds: 35, invariants: '9/9' },
  { run: 3, mode: 'chaos', loadSeconds: 195, opsPerSecond: 52.2, paymentP50Ms: 4460, paymentP99Ms: 11530, transferP50Ms: 1170, transferP99Ms: 3387, duplicatePairs: 963, clientRetries: 784, gaveUp: 112, faults: 24, recoverySeconds: 56, invariants: '9/9' },
  { run: 4, mode: 'chaos', loadSeconds: 246, opsPerSecond: 42.6, paymentP50Ms: 5179, paymentP99Ms: 13064, transferP50Ms: 1250, transferP99Ms: 4674, duplicatePairs: 1028, clientRetries: 2324, gaveUp: 424, faults: 31, recoverySeconds: 30, invariants: '9/9' },
  { run: 5, mode: 'chaos', loadSeconds: 233, opsPerSecond: 44.6, paymentP50Ms: 4894, paymentP99Ms: 14294, transferP50Ms: 1166, transferP99Ms: 4282, duplicatePairs: 1028, clientRetries: 641, gaveUp: 0, faults: 30, recoverySeconds: 47, invariants: '9/9' },
  { run: 6, mode: 'chaos', loadSeconds: 224, opsPerSecond: 46.5, paymentP50Ms: 4779, paymentP99Ms: 13030, transferP50Ms: 943, transferP99Ms: 3081, duplicatePairs: 1073, clientRetries: 2820, gaveUp: 548, faults: 28, recoverySeconds: 49, invariants: '9/9' },
  { run: 7, mode: 'baseline', loadSeconds: 215, opsPerSecond: 46.7, paymentP50Ms: 4630, paymentP99Ms: 11818, transferP50Ms: 1330, transferP99Ms: 3242, duplicatePairs: 1042, clientRetries: 232, gaveUp: 0, faults: 0, recoverySeconds: 8, invariants: '9/9' },
];

const chaos = CHAOS_RUNS.filter((r) => r.mode === 'chaos');
const sum = (f: (r: ChaosRun) => number) => chaos.reduce((a, r) => a + f(r), 0);

/** Headline figures, derived from the table above (never typed twice). */
export const CHAOS_TOTALS = {
  runs: chaos.length,
  operations: chaos.length * 10_000,
  faults: sum((r) => r.faults),
  duplicatePairs: sum((r) => r.duplicatePairs),
  clientRetries: sum((r) => r.clientRetries),
  gaveUp: sum((r) => r.gaveUp),
  invariantEvaluations: chaos.length * 9,
  throughputMin: Math.min(...chaos.map((r) => r.opsPerSecond)),
  throughputMax: Math.max(...chaos.map((r) => r.opsPerSecond)),
  baselineThroughput: CHAOS_RUNS.find((r) => r.mode === 'baseline')!.opsPerSecond,
  paymentP50MinMs: Math.min(...chaos.map((r) => r.paymentP50Ms)),
  paymentP50MaxMs: Math.max(...chaos.map((r) => r.paymentP50Ms)),
  paymentP99MinMs: Math.min(...chaos.map((r) => r.paymentP99Ms)),
  paymentP99MaxMs: Math.max(...chaos.map((r) => r.paymentP99Ms)),
};

/** Faults by kind over the six chaos runs (from the same document). */
export const FAULT_KINDS: [label: string, count: number][] = [
  ['pod kills', 101],
  ['bank fault windows', 26],
  ['network partitions', 11],
  ['network latency windows', 10],
  ['dropped-connection windows', 10],
  ['kafka pauses', 9],
];

/** The two real bugs the chaos test found. */
export const CHAOS_BUGS: { title: string; body: string }[] = [
  { title: 'The ledger deadlocked its own connection pool', body: 'A payment capture borrowed a second database connection while already holding one. Under concurrent load every connection waited for another and both ledger pods stopped answering. Fixed, with a regression test that hangs without the fix.' },
  { title: 'Kafka forgot everything whenever it restarted', body: 'The broker wrote to a temporary directory instead of its volume, so each restart wiped every topic and about 2,000 published events vanished. Found by the webhook invariant after a Kafka pause. Fixed in the Helm chart.' },
];

export const CHAOS_DOC_URL = 'https://github.com/namanpardasani/zerodrift/blob/main/docs/CHAOS_RESULTS.md';
export const REPO_URL = 'https://github.com/namanpardasani/zerodrift';
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;
