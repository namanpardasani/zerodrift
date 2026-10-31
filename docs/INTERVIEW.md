# Interview guide

Fifty questions, easy to hard, with answers based on how **this** code works (file names in brackets so you can open the code and check yourself). Then a 2-minute pitch, a 10-minute deep-dive outline, and resume bullets that use **only measured numbers**.

Rules for using it: say what the system *does*, not what it "should" do; volunteer the limitations (they impress more than hiding them); if you do not know, say how you would find out.

## Part 1: Fundamentals (1 to 12)

**1. What is Zerodrift in one sentence?**
A payments and wallet backend, a mini Razorpay: a double-entry ledger, an idempotent payments API, Kafka-driven signed webhooks and a reconciliation engine, plus a chaos harness that proves money stays correct when pods crash, networks fail and requests repeat. The bank is a mock; nothing moves real money.

**2. Why do you store money as integers?**
Floating point cannot represent most decimals exactly (`0.1 + 0.2 !== 0.3`), and a ledger that is off by a paisa is wrong. I store paise in a `BIGINT` column and a JavaScript `bigint`; amounts travel as strings over HTTP because JSON numbers lose precision above 2^53. Fees use basis points with half-up rounding in integer arithmetic (`feeFor` in `packages/money`), and a partial refund returns a proportional share of the fee but never more than was charged.

**3. What is double-entry bookkeeping and why did you use it?**
Every movement of money is a transaction of entries, some debits and some credits, where total debits equal total credits. A balance is credits minus debits, so the sum of all balances is always zero: money is only ever *moved*, never created or destroyed. That makes errors detectable: any bug that leaks money breaks an equation I can check. The outside world is an account too (`gateway_clearing`, allowed negative); a top-up debits it and credits the wallet.

**4. What is the difference between a hold and a capture?**
A hold reserves money: it moves from `available` to `held` on the same wallet, so it cannot be spent twice but has not left the customer. A capture pays it out of `held` to the merchant and the fee account in one atomic ledger transaction. A release or expiry returns it to available. I hold first because I do not know yet whether the bank will accept the charge. [`holds.service.ts`]

**5. What is an idempotency key?**
A unique token the client sends with a money-moving request. The server stores the result under that key together with a hash of the request. Same key and same request returns the stored result without redoing anything; same key and a *different* request is rejected with HTTP 422. It makes a retry after a timeout safe. [`posting.ts`, `idempotency.service.ts`]

**6. What does your API return if the same key arrives with a different body?**
422 (`idempotencyMismatch`), because that is a client bug (reusing a key for a different payment). Returning the old result would hide it; executing it would risk a wrong charge.

**7. Why does each service have its own database?**
So a service owns its data and nothing else reads its tables; they integrate through APIs and events. It also means the ledger's guarantees (triggers, constraints) cannot be bypassed by another service writing to its tables. The cost is that there is no cross-service transaction, which is why I need sagas, an outbox and reconciliation.

**8. What is the transactional outbox, in one paragraph?**
You cannot commit a database and publish to Kafka atomically. So the service writes the event into an `outbox` table in the *same* database transaction as the state change. A separate publisher reads that table and sends to Kafka, marking rows published. A crash can cause a resend (a duplicate) but never a loss. [`outbox-writer.ts`, `outbox-publisher.ts`]

**9. How does a merchant verify a webhook?**
Each delivery carries `zerodrift-signature: t=<timestamp>,v1=<hmac>` where the HMAC-SHA256 is over `timestamp.body` with the endpoint's secret. The merchant recomputes it with a constant-time compare and rejects timestamps outside ±5 minutes (replay protection). During a secret rotation the header carries two signatures so either secret verifies. [`packages/webhooks`]

**10. What do you mean by "a timeout is an unknown outcome, not a failure"?**
If the bank call times out I do not know whether it charged the customer. Treating it as a failure could release the hold and leave the customer charged; treating it as a success could capture money the bank never took. So the payment stays `processing`, the funds stay *held*, and the recovery job later **queries** the bank and decides. [`saga.service.ts`, `recovery.service.ts`]

**11. What are the services and what does each own?**
`ledger` (the books), `payments` (merchant API, saga, recovery, refunds), `webhook` (signed, retried deliveries), `reconciliation` (compares books, payments and the bank), `mock-gateway` (the demo bank), `dashboard-api` (landing page and console backend), `demo-shop`, and a test-only `chaos-controller`. Plus Postgres (one database each), Kafka, Redis.

**12. How do you run and test it?**
`docker compose up -d --build` runs everything; `pnpm test` runs 361 tests against real Postgres, Kafka and Redis via Testcontainers; `pnpm chaos` creates a local Kubernetes cluster and runs the 10,000-operation chaos test; `pnpm e2e:smoke` drives a real browser through every page and a checkout.

## Part 2: How it works (13 to 32)

**13. How do you stop two concurrent duplicate requests from both executing?**
The idempotency key is claimed with `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` inside the same transaction as the work. If another transaction already inserted that key, Postgres *blocks* my insert until the other one commits or rolls back; then I read the winner's stored response and return it. Uniqueness is enforced by the database, not by an `if` two requests could both pass. At the payments level the key is claimed in the same transaction that creates the payment. [`post()`, `IdempotencyService.begin`]

**14. Why check that a transaction balances in code *and* with a database trigger?**
Defence in depth. The code check (`validateEntries`) gives a clear error early; the **deferred constraint trigger** (`assert_transaction_balanced`, `DEFERRABLE INITIALLY DEFERRED`) fires at `COMMIT`, after all entries are inserted, so even a buggy code path or a direct SQL insert cannot commit an unbalanced transaction. Deferred, because mid-transaction the entries are legitimately unbalanced one row at a time.

**15. How do you prevent a wallet going negative under concurrency?**
`lockBalances` takes `SELECT ... FOR UPDATE` row locks on the balances involved, so two spends of the same wallet serialise; then the new balance is checked before the update. A trigger (`enforce_non_negative_balance`) rejects the update anyway unless the account has `allow_negative`. So even if the code were wrong, the database says no.

**16. How do you avoid deadlocks?**
A deadlock needs a cycle of lock waits. If every transaction takes its locks in the same global order, no cycle can form. `lockBalances` sorts account ids and uses `ORDER BY ... FOR UPDATE`; code that also locks a hold always locks the hold first, then balances. As a last resort `inTransaction` retries on Postgres `40P01` (deadlock) and `40001`. There is a test with 100 parallel transfers in both directions across the same five accounts.

**17. Walk me through the payment saga and its compensation.**
`created → processing`, then: (1) create a **hold** with key `hold:<id>`; (2) **charge the bank** (idempotent per reference = payment id); (3) on success, **capture** the hold to the merchant with key `capture:<id>`, the commit point; then `succeeded`. Compensations: if the bank declines, release the hold *first*, then mark failed; if the capture fails because the hold expired after the bank charged, **void the bank charge** and fail. Every step is idempotent and the whole thing is driven by a status field, so any step can be repeated after a crash. [`saga.service.ts`]

**18. A payments pod is killed after the bank charged but before the capture. What happens?**
The payment is `processing` with a hold and a lease that expires in 20 s. The recovery job (any replica) picks it up after 30 s of inactivity and runs the saga in *recovery mode*: it **queries the bank**, which says `succeeded`, then captures with key `capture:<id>` (idempotent), then marks it `succeeded`. The customer is charged once because the bank is idempotent per reference and the ledger per key.

**19. How does recovery decide for a payment the bank has never heard of?**
If it is young, charge now (idempotent). If it is older than the abandon threshold (300 s by default), **cancel** at the bank, which writes a *tombstone* so a late duplicate request cannot charge afterwards, release the hold, and fail the payment. Querying first matters: it stops recovery from charging a customer the bank already charged.

**20. Why a state machine, and why compare-and-set?**
So a payment can never move backwards or sideways (a failed payment must not become succeeded). `TRANSITIONS` lists the legal moves; `PaymentsRepo.transition` runs `UPDATE ... WHERE id = $id AND status = $whatIJustSaw`. If the recovery job and the request path race, exactly one UPDATE matches and the loser reads the winner's result instead of overwriting it.

**21. Then why do you also have a lease?**
The compare-and-set already guarantees *correctness*; the lease (`lease_until`, 20 s) only avoids *wasted work*: two workers both calling the bank for the same payment. All steps are idempotent anyway. A lease is an optimisation; the CAS and the keys are the safety.

**22. Why not a distributed transaction (two-phase commit) across ledger, payments and the bank?**
The bank is an external system that does not take part in my transactions, 2PC blocks if the coordinator dies, and it couples availability of every participant. A saga with idempotent steps, compensations and a recovery job gives eventual consistency without distributed locks, and reconciliation checks the result.

**23. Can you do exactly-once delivery? Why not?**
No. If a sender gets no acknowledgement it cannot tell whether the message was lost or the acknowledgement was lost; resending risks a duplicate, not resending risks a loss (the Two Generals problem). So I use **at-least-once delivery with idempotent receivers**, which has the *effect* of exactly-once: idempotency keys on the API and the ledger, deterministic keys inside the saga, an inbox on Kafka consumers, a stable event id on webhooks. [`docs/LEARN.md` section 15]

**24. How does the Kafka consumer avoid processing an event twice?**
It inserts the event id into a `processed_events` inbox table *in the same transaction* as the handler's effects, with `ON CONFLICT DO NOTHING RETURNING`. No row back means "already handled", so skip. A crash before the commit rolls back both the inbox row and the effects, so the redelivery is handled fresh. A failing handler is retried with backoff, then dead-lettered. [`idempotent-consumer.ts`]

**25. Why only one outbox publisher at a time?**
Several concurrent publishers (for example with `FOR UPDATE SKIP LOCKED`) could send two events of the *same* payment out of order. I take `pg_try_advisory_xact_lock` per outbox so one publisher is active, read rows by a `seq bigserial` column, and key messages by aggregate id so one aggregate's events stay in order within a partition. The cost is publisher throughput; a sharded publisher would be the next step.

**26. How do retries work, and why jitter?**
`backoffDelayMs` returns a random delay in `[0, min(max, base * 2^attempt)]` (full jitter). Exponential growth stops hammering a struggling server; the randomness stops every client retrying at the same instant (a thundering herd). `retry()` also takes `shouldRetry` so permanent errors are not retried. Webhook delivery uses it with base 15 s and cap 1 hour, 8 attempts. [`packages/common`]

**27. How does the circuit breaker work here, and why don't declines trip it?**
`opossum` counts timeouts, 5xx and network errors in a 10 s rolling window; at 50% failures over at least 10 calls it **opens** and calls fail instantly for 5 s, then one probe (half-open). A decline is a *normal* business answer (HTTP 200, status `failed`), so it never counts. An open circuit is treated as *unknown* (not failed), and `retry` does not retry into it. [`gateway.client.ts`]

**28. How do webhook retries and dead letters work?**
One delivery row per (event, endpoint) (a unique constraint). Workers claim due rows with `FOR UPDATE SKIP LOCKED` and a lease, send a signed POST, and log each attempt. Failures reschedule with exponential backoff and jitter; after the maximum attempts the delivery is `dead` and shown in the console; an operator can **replay** it. A merchant can still get the same event twice (a crash after their 200), so every webhook has a stable id they must deduplicate on.

**29. What is an SSRF guard and why is it needed?**
Merchants give you a URL and your server calls it. An attacker could give `http://169.254.169.254/` (cloud metadata) or an internal address. `assertSafeUrl` resolves the hostname and refuses private, loopback and link-local addresses, so the webhook service cannot be used to reach your internal network. [`url-guard.ts`]

**30. How does rate limiting work and why does it fail open?**
A per-merchant token bucket in a single Redis Lua script (atomic), plus a throttle on repeated failed authentication per address. If Redis is down it **fails open** and logs: for a payments API, refusing all traffic because the *limiter* is down would be a worse outage than briefly not limiting. Failing closed would be right for a security control with no safe default; the choice is deliberate and documented.

**31. How do refunds work?**
A refund reserves the amount under a row lock on the payment (so concurrent refunds cannot exceed the payment), then executes as a ledger posting that credits the customer back and takes the merchant's net and the *proportional* fee share. Journal entries are never edited: it is a new transaction, and a reversal of a transaction is unique (`UNIQUE(reverses_transaction_id)`). The refund has its own idempotency key and recovery finishes stuck refunds.

**32. What does reconciliation do and why have it?**
It compares independent records of the same facts. Internal: the ledger's invariants plus "every settled payment has its ledger transaction with the right amounts, a failed payment has none, no orphan captures". External: our payments against the bank's settlement file. Every guarantee above could still be violated by a bug I did not anticipate; reconciliation is how I would find out in production. It flags and never auto-fixes, uses a grace period for in-flight payments, and holds an advisory lock so one run per kind happens at a time.

## Part 3: Chaos, bugs and honesty (33 to 42)

**33. Tell me about the bug where your ledger froze.**
In the first chaos run both ledger pods stopped answering readiness probes. Postgres showed 27 sessions "idle in transaction" and others waiting on locks. Cause: `captureHold` asked the *connection pool* for the database clock while already holding a pooled connection inside its transaction. With more concurrent captures than pool connections, every connection was held by a transaction waiting for another connection: a deadlock **the database cannot see**, because nobody waited on a lock. Fix: pass the transaction (`dbNow(trx)`), never borrow a second connection mid-transaction; plus a 10 s connection-wait timeout and `idle_in_transaction_session_timeout`. I added a regression test that hangs without the fix (30 concurrent captures through a 3-connection pool).

**34. And the Kafka bug?**
After a run, 439 succeeded payments had no webhook event while consumer lag was zero. The outbox said 6,418 events were published but the topic held 4,378. Cause: the Kafka image's data directory defaults to `/tmp/kafka-logs`, not the mounted volume, so every restart (my chaos test pauses Kafka) wiped all topics. It is a deployment bug a unit test cannot see; the webhook invariant found it. Fix: `KAFKA_LOG_DIRS` on the volume (and `fsGroup` in Kubernetes). Afterwards 168 events survived a restart in the production Compose stack.

**35. How do you avoid fooling yourself with a chaos test?**
Four things. The checker is **independent**: plain SQL over the four databases, no service code, so a bug cannot hide by also being in the checker. The expected total money comes from the **seed** (what I topped up), not from the ledger being checked. The checker is itself **tested**: it corrupts a real database in a dozen ways and each corruption must be detected. And there is a **baseline run without faults** so I do not blame (or credit) faults for throughput. I also ran it six times, because one pass is luck.

**36. Which invariants do you check, and why those?**
Nine: money conserved exactly (held by accounts equals topped up, clearing equals minus that, global sum zero); every transaction balanced; stored balances equal the journal; no money stuck in holds; no duplicate charge (at most one capture and one bank charge per payment, none for a failed payment); no payment stuck in flight; every succeeded payment's webhook delivered or dead-lettered once per endpoint; and both reconciliations clean. They map one-to-one to the money rules and to the failure modes I injected.

**37. What are the actual results?**
Six chaos runs of 10,000 operations (60,000), 167 faults (101 pod kills, 26 bank fault windows, 11 partitions, 10 latency windows, 10 dropped-connection windows, 9 Kafka pauses), 6,041 duplicate request pairs, 8,360 client retries, 1,423 operations where the client gave up without knowing the outcome. All 54 invariant evaluations passed. Throughput was 42.6 to 52.2 operations per second with chaos and 46.7 without, on one shared laptop node. [`docs/CHAOS_RESULTS.md`]

**38. Those throughput numbers are low. Why?**
They are a saturated laptop: 200 virtual users against a single 8-CPU, 8 GB node that also runs Docker Desktop, with payment p50 around 4.5 s and p99 of 11 to 14 s. The no-fault baseline gives the same throughput, so the limit is the machine, not the faults or the design. I do not claim the numbers say anything about scale; I claim the invariants held under that stress.

**39. What did your chaos test not cover?**
Node failure (one Kubernetes node), Postgres failover (one instance), Kafka broker loss (one broker, replication factor 1), disk corruption, clock jumps, and a real bank's behaviours. One run also took 759 s to settle because webhook consumption stalled; I could not explain or reproduce it, so it is reported as unexplained and I added consumer-lag sampling to diagnose a recurrence.

**40. Why does the harness kill pods with grace period zero?**
To simulate a crash, not a polite shutdown. A graceful stop lets the service finish requests; real failures do not. Faults also overlap (a pod kill during a bank outage) because failures cluster in real life.

**41. Where could money still be lost or created?**
Outside the ledger's guarantees: a database superuser editing rows or schema; losing the Postgres volume with no backup; the bank and my settlement disagreeing (that is what external reconciliation flags); an application bug that posts the *wrong but balanced* entries (balanced does not mean correct, which is why reconciliation also checks payments against ledger amounts). The invariants prove conservation and consistency, not business correctness.

**42. How would you know in production that something is wrong?**
Scheduled reconciliation runs (internal every 5 minutes, external every 15 by default) with findings in the console, the ledger invariant endpoint, metrics (stuck-payment count, outbox backlog, circuit state, consumer lag, dead letters), correlation ids across logs and OpenTelemetry traces across Kafka, and an append-only audit log.

## Part 4: Design, scale, trade-offs (43 to 50)

**43. What is the scaling bottleneck?**
Hot accounts. Every payment to a merchant locks that merchant's balance row (`FOR UPDATE`), so one very busy merchant serialises its captures. Mitigations: split a merchant's wallet into several sub-accounts and spread credits across them, or batch credits, accepting a more complex read model. The platform fee account is another hot row. Reads scale easily (replicas); the write path per account is serial by design, which is what makes balances correct.

**44. How would you scale the ledger horizontally?**
Shard by account (consistent hash on account id) with each shard its own Postgres; a transaction touching two shards then needs a cross-shard protocol (a saga with a pending/transit account) instead of one local transaction. I would keep most transfers intra-shard by co-locating a customer's and a merchant's accounts where possible. It is a large step and I would not take it before measuring.

**45. How would you add a second currency?**
`currency` is already a column everywhere and entries have a composite foreign key `(account_id, currency)`, and `post` rejects mixed-currency transactions. FX would be two balanced transactions (one per currency) through an FX-clearing account in each currency, plus a rate source and rounding policy. Not needed for the demo.

**46. How would you replace the mock bank with a real gateway?**
Write an adapter with the same interface (`charge`, `query`, `cancel`/`void`) keyed by our payment id as the gateway's idempotency/reference, map its statuses to charged/declined/unknown, verify its webhook signatures, and replace the settlement-file reader behind external reconciliation. The saga, recovery and reconciliation logic would not change. New work: PCI scope (use hosted fields, never touch card data), chargebacks and disputes as new ledger flows, and settlement delays.

**47. How do you handle clock skew?**
Anything that decides expiry (hold TTL) uses the **database** clock (`dbNow`), not an application server's, so replicas with different clocks agree. Webhook signature tolerance uses a ±5 minute window, so small skew between us and a merchant is fine.

**48. Describe the security model.**
Merchant API keys are 256-bit random, shown once and stored only as SHA-256 hashes; each merchant sees only its own data (404, never 403, for others' ids). Operators use a JWT (HS256 pinned, expiry, audience and issuer checked) with a login throttle. Webhook secrets are AES-256-GCM encrypted at rest. The SSRF guard protects outbound calls. Production refuses development secrets at start-up and names the variable. The audit log is append-only by trigger. The chaos controller returns 404 unless enabled and refuses to start in production. Strict CSP and headers, non-root read-only containers. The threat model and accepted risks are in `docs/SECURITY.md`.

**49. What would you do with another month?**
Make the proof stronger and the platform less single-node: Postgres with automatic failover and point-in-time recovery, Kafka with replication factor 3, **chaos tests that kill a whole node**, a real gateway adapter, a hot-account mitigation measured with a dedicated load test, SASL/TLS for managed Kafka, and an automated backup-restore drill. Then explain the unexplained 759 s webhook stall.

**50. What are you proudest of, and what would you do differently?**
Proudest: the checker is independent and tested, so the claim "all invariants held" actually means something, and it found two bugs no unit test would have. Differently: I would have run the chaos harness much earlier, as soon as the first two services existed, because the connection-pool deadlock would have shown up in week one instead of week three; and I would have put the Kafka volume check in the Helm chart's own verification from the start.

---

## 2-minute pitch (about 290 words)

"I built Zerodrift: a mini Razorpay, a payments and wallet backend that moves money correctly even when services crash, networks fail and requests repeat.

At the core is a double-entry ledger in Postgres. Every movement is a set of balanced entries that can never be edited, enforced by the code and by database triggers, so money can't be created or destroyed. Payments run as a saga: hold the customer's money, ask the bank, then capture or release. Every step has an idempotency key, and a timeout is treated as an *unknown* outcome, not a failure: the money stays held and a recovery job asks the bank what really happened. Events go through a transactional outbox into Kafka, consumers use an inbox so duplicates are harmless, and merchants get signed webhooks with backoff, dead letters and replay. A reconciliation engine compares the books, the payments and the bank's settlement file.

But the part I'm proudest of is the proof. I wrote a chaos harness that runs on Kubernetes: ten thousand payments and transfers per run, about ten percent of them duplicate requests, while it kills payments, ledger and webhook pods, pauses Kafka, makes the bank slow and lossy, and drops the network. Afterwards an independent SQL checker, which uses none of the service code and has its own tests that corrupt a database to prove it can fail, asks nine questions: is the money conserved to the paisa, is every transaction balanced, any duplicate charge, anything stuck, every webhook delivered once.

Across six runs, sixty thousand operations and a hundred and sixty-seven injected faults, every invariant held. It also found two real bugs: a connection-pool deadlock that froze the ledger, and Kafka silently losing its data on restart. Both are fixed, with tests, and written up honestly, including what I didn't test: it was one node, so node failure is still open."

## 10-minute deep-dive outline

| Minutes | Topic | Show |
|---|---|---|
| 0:00 to 1:00 | The problem and the one rule: timeouts are unknown | README architecture diagram; the payment sequence diagram |
| 1:00 to 3:00 | The ledger: integers, double entry, three layers of protection, idempotent `post()` | `posting.ts` (`post`, `lockBalances`), the triggers in migration 0001; a payment's journal and BALANCED stamp in the console |
| 3:00 to 5:00 | The saga: hold, charge, capture; compensation; recovery that queries first | `saga.service.ts`, `recovery.service.ts`; the lost-bank-response payment in the console |
| 5:00 to 6:30 | Events: outbox, publisher lock, inbox, why exactly-once is impossible | `outbox-publisher.ts`, `idempotent-consumer.ts`; LEARN section 15 |
| 6:30 to 8:30 | The proof: how the chaos test is built, why the checker is independent and tested | `chaos/src/invariants.ts` and its test; run `pnpm chaos` or show the table; the chaos bench |
| 8:30 to 9:30 | The two bugs (pool deadlock, Kafka volume): how found, why subtle, how fixed and guarded | `docs/CHAOS_RESULTS.md`; the regression test |
| 9:30 to 10:00 | Limits and next steps (one node, mock bank, hot accounts) | README limitations |

Likely follow-ups to prepare: hot accounts and sharding (Q43, Q44), real gateway (Q46), "how do you know the checker is right" (Q35), and "what if the bank answers wrongly" (Q41).

## Resume bullets (measured numbers only)

Pick three or four; every figure below is in `docs/CHAOS_RESULTS.md` or measured from the repository.

- Built **Zerodrift**, a payments backend in TypeScript (NestJS, Postgres, Kafka, Redis, Kubernetes): a double-entry ledger with immutable journals and database-enforced balance and no-overdraft triggers, an idempotent payments API, a saga with crash recovery, a transactional outbox into Kafka, signed retried webhooks, and reconciliation.
- Designed a **chaos harness** (k6 + Kubernetes + an independent SQL invariant checker with its own mutation tests) that ran **60,000 payments and transfers** across 6 runs with **167 injected faults** (101 pod kills, Kafka pauses, bank faults, network partitions) and **6,041 duplicate requests**; **all 54 invariant evaluations passed** (money conserved to the paisa, no duplicate charges, no stuck payments, every webhook delivered once).
- The chaos test found and led me to fix **two production-class bugs**: a connection-pool deadlock that froze the ledger under concurrent captures (regression test added) and Kafka losing all topics on restart because its data directory was not on the volume.
- Engineered idempotency end to end (database-enforced keys, deterministic saga keys, consumer inbox) so retries and concurrent duplicates never double-charge, and treated timeouts as unknown outcomes resolved by querying the bank.
- Shipped with **361 automated tests** (real Postgres/Kafka/Redis via Testcontainers), about **14,500 lines of source** and 5,800 of tests, a React operator console, containerised browser tests, and production deployment files verified by CI (Helm chart refuses to render the chaos tool in production).

Do **not** add: throughput claims beyond "42.6 to 52.2 operations/s on a single shared laptop node" (and only with that caveat), latency claims, or "exactly-once". They are not measured claims you can defend.
