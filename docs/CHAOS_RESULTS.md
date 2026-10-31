# Chaos results (Phase 9)

Everything here was measured by running `pnpm chaos` against the real Kubernetes deployment. Nothing is estimated.
Raw per-run JSON is written to `chaos/out/` (git-ignored); the table below is copied from those files.

## What was run

- **Platform:** kind (Kubernetes in Docker), one node, on a laptop (8 CPUs, 8 GB shared with Docker Desktop and other projects).
  Helm charts in `deploy/helm/`. Replicas: ledger 2, payments 3, webhook 2; Postgres, Kafka, Redis, Toxiproxy single instance.
- **Load (k6, `chaos/k6/load.js`):** 10,000 operations per run, 200 virtual users, 300 funded customers and 5 merchants (seeded fresh each run).
  75% payments through the payments API, 25% customer-to-customer transfers through the ledger API.
  About 10% of operations are duplicates: the identical request, same `Idempotency-Key`, sent twice at the same moment.
  Clients retry network errors, timeouts and 5xx with the same key (10 s request timeout).
- **Chaos (`chaos/src/injector.ts`, driven through the chaos-controller API), random every 4 to 10 s while the load runs:**
  pod kills (payments, ledger, webhook; the pod is force-deleted with grace period 0, a crash, not a graceful stop),
  mock-bank fault windows (latency, HTTP 500s, responses lost after the charge was recorded, duplicate and dropped callbacks, declines),
  Kafka paused (scaled to 0 for 8 to 15 s, then back), Toxiproxy latency, dropped connections ("timeout" toxic) and hard partitions on the payments to ledger / gateway paths.
  Faults overlap on purpose.
- **After the load:** every fault is removed, the harness waits until nothing is in flight (no payment in `created`/`processing`, no pending
  webhook delivery, no unpublished outbox event, every succeeded payment's event consumed), then runs both reconciliations and the invariant checker.
- **Invariant checker (`chaos/src/invariants.ts`):** plain SQL against the four databases, no service code. Its own tests
  (`chaos/test/invariants.test.ts`) corrupt a real database in a dozen specific ways (created money, unbalanced transaction, overdrawn account, charge for a failed payment, missing bank charge, stuck payment, stuck hold, missing/pending/duplicated webhook delivery, ...) and prove the right check fails each time.

## Invariants checked (all must hold after every run)

| # | Invariant |
|---|-----------|
| 1 | Money conserved exactly: sum of all balances equals the money that entered (top-ups, taken from the seed, not from the ledger); the clearing account holds exactly the negative of it; global sum is 0 |
| 2 | Every ledger transaction is balanced (debits == credits, at least two entries) |
| 3 | Every stored balance equals credits minus debits from the journal; no unauthorised negative balance |
| 4 | No money stuck in holds (no active hold, held balance 0) |
| 5 | No duplicate charge: at most one capture and one bank charge per payment; every succeeded payment has exactly one capture and a succeeded bank charge; no capture or standing bank charge for a payment that did not succeed; no more payments than distinct keys sent |
| 6 | No payment left in `created`/`processing` after the recovery window |
| 7 | Every succeeded payment has one `payment.succeeded` event and exactly one delivery per endpoint, delivered or dead-lettered (never pending); the receiver accepted each event at most once, and exactly once when we recorded it as delivered |
| 8 | Internal reconciliation clean |
| 9 | External reconciliation (payments vs the bank's settlement file) clean |

## Results: 6 chaos runs and 1 no-chaos baseline (10,000 operations each)

| Run | Mode | Load time (s) | Ops/s | Payment p50 / p99 (ms) | Transfer p50 / p99 (ms) | Duplicate pairs sent | Client retries | Gave up (outcome unknown to client) | Faults injected | Recovery (s) | Invariants |
|-----|------|------|------|------|------|------|------|------|------|------|------|
| 1 | chaos | 222 | 46.3 | 5035 / 11903 | 1052 / 3897 | 984 | 1580 | 339 | 27 | 759 | 9/9 |
| 2 | chaos | 205 | 51.5 | 4390 / 11909 | 967 / 3558 | 965 | 211 | 0 | 27 | 35 | 9/9 |
| 3 | chaos | 195 | 52.2 | 4460 / 11530 | 1170 / 3387 | 963 | 784 | 112 | 24 | 56 | 9/9 |
| 4 | chaos | 246 | 42.6 | 5179 / 13064 | 1250 / 4674 | 1028 | 2324 | 424 | 31 | 30 | 9/9 |
| 5 | chaos | 233 | 44.6 | 4894 / 14294 | 1166 / 4282 | 1028 | 641 | 0 | 30 | 47 | 9/9 |
| 6 | chaos | 224 | 46.5 | 4779 / 13030 | 943 / 3081 | 1073 | 2820 | 548 | 28 | 49 | 9/9 |
| 7 | none (baseline) | 215 | 46.7 | 4630 / 11818 | 1330 / 3242 | 1042 | 232 | 0 | 0 | 8 | 9/9 |

**Totals over the 6 chaos runs:** 60,000 operations, 167 faults injected (101 pod kills, 26 bank fault windows, 11 network partitions,
10 network latency windows, 10 dropped-connection windows, 9 Kafka pauses), 6,041 duplicate request pairs, 8,360 client retries,
and 1,423 operations where the client gave up without knowing the outcome. Every one of the 54 invariant evaluations (9 x 6) passed.
The databases were not wiped between runs (they were created fresh just before a 3,000-operation run that preceded run 1), so the invariants are
checked over everything accumulated: at the end of run 7, 53,170 payments (51,437 captured) and 72,113 ledger transactions.

How to read the numbers honestly:

- **Throughput is capacity, not chaos.** The baseline without any fault (46.7 ops/s) is inside the range of the chaos runs (42.6 to 52.2).
  200 virtual users on one laptop node saturate it: payment p50 is about 4.5 s even with no faults, and requests that exceed k6's 10 s timeout
  are retried. These are not production numbers; they say how much one shared 8 GB laptop node handles, not how the design scales.
- "Gave up" means the client's four attempts all failed (a timeout is an unknown outcome). Those operations may or may not have happened.
  The invariants held regardless, which is the point: retrying with the same key is always safe.
- Payments made per run are about 7,000 to 7,500 (75% of 10,000 operations, minus duplicates sharing a key). The invariant line "payments from N keys"
  shows that no key ever produced more than one payment.
- **Run 1 took 759 s to settle** while the others took 8 to 56 s. During that time the webhook consumer's lag stayed flat for several minutes and
  then drained within seconds, with no data loss. I could not reproduce it in five later runs and do not know the cause. After that run I added broker-side
  consumer-lag sampling to the recovery output (visible in later runs) so a recurrence can be diagnosed. The checks did what they should: they waited
  for the system to settle and then all passed. This is listed under known issues, not claimed as fixed.
- Single node: a node failure cannot be tested here (the "node" is one Docker container). Pod, process, network and dependency failures can.

## Bugs the chaos test caught (cause, fix, test added)

### 1. Ledger deadlocked its own connection pool under concurrent captures
- **Symptom:** first chaos run: both ledger pods stopped answering readiness probes and stayed NotReady for good. Postgres showed 27 sessions
  "idle in transaction" and the rest waiting on row locks.
- **Cause:** `HoldsService.captureHold` asked the connection pool for the database clock (`ledger.dbNow()`) from inside its transaction.
  That borrows a second connection while holding the first. With more concurrent captures than pool connections, every connection was held by
  a transaction waiting for another one. A deadlock the database cannot see, so no timeout ever fired.
- **Fix:** `dbNow` takes the executor and `captureHold` passes its transaction (`services/ledger/src/ledger.service.ts`, `holds.service.ts`).
  Hardening in `@zerodrift/db`: waiting for a connection fails after 10 s instead of forever, and Postgres kills sessions idle in a transaction for 60 s.
- **Test added:** `services/ledger/test/concurrency.test.ts`, "many concurrent captures through a tiny pool": 30 concurrent captures through a 3-connection
  pool. Verified to hang without the fix and pass with it.

### 2. Kafka lost every topic whenever it restarted (deployment bug, found by the Kafka-pause fault)
- **Symptom:** after the second chaos run, 439 succeeded payments had no webhook event, with consumer lag 0. The outbox claimed 6,418 events were
  published but the topic held 4,378.
- **Cause:** the Kafka image's data directory defaults to `/tmp/kafka-logs`, not the mounted volume. The chart's PVC was mounted but unused, so every
  Kafka restart silently wiped all topics and committed offsets. Services believed those events had been published (they had been acknowledged).
- **Fix:** `KAFKA_LOG_DIRS=/var/lib/kafka/data/logs` and `fsGroup: 1000` in `deploy/helm/zerodrift-infra/templates/kafka.yaml`.
  After the fix, nine Kafka pauses across the six runs lost nothing.
- **Test added:** the chaos run itself is the test (invariant 7 failed before, passes after), plus invariant 7 checks both directions (event present,
  delivery present). A unit test cannot see a deployment misconfiguration.

### 3. A harness bug, not a product bug (recorded so the numbers can be trusted)
- The first version of the "settled" check only waited for the outbox to drain. Events that were published but not yet consumed made invariant 7
  fail spuriously. The wait now also requires every succeeded payment's event to have been consumed, and a real loss still fails after the recovery window
  (bug 2 was found this way).

## Reproduce

```bash
pnpm chaos                       # creates the kind cluster if needed, runs 10,000 operations with chaos, prints the invariant report
NO_CHAOS=1 pnpm chaos            # baseline
FRESH=1 pnpm chaos               # rebuild the cluster (and databases) first
TOTAL=3000 RECOVERY_WINDOW_SECONDS=300 pnpm chaos
```

Needs Docker, kind, kubectl, helm and k6 (`scripts/install-tools.sh` installs them without sudo). The Compose stack must be stopped while kind runs (memory).
The exit code is 0 only if every invariant held. The test secrets in `deploy/helm/zerodrift/values-kind.yaml` are throwaway and protect nothing.
