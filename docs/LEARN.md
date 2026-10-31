# Learning Zerodrift: a guided tour

This is for you, studying the code after it was built. It is ordered so each idea only needs the ones before it. For every concept you get: the problem, the idea, **where it lives (file and function)**, why it is correct, and a way to *see* it work (a test to run or break).

Read with the code open. Paths are from the repository root. Commands assume `pnpm install` has been run; the tests start real Postgres/Kafka/Redis with Testcontainers, so Docker must be running.

## The five ideas everything else rests on

1. **Money is an integer.** Never a float. We store *paise* in a `BIGINT`.
2. **Money is never edited, only moved.** Every change is a set of balanced debit and credit entries; history is append-only.
3. **A network can lose either the request or the answer, and you cannot tell which.** So every step must be safe to repeat (idempotent), and "I got no answer" must be treated as *unknown*, not *failed*.
4. **Write the intent and the fact in the same database transaction.** (The outbox.) Anything you do *outside* the database after that must be repeatable.
5. **Prove it by breaking it.** Tests for the logic; chaos for the system; an independent checker that does not trust either.

## Reading order

| # | Read | Why now |
|---|---|---|
| 1 | `packages/money/src/index.ts` | tiny; shows how amounts are parsed, validated and how fees round (half up, in integers) |
| 2 | `services/ledger/src/migrations/0001_ledger_schema.ts` | the database *is* the first line of defence: tables, immutability and balance triggers |
| 3 | `services/ledger/src/posting.ts` | the one function that writes entries (`post`), the locking rule (`lockBalances`), the retry on deadlock (`inTransaction`) |
| 4 | `services/ledger/src/ledger.service.ts`, `holds.service.ts` | transfers, reversals, holds, captures built on `post` |
| 5 | `services/payments/src/state-machine.ts`, `payments.repo.ts` | which status changes are legal, and how a change is made safely under concurrency |
| 6 | `services/payments/src/idempotency.service.ts`, `payments.service.ts` | claiming a key atomically with creating the payment |
| 7 | `services/payments/src/saga.service.ts`, `recovery.service.ts` | the payment workflow and the job that finishes what crashes leave behind |
| 8 | `services/payments/src/clients/*.ts` | retries, timeouts, the circuit breaker; where "unknown" is born |
| 9 | `packages/kafka/src/outbox-writer.ts`, `outbox-publisher.ts`, `idempotent-consumer.ts` | events: outbox, publisher, inbox |
| 10 | `services/webhook/src/*` and `packages/webhooks/src/index.ts` | signed, retried, dead-lettered deliveries |
| 11 | `services/reconciliation/src/*` | do the books, the payments and the bank agree? |
| 12 | `chaos/src/*`, `chaos/k6/load.js`, `docs/CHAOS_RESULTS.md` | how the proof is built and what it found |
| 13 | `NOTES.md` | every decision and bug, phase by phase |

---

## 1. Money as integers

**Problem:** `0.1 + 0.2 !== 0.3` in floating point. A ledger that rounds wrongly by one paisa is a ledger that is wrong.
**Idea:** store the smallest unit (paise) as an integer; format only at the edge.
**Where:** `packages/money/src/index.ts`: `parseMinor` (accepts bigint or integer strings; rejects floats, negatives, junk and values above `MAX_MINOR`, the `BIGINT` limit), `feeFor` (basis points, **half-up** rounding in integer arithmetic), `splitFee`, `proportionalFee` (a partial refund returns a proportional share of the fee and never more than was charged). In the database every amount is `bigint`; `packages/db/src/index.ts` registers a parser so Postgres `BIGINT` arrives as a JavaScript `bigint`, never a lossy number. Over HTTP amounts are **strings** (JSON numbers lose precision above 2^53).
**Why it is correct:** integers are exact; the property tests (`packages/money/src/money.test.ts`) check `fee + net === amount` for random inputs.
**See it:** `pnpm --filter @zerodrift/money test`; look at `formatInr` in `packages/ui/src/format.ts`: it formats from a `bigint`, so ₹92,23,37,20,36,85,47,758.07 (the `BIGINT` maximum) prints exactly.

## 2. Double-entry bookkeeping

**Problem:** how do you move money so that it can never be created or destroyed by a bug?
**Idea:** every movement is a *transaction* of *entries*: some debits, some credits, **total debits = total credits**. A balance is credits minus debits. Because every transaction nets to zero, the sum of all balances is always zero: money only ever moves between accounts. The outside world is an account too (`gateway_clearing`, allowed to go negative): when a customer tops up, the clearing account is debited and their wallet credited.
**Where:**
- Schema: `services/ledger/src/migrations/0001_ledger_schema.ts`: `accounts`, `account_balances`, `ledger_transactions`, `journal_entries`, `holds`.
- **Immutability:** trigger `journal_entries_immutable` (+ `journal_entries_no_update_delete`, `journal_entries_no_truncate`) rejects `UPDATE`, `DELETE`, `TRUNCATE`.
- **Balance, checked twice:** `validateEntries` in `services/ledger/src/posting.ts` (code, with a clear message) and the **deferred constraint trigger** `journal_entries_balanced` / `assert_transaction_balanced()` (`DEFERRABLE INITIALLY DEFERRED`: it fires at `COMMIT`, after all of a transaction's entries are in).
- **No overdraft:** trigger `account_balances_non_negative` / `enforce_non_negative_balance()` unless `accounts.allow_negative`.
- **Currency match:** `journal_entries` has a composite foreign key `(account_id, currency)`, so an entry cannot use a currency different from its account.
- **The one write path:** `post()` in `posting.ts`. Nothing else inserts entries or moves a balance.
- **Undo = mirror:** `LedgerService.reverse()` posts the mirror image; `UNIQUE(reverses_transaction_id)` makes a double reversal impossible even under concurrency. Refunds execute as ledger postings (`services/payments/src/refunds.service.ts`).
**Why it is correct:** three independent layers (code, constraint trigger, immutability trigger) must *all* fail for money to leak. And `InvariantsService.check()` (`services/ledger/src/invariants.service.ts`) recomputes everything from the journal and compares it to the stored balances.
**See it:** `services/ledger/test/ledger.test.ts` (try to unbalance a transaction); `services/ledger/test/property.test.ts` runs *random* sequences of top-ups, transfers, holds, captures, releases and reversals against an in-memory model and checks every invariant afterwards. Then, in `psql`, try `UPDATE journal_entries SET amount_minor = 1;` and read the error.

## 3. Holds and captures

**Problem:** between "the customer says pay" and "the bank says yes" the money must be *reserved* (so it cannot be spent twice) but not yet *moved*.
**Idea:** a **hold** moves money from `available` to `held` on the same wallet (nothing leaves the account). A **capture** later pays it out of the held amount to the merchant and the fee account in one transaction; a **release** (or expiry) puts it back to available. A capture may be partial; the remainder is released at once.
**Where:** `services/ledger/src/holds.service.ts`: `createHold`, `captureHold`, `releaseHold`, `expireDueHolds` (each hold in its own short transaction, `FOR UPDATE SKIP LOCKED`, so several sweepers can run side by side), `moveBalance`. The `fromHold` flag on an entry (`paymentEntries` in `ledger.service.ts`) tells `post` to debit `held_minor` instead of `available_minor`. `account_balances.held_minor` has `CHECK (held_minor >= 0)`, and `InvariantsService` verifies `held_minor` equals the sum of that account's active holds.
**See it:** the hold tests in `services/ledger/test/ledger.test.ts`; in the console, a payment in flight shows its money as "on hold" in the shop's wallet bar.

## 4. Idempotency (including concurrent duplicates)

**Problem:** a client times out, retries, and the customer is charged twice. Or two copies of one request arrive at the same instant.
**Idea:** the client sends a unique `Idempotency-Key`. The server stores the *result* under that key, together with a hash of the request. Same key + same request: return the stored result, do nothing. Same key + different request: reject (422). The key is **claimed atomically** with the work, so two concurrent copies cannot both execute.
**Where:**
- **Ledger level:** `post()` does `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. If a concurrent request already inserted the key, Postgres **blocks** this insert until that transaction commits or rolls back; then `post` reads the winner's stored response and returns it (`replayed: true`), or throws `idempotencyMismatch` when `request_hash` differs. `hashRequest` (in `posting.ts`) hashes the operation and parameters.
- **Payments level:** `services/payments/src/idempotency.service.ts`: `IdempotencyService.begin()` claims `(merchant_id, key)` in the *same transaction that creates the payment* (`PaymentsService.create` in `payments.service.ts`), so there is no moment where a key is claimed but nothing was created, or the reverse. `begin()` returns `claimed`, `replay` (a finished request: the stored response comes back verbatim, or the payment's *current* state if the stored response was "202 processing"), or `in_progress` (a concurrent duplicate while the saga still runs: HTTP 409; the duplicate is counted, which is what the operator console shows as "a duplicate request was absorbed").
- **Deterministic keys inside the saga:** `hold:<paymentId>`, `capture:<paymentId>`, and the bank reference *is* the payment id, so retrying any step after a crash re-sends the identical request and is answered from the first.
**Why it is correct:** uniqueness is enforced by the database, not by an `if` in application code that two requests could both pass.
**See it:** `services/payments/test/payments.test.ts`, *"20 concurrent duplicates: exactly one payment, one hold, one gateway charge, customer charged once"*. In the chaos runs the checker proved it over 6,041 duplicate pairs (`no_duplicate_charges` in `chaos/src/invariants.ts`).

## 5. The payment state machine

**Problem:** a payment must never go backwards (a failed payment must not become succeeded), even when a retry and a recovery job act at once.
**Idea:** a table of legal transitions, and every change made as a **compare-and-set**.
**Where:** `services/payments/src/state-machine.ts`: `TRANSITIONS` (`created → processing | failed`, `processing → succeeded | failed`, `succeeded → partially_refunded | refunded`, `failed` and `refunded` are terminal), `assertTransition`. `PaymentsRepo.transition()` in `payments.repo.ts` runs `UPDATE payments SET status = $to ... WHERE id = $id AND status = $whatWeLastSaw`. If another worker moved it meanwhile, zero rows match and we return *their* result instead of overwriting it. The timeline row and, for terminal states, the **outbox event** are written in that same transaction (`recordTransition`).
**See it:** `services/payments/src/state-machine.test.ts`; the "state line" on a payment page in the console draws exactly this machine.

## 6. The saga and its compensation

**Problem:** one payment touches three systems (the payments DB, the ledger, the bank) that cannot share one transaction. What if step 2 succeeds and step 3 cannot?
**Idea:** a **saga**: a sequence of local steps, each idempotent, with a **compensation** for every step that can be undone, and a clear **commit point**.
**Where:** `services/payments/src/saga.service.ts`:
1. `advance()` step 1: `ledger.createHold` with key `hold:<id>`. Insufficient funds (`LedgerRejected`) means nothing was held, so the payment fails.
2. step 2: `resolveGateway()`: `gateway.charge` (idempotent per reference). Declined: `releaseAndFail()` returns the held money **first**, then marks failed ("not failed until the funds are actually released").
3. step 3: `capture()`: the bank said yes, so `ledger.captureHold` with key `capture:<id>` is the **commit point**. If the hold has meanwhile expired (`hold_expired`, `invalid_hold_state`) the bank has the customer's money but we cannot take ours: **compensate** by `gateway.voidCharge`, then fail with `hold_lost_gateway_voided`.
- `run()` takes a short **lease** (`acquireLease`, `lease_until`) so the request path and the recovery job do not work on the same payment at once. (All steps are idempotent anyway; the lease only avoids wasted calls.)
**See it:** the *"unknown outcomes"* group in `services/payments/test/payments.test.ts` (gateway 5xx, lost responses, a ledger that dies between steps, the hold that expires).

## 7. Unknown outcomes and the recovery job

**Problem:** the bank call times out. Did the customer get charged?
**Idea:** you do not know, so you **keep the money held and find out**. A timeout is never a failure.
**Where:** a timeout raises `GatewayUnknown` / `LedgerUnavailable` (`services/payments/src/clients/*.ts`); the saga returns the payment still in `processing` ("UNKNOWN: a retry with the same key is safe"). `RecoveryService.runOnce()` in `recovery.service.ts` picks up payments stuck past `RECOVERY_STUCK_AFTER_SECONDS` whose lease is free and calls `saga.run(id, 'recovery')`. In recovery mode `resolveGateway()` **queries the bank first** and believes it. If the bank has never heard of the payment: a young payment is simply charged now (idempotent); an old one (past `RECOVERY_ABANDON_AFTER_SECONDS`) is **cancelled** (a *tombstone* so a late duplicate cannot charge afterwards) and failed. Recovery also finishes stuck refunds and closes idempotency keys whose requester died.
**See it:** in the console's chaos bench or `scripts/seed-demo.mjs` (it makes the bank lose one answer): the payment shows as `processing` with funds on hold, then recovery settles it. The chaos test's `no_stuck_payments` check proves none stay stuck.

## 8. The outbox

**Problem:** after a payment succeeds you must publish an event. If you write the database and *then* call Kafka, a crash between the two loses the event. If you call Kafka first, a crash loses the database write but the event is out. You cannot make a database and a broker commit together.
**Idea:** write the event into an `outbox` **table in the same transaction** as the state change. A separate publisher reads the table and sends to Kafka, marking rows published. Delivery becomes *at-least-once*.
**Where:** `packages/kafka/src/outbox-writer.ts`: `emitEvent(trx, envelope)` (also stamps the correlation id and trace context). `packages/kafka/src/outbox-publisher.ts`: `OutboxPublisher.publishOnce()` in one transaction takes `pg_try_advisory_xact_lock` (**one active publisher per outbox**, because several publishers could send two events of the same payment out of order), reads the oldest unpublished rows ordered by a `seq bigserial` column, sends with `acks=all` and the idempotent producer, and marks them published. A crash after sending but before the commit means the rows are sent again later: duplicates are possible, loss is not.
**See it:** `packages/kafka/test/kafka.test.ts`. In the chaos runs, Kafka was paused nine times; `no_stuck` held, the outbox backlog drained after, and `unpublishedEvents` is one of the "settled" conditions in `chaos/src/run.ts`.

## 9. Idempotent consumers, the inbox, dead letters

**Problem:** at-least-once delivery means the consumer sees duplicates (a rebalance, a crash before the offset commit, a publisher resend).
**Idea:** the consumer records each event id in an **inbox** table *in the same transaction as handling the event*. A duplicate hits the primary key and is skipped, so the handler's effects happen once.
**Where:** `packages/kafka/src/idempotent-consumer.ts`: `startIdempotentConsumer()`. Inside `opts.db.transaction()` it does `INSERT INTO processed_events ... ON CONFLICT DO NOTHING RETURNING`; no row back means "already handled", skip. Otherwise it runs the handler in that transaction. A failing handler is retried **in place with backoff** (blocking its partition keeps per-aggregate order); after `maxAttempts` the message goes to the **dead-letter topic** (`dlqTopicFor`) with the error in headers; poison messages (not JSON, bad schema) are dead-lettered at once; if even the dead-letter publish fails, the offset is *not* committed and the message is redelivered: it is never silently dropped. The webhook service's handler (`services/webhook/src/event-handler.ts`) only *plans deliveries* (rows); the HTTP call happens later in the worker, because an HTTP call cannot be rolled back with a database transaction.

## 10. Retries, exponential backoff and jitter

**Problem:** retry immediately and you hammer a struggling server; retry in lockstep and every client returns at the same instant (a *thundering herd*).
**Idea:** wait longer after each failure (exponential), and randomise the wait (**full jitter**).
**Where:** `packages/common/src/index.ts`: `backoffDelayMs(attempt, {baseMs, maxMs})` = a random value in `[0, min(maxMs, baseMs * 2^attempt)]`; `retry()` (with `shouldRetry` so permanent errors are not retried). Used by the ledger and gateway clients (`services/payments/src/clients`), the Kafka consumer, and webhook delivery scheduling (`WEBHOOK_BACKOFF_BASE_MS`, `_MAX_MS`, `WEBHOOK_MAX_ATTEMPTS`).
**See it:** `packages/common/src/retry.test.ts`; in the console open a webhook delivery that needed retries: the "attempts, to scale" track draws the real gaps.

## 11. The circuit breaker

**Problem:** the bank is down. Every payment waits the full timeout, threads pile up, and your own service falls over.
**Idea:** count failures in a rolling window; when too many, **open** the circuit: calls fail *instantly* for a while. After a pause let one probe through (*half-open*); success closes it.
**Where:** `services/payments/src/clients/gateway.client.ts`: `GatewayClient.buildBreaker()` using `opossum` (`errorThresholdPercentage: 50`, `volumeThreshold: 10`, `rollingCountTimeout: 10s`, `resetTimeout: 5s`). Declines are *normal results* and never trip it; timeouts, 5xx and network errors do. When the circuit is open the saga treats it as **unknown** (not failed) and `retry` does not retry into an open circuit (`shouldRetry`). State is exposed as a metric (`breakerState`), shown on the Metrics page.
**See it:** the *"circuit breaker"* group in `services/payments/test/payments.test.ts`.

## 12. Webhooks you can trust

**Problem:** tell the merchant a payment succeeded, even though their server may be down, slow, or an attacker's.
**Idea:** sign every delivery so the merchant can verify it came from you; retry with backoff; dead-letter when hopeless; let a human replay.
**Where:**
- **Signing:** `packages/webhooks/src/index.ts`: `signPayload` (HMAC-SHA256 over `timestamp.body`), `buildSignatureHeader` (`t=<ts>,v1=<hex>`, **several signatures** during a secret rotation overlap), `verifySignature` (constant-time compare, **±5 minute tolerance** against replay). Secrets are encrypted at rest with AES-256-GCM (`encryptSecret`/`decryptSecret`).
- **Exactly one delivery per (event, endpoint):** `UNIQUE (event_id, endpoint_id)` on `webhook_deliveries`; `DeliveriesService.enqueueForEvent` is safe to run twice.
- **Claiming work:** `DeliveriesService.claimDue` uses `FOR UPDATE SKIP LOCKED` with a lease, so several replicas share the queue without double-sending and a crashed worker's claim simply expires.
- **Attempts:** `attempt()`, a delivery log per HTTP attempt (`webhook_attempts`), `dead` after the limit, `replay()` to resurrect.
- **SSRF guard:** `services/webhook/src/url-guard.ts`: `assertSafeUrl` resolves the host and refuses private, loopback and link-local addresses (`isPrivateAddress`), so a merchant cannot point the server at your internal network.
**Honest note:** a merchant can still receive the same event twice (a crash after their 200 but before we record it). That is why every webhook carries a stable `id` and the demo shop deduplicates on it.

## 13. Reconciliation

**Problem:** every guarantee above could still be violated by a bug you have not thought of. How would you know?
**Idea:** continuously compare independent records of the same facts and flag differences. **Internal:** the ledger's own invariants, plus payments against ledger transactions. **External:** your payments against the *bank's* settlement file.
**Where:** `services/reconciliation/src`: pure comparison functions (easy to test): `checks/internal.ts` (`invariantsToMismatches`), `checks/payments-ledger.ts` (`comparePaymentsToLedger`: every settled payment has exactly its ledger transaction moving exactly the right amounts; a failed payment has **none**; no orphan captures), `checks/external.ts` (`compareToSettlement`). `reconciler.service.ts`: `Reconciler.run()` holds a **session advisory lock** per kind (one run at a time across replicas), applies a **grace period** (young payments are not judged), and **confirms** a mismatch after a short delay before reporting it (it may just be in flight). Paging uses keyset cursors with exact microsecond text timestamps (a bug the tests found: float-rounded cursors looped forever). Mismatches are flagged, **never auto-fixed**.
**See it:** the Reconciliation page in the console; `services/reconciliation/test/*`.

## 14. Locking and deadlock avoidance

**Problem:** transfer A→B and B→A at the same time: each locks its first account and waits for the other's.
**Idea:** a deadlock needs a cycle; if **every** transaction takes its locks in the **same global order**, no cycle can form.
**Where:** `lockBalances()` in `services/ledger/src/posting.ts` sorts account ids and uses `ORDER BY ... FOR UPDATE`. Code that also locks a hold row always locks the **hold first, then balances**, so that order is global too. As a last resort `inTransaction()` retries on Postgres `40P01` (deadlock) and `40001` (serialisation failure), up to 3 attempts.
**A deadlock the database cannot see (a real bug the chaos test found):** `captureHold` once asked the *connection pool* for the database clock while already holding a pooled connection inside its transaction. With more concurrent captures than pool connections, every connection was held by a transaction waiting for another one: nobody was waiting on a *lock*, so Postgres reported nothing, and both ledger pods stopped answering. Fix: pass the transaction (`dbNow(trx)`), never borrow a second connection mid-transaction; plus a connection-wait timeout and `idle_in_transaction_session_timeout` in `packages/db/src/index.ts`. Regression test: `services/ledger/test/concurrency.test.ts`, *"many concurrent captures through a tiny pool"* (it hangs without the fix).
**See it:** `services/ledger/test/concurrency.test.ts`, *"100 parallel transfers in both directions on the same 5 accounts: no deadlock, money conserved"*.

## 15. Why exactly-once is impossible (and what we do instead)

Two services, one message. The sender sends and waits for an acknowledgement. If no acknowledgement arrives, the sender cannot know whether (a) the message was lost, or (b) the message was processed and the *acknowledgement* was lost. If it resends, case (b) delivers twice; if it does not, case (a) delivers never. No protocol over an unreliable network can fix this (it is the *Two Generals* problem). So real systems offer **at-most-once** (never resend: you can lose) or **at-least-once** (resend: you can duplicate). Zerodrift picks at-least-once everywhere and makes the *receiver* idempotent, which produces the **effect** of exactly-once:

| Boundary | Duplicates possible? | What absorbs them |
|---|---|---|
| client → payments API | yes (retries) | idempotency key + request hash |
| payments → ledger | yes (retries after timeouts) | deterministic keys `hold:<id>`, `capture:<id>` |
| payments → bank | yes | the bank's idempotency per reference |
| outbox → Kafka | yes (publish, crash before commit) | consumer inbox on `eventId` |
| Kafka → consumer | yes (rebalance, offset commit) | inbox in the same transaction as the handler |
| webhook → merchant | yes | stable event id the merchant deduplicates on |

The one place "effectively once" must be *proven* rather than argued is the chaos test.

## 16. How the chaos test is designed

**Goal:** show money stays right while the system is being broken, with evidence you cannot argue with.
**Where:** `chaos/` and `docs/CHAOS_RESULTS.md`.
- **Realistic load** (`chaos/k6/load.js`): 75% payments through the payments API, 25% transfers through the ledger, ~10% of operations are **duplicates sent twice at the same moment**, and clients **retry with the same key** on timeouts and 5xx, like real ones.
- **Overlapping faults** (`chaos/src/injector.ts`): random pod kills (grace period 0: a crash), bank fault windows (latency, errors, lost responses, duplicate and dropped callbacks), Kafka paused, network latency, dropped connections and partitions (Toxiproxy). Kills during a bank outage are the interesting case, so faults run concurrently.
- **An independent checker** (`chaos/src/invariants.ts`): plain SQL over the four databases, **no service code**, so a bug cannot hide by also being in the checker. The expected total money comes from the **seed** (what was topped up), not from the ledger it is checking. Nine invariants: money conserved, every transaction balanced, balances equal the journal, nothing stuck in holds, no duplicate charge, nothing stuck in flight, webhooks delivered once, and both reconciliations clean.
- **The checker is tested** (`chaos/test/invariants.test.ts`): it corrupts a *real* database (real migrations, triggers disabled to fabricate what the triggers normally forbid) in a dozen ways and proves each check fails. A checker that cannot fail proves nothing.
- **Recovery window, then check:** all faults are removed, the harness waits until nothing is in flight, no events are unpublished, and every succeeded payment's event was consumed, then runs reconciliation and the checker.
- **Many runs, plus a control:** six chaos runs and one no-fault baseline, so "throughput" is not blamed on faults that did not cause it.
- **Honest reporting:** numbers are laptop numbers; the odd 759 s recovery is reported as unexplained; the two bugs it found are written up with cause, fix and test (`docs/CHAOS_RESULTS.md`).

## 17. Smaller pieces worth reading

- **Observability:** `packages/common` (`requestMiddleware`: correlation id in `AsyncLocalStorage`, route *pattern* only in logs, never raw URLs or secrets), `packages/telemetry` (OpenTelemetry; the trace continues across Kafka because the event envelope carries `traceparent`), Prometheus metrics, `scripts/gen-dashboards.mjs` (Grafana dashboard as code).
- **Rate limiting:** `services/payments/src/rate-limiter.ts`: a per-merchant token bucket in one Redis Lua script; it **fails open** if Redis is down (availability over throttling) and logs it.
- **Security:** `docs/SECURITY.md`; `refuseDevSecrets` in `packages/config/src/index.ts` (production refuses development secrets and names the variable); hashed API keys; audit log with an append-only trigger; SSRF guard; strict CSP and headers in `packages/common`.
- **The chaos controller** (`services/chaos-controller/src`): an API that can kill things, so it returns 404 unless enabled, refuses to start in production, only touches a whitelist, and has a Kubernetes backend (`kubernetes.ts`) and a Docker one (`docker.ts`).
- **The console:** `packages/ui` (tokens in `theme.css`; components whose animations are driven by real data: the drift needle by real drift, the journal's BALANCED stamp by the real entries), `apps/dashboard`, `design/`.

## A payment, traced through the code

`POST /v1/payments` → `PaymentsController.createPayment` → `PaymentsService.create` (`payments.service.ts`): rate limit (Redis) → resolve the customer's wallet (`ledger.wallet`) → **one transaction**: `IdempotencyService.begin` (claim the key), insert the payment, `payment_events` row, outbox event `payment.created`, audit row → commit → `SagaService.run(id, 'request')`: lease → `created→processing` → `ledger.createHold` → `gateway.charge` → `ledger.captureHold` (→ `post` → `lockBalances` → entries → deferred balance trigger at commit) → `transition(succeeded)` (+ outbox `payment.succeeded`) → `IdempotencyService.complete` stores the response → `201`. Meanwhile `OutboxPublisher` sends the events, the webhook service's consumer plans a delivery, and `DeliveryWorker` signs and posts it. If anything in the middle dies, `RecoveryService` picks the payment up and finishes it exactly once.

## Exercises (do these; they teach more than reading)

1. In `post()` comment out the `ON CONFLICT` claim and run the 20-concurrent-duplicates test. Watch it fail. Restore it.
2. Change `lockBalances` to *not* sort the ids and run the 100-parallel-transfers test. Count the deadlocks and the retries.
3. In `PaymentsRepo.transition` drop `.where('status', '=', p.status)`; run the payment tests and the chaos checker's `no_duplicate_charges`.
4. Make the gateway client treat a timeout as a failure (release the hold and fail). Run the lost-response test. This is exactly the bug the "timeouts are unknown" rule exists to prevent.
5. Disable `KAFKA_LOG_DIRS` in `deploy/helm/zerodrift-infra/templates/kafka.yaml`, run `pnpm chaos` and read which invariant fails (`webhooks_exactly_once`).
6. Write a new invariant in `chaos/src/invariants.ts` (for example: "no merchant balance is negative"), add the test that corrupts a database to prove it fails, and run it.
