# What happens when things fail

For every component: what it looks like, what protects the money, how the system recovers, and **what is not promised**. "Evidence" points at the test or chaos result that exercises it. Defaults come from [`docs/ENVIRONMENT.md`](ENVIRONMENT.md) (hold TTL 30 min, recovery looks every 10 s at payments stuck for 30 s and abandons after 300 s, bank timeout 1.5 s, webhook retries 8 times with backoff from 15 s to 1 h).

The golden rule behind every row: **a timeout is an unknown outcome, not a failure.** The payment stays `processing`, the customer's money stays *held* (not spent, not released), and recovery asks the other side before deciding.

## Quick map

| If this fails or is slow... | Money safe? | Customer sees | Recovers by itself? |
|---|---|---|---|
| a payments pod dies mid-payment | yes | a retry with the same key gets the right answer | yes: another replica's recovery job finishes it |
| the ledger dies or is slow | yes | 503 (nothing created) or 202 `processing` | yes, when it returns |
| the bank is down, slow, or loses the answer | yes | 202 `processing` | yes: recovery *queries* the bank |
| Kafka is down or paused | yes | payments work; webhooks are late | yes: the outbox drains in order |
| a webhook pod dies or the consumer stalls | yes | webhooks late | yes |
| the merchant's server is down | yes | the merchant is told late, or sees a dead letter | retries, then manual replay |
| Postgres is down | yes (nothing partial is committed) | 5xx, not-ready pods | yes, when it returns |
| Redis is down | yes | no rate limiting | yes (fails open) |
| the network between services drops or lags | yes | as for the dependency behind it | yes |
| a whole node, a disk, or a region is lost | **not covered** | | no (see "Not covered") |

## Per component

### ledger (the books)

| Failure | What happens | Why the money is safe | Evidence |
|---|---|---|---|
| Pod killed in the middle of a request | The request's transaction either committed or rolled back entirely (Postgres). The caller got no answer, retries with the same key, and gets the stored result (committed) or runs it fresh (rolled back). | one database transaction per ledger operation; idempotency key claimed inside it (`post`) | 31 ledger pod kills across the six chaos runs (2 to 8 per run); `money_conserved`, `transactions_balanced` held |
| All replicas down | Payments' ledger client raises `LedgerUnavailable`. A new payment fails fast with 503 *before anything is created*. A payment already in flight stays `processing`. | the saga treats it as unknown and retries with the same deterministic keys | `services/payments/test/payments.test.ts` (ledger down between steps) |
| Slow ledger (latency) | The call times out; same as "unknown". | same | Toxiproxy latency and drop windows in the chaos runs |
| Connection pool exhausted | Waiting for a connection fails after 10 s instead of hanging forever; Postgres kills sessions idle in a transaction after 60 s. | A real bug found by chaos: a nested connection request inside a transaction deadlocked the pool. Fixed; regression test hangs without the fix. | `services/ledger/test/concurrency.test.ts`; `docs/CHAOS_RESULTS.md` bug 1 |
| Two requests lock the same accounts in opposite order | Cannot deadlock: locks are always taken in sorted account-id order; a residual deadlock is retried (`40P01`). | `lockBalances` | "100 parallel transfers in both directions" test |

### payments (API, saga, recovery)

| Failure | What happens | Recovery |
|---|---|---|
| Pod dies after the hold, before the bank call | Payment is `processing`, hold exists, lease expires in 20 s. | `RecoveryService` (any replica) re-runs the saga in *recovery mode*: hold already there (`hold_id`), asks the bank, charges if it never heard of it |
| Pod dies after the bank charged, before the capture | Customer charged at the bank; our books not yet moved. | Recovery *queries* the bank (it says "succeeded"), then captures with key `capture:<id>` (idempotent). No second bank charge, because the bank is idempotent per reference |
| Pod dies after the capture, before marking `succeeded` | Ledger moved; payment row still `processing`. | Recovery re-runs `capture` (replayed by key, same transaction returned), then `transition(succeeded)` |
| The request that created a payment dies before answering | Merchant's idempotency key stays `in_progress`. | When the payment settles, the key is completed (`completeIdempotency`, `closeOrphanKeys`); a client retrying gets the real outcome |
| Two workers act on the same payment | The lease prevents most of it; the compare-and-set `UPDATE ... WHERE status = $seen` guarantees the loser changes nothing. | automatic |
| The hold expires before the capture | The bank has the customer's money but we cannot take ours: the saga **voids the bank charge** (compensation) and fails the payment. | automatic; retried by recovery if the void itself times out |
| A payment is abandoned (bank never heard of it, > 300 s) | The bank is told to **cancel** (a tombstone, so a late duplicate cannot charge), the hold is released, the payment fails. | automatic |
| Redis (rate limiter) down | Rate limiting **fails open** and logs; requests still work. | when Redis returns |

*Evidence:* 43 payments-pod kills across the six chaos runs (3 to 9 per run); `no_duplicate_charges`, `no_stuck_payments`, `no_money_stuck_in_holds` held in all of them.

### The bank (here, the mock gateway)

| Failure | What happens | Recovery |
|---|---|---|
| Declines | A **normal** answer (HTTP 200, `failed`). The hold is released, then the payment fails. Never trips the circuit breaker. | immediate |
| Times out / HTTP 5xx / refuses connections | `GatewayUnknown`. After enough failures in the window (>= 50% of at least 10 calls in 10 s) the **circuit opens** and calls fail instantly for 5 s, then one probe. The payment stays `processing`, funds held. | recovery queries the bank when it is back |
| **Charges but the response is lost** (the worst case) | Customer is charged at the bank, we have no answer. | recovery's *query first* finds the charge and captures. `scripts/seed-demo.mjs` reproduces it |
| Sends the async callback twice | Harmless: callbacks only *nudge* the saga, which is idempotent. | n/a |
| Never sends the callback | A background retry loop re-runs the saga. | automatic |
| Its settlement file disagrees with ours | Found by **external reconciliation** and flagged. Never auto-fixed. | a human decides |

*Evidence:* bank fault windows (errors 15%, lost responses 15%, duplicate callbacks 20%, dropped callbacks 10%, latency up to 2 s) in every chaos run; 26 windows in the six runs; `reconciliation_external` clean after each.

### Kafka and the event pipeline

| Failure | What happens | Recovery |
|---|---|---|
| Kafka down or paused | Payments and ledger **keep working**: events accumulate in their `outbox` tables (`published_at IS NULL`). Webhooks are delayed. | when Kafka returns the single active publisher drains the backlog in `seq` order |
| Kafka restarts | Topics and offsets survive **only if the data directory is on a volume**. A real bug: the broker's default directory was not the volume, so every restart wiped all topics and about 2,000 published events vanished. Fixed (`KAFKA_LOG_DIRS`) and re-verified: 168 events before and after a restart. | n/a: the fix is the recovery |
| Outbox publisher dies after sending, before committing | Rows are sent again later: a duplicate on the topic. | the consumer's inbox ignores it |
| Consumer crashes mid-event | Offset not committed, handler's transaction rolled back (inbox row too). | redelivered, handled once |
| A poison message (invalid JSON, wrong schema) | Dead-lettered at once to `<topic>.dlq`; the partition keeps flowing. | inspect the DLQ |
| A handler keeps failing | Retried in place with backoff, then dead-lettered; if even the dead-letter publish fails the offset is not committed and the message is redelivered (never dropped). | automatic |
| Consumer group rebalances (a webhook pod killed) | A partition is briefly unowned; lag rises, then drains. One run's webhook consumption stalled for minutes before catching up: **cause unknown**, not reproduced. Nothing was lost. | automatic |

*Evidence:* 9 Kafka pauses in the six chaos runs; `webhooks_exactly_once` held; the harness waits for "every succeeded payment's event consumed" before checking.

### webhook (deliveries to merchants)

| Failure | What happens | Recovery |
|---|---|---|
| Pod dies mid-delivery (27 webhook pod kills in the chaos runs) | The claimed row's lease expires; another worker retries. The merchant may receive it twice if the crash came after their 200. | automatic; the merchant deduplicates on the event id |
| Merchant endpoint returns 5xx / times out | Retried with exponential backoff and jitter (8 attempts by default, base 15 s, cap 1 h). Each attempt is logged. | after the last attempt the delivery is **dead-lettered** and shown in the console; **replay** resurrects it |
| Merchant endpoint is slow | 5 s timeout per attempt counts as a failure of that attempt. | as above |
| A merchant registers an internal URL (`http://169.254.169.254`, `localhost`, a private IP) | Refused by the SSRF guard (it resolves the host and checks the address). | n/a |
| An attacker replays an old webhook | The signature timestamp is outside the ±5 minute tolerance, so verification fails. | n/a |

### reconciliation

| Failure | Effect |
|---|---|
| The service is down | **No effect on payments or money.** Reconciliation only reads. Findings are late. |
| A source (ledger, payments, bank) is unreachable | The run is marked *failed* and says so ("it says nothing about correctness"); it never reports "clean" from partial data. |
| Two replicas start a run at once | A session advisory lock lets one run per kind. |
| A mismatch that is just an in-flight payment | A grace period and a confirm pass (re-check after a short delay) keep it from being a false alarm. |

### Postgres

| Failure | What happens | Recovery |
|---|---|---|
| Down | Readiness fails; requests get 5xx; no partial state is committed. Services retry connecting. | resumes when it returns; sagas pick up where they stopped (all steps idempotent) |
| Slow | Pool wait times out after 10 s (visible errors instead of a hang). | n/a |
| A transaction half-finishes | Impossible: Postgres is atomic; the deferred balance trigger refuses an unbalanced commit. | n/a |
| Failover / replica promotion | **Not covered**: one instance. | |

### Network between services

Latency, dropped connections and hard partitions between payments and the ledger or the bank were injected through Toxiproxy in every chaos run (10 latency windows, 10 dropped-connection windows, 11 partitions across the six runs). All of them surface as `GatewayUnknown`/`LedgerUnavailable`, i.e. **unknown**, and are handled by retry-with-the-same-key plus recovery. The invariants held every time.

### The operator console and the chaos tools

The console (`dashboard-api`) only *reads and forwards*; if it is down, payments are unaffected. The chaos controller exists only in test mode (never in production: it refuses to start there). If it is unreachable the console hides the chaos bench.

## Time to recover (measured)

After the faults stopped, the harness measured how long until nothing was in flight, no events were unpublished and every webhook event was consumed: **8 s with no faults, 30 to 56 s in five of the six chaos runs, and 759 s in one** (webhook consumption stalled, cause unknown, no data lost). See `docs/CHAOS_RESULTS.md`.

## Not covered (be honest in an interview)

- **Node, disk, zone or region failure.** The chaos cluster is a single node; Postgres is one instance; Kafka one broker with replication factor 1.
- **Corruption of Postgres itself**, or restoring from backup (a runbook step in `docs/DEPLOYMENT.md`, not tested here).
- **Clock jumps** in the application (hold expiry uses the *database* clock, `dbNow`, precisely to avoid app-clock skew, but this was not chaos-tested).
- **A malicious insider with database access.** The immutability triggers stop accidental and application-level edits; a superuser can still change the schema.
- **The mock bank's own correctness.** A real gateway has behaviours (partial captures, chargebacks, settlement delays) this stand-in does not model.
