# Zerodrift NOTES

## Architecture

## Money rules
Enforced twice, in code AND in the database (ledger migration `0001_ledger_schema.ts`):
- **Integer minor units**: `bigint` in TypeScript, `BIGINT` in Postgres; amounts travel as decimal strings in JSON. `@zerodrift/db` parses BIGINT to `bigint`. Fees use integer math, **round half up** (`feeFor`); a partial refund returns the fee share rounded **down** (`proportionalFee`).
- **Immutable journal**: trigger rejects UPDATE/DELETE/TRUNCATE on `journal_entries`; corrections are reversing transactions.
- **Debits == credits**: validated in code before writing AND by a **DEFERRABLE INITIALLY DEFERRED constraint trigger** at COMMIT. Deferred because entries are inserted one at a time (balanced only once all are in); the DB then refuses to commit an unbalanced transaction from any code path or manual SQL.
- **No negative balance** unless `allow_negative`: code check with a clear error, plus a BEFORE trigger on `account_balances` as the backstop.
- **Currency**: composite FK `(account_id, currency) -> accounts(id, currency)`, so an entry can never use a currency different from its account.
- **Concurrency**: `SELECT ... FOR UPDATE` on balance rows, always acquired in ascending account id order (`ORDER BY account_id FOR UPDATE`); holds lock the hold row first, then balances. A deadlock needs a lock cycle, a global order makes cycles impossible. `inTransaction` still retries 40P01/40001 as cheap insurance.
- **Idempotency**: `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` claims the key inside the posting transaction. A concurrent duplicate **blocks on the unique index** until the first commits (then returns its stored response) or rolls back (then it runs). Same key + different request hash => 422 `idempotency_key_reuse`.
- **Timeouts are UNKNOWN outcomes** (payments-service, Phase 3).

## Decisions and tradeoffs

- **GitHub remote (overrides brief "never push")**: on 2026-10-28 the user explicitly asked to push everything to their GitHub repo and keep it updated. Rule from now: push after every phase commit (and big milestones) once the remote exists. Remote URL and auth are supplied by the user; tokens are never pasted into chat or committed.
- **Kafka client: @confluentinc/kafka-javascript** (v1.11.0, last release 2026-10-07). KafkaJS 2.2.4 was last published 2023-02-27, so it is effectively unmaintained.
- **Circuit breaker: opossum** v10.0.0 (published 2026-08-03).
- **DB layer: Kysely** (v0.29.7, active as of 2026-10-17); chosen over Drizzle for explicit SQL control (`FOR UPDATE`, isolation levels) in the ledger.
- Other verified versions: NestJS 12.3.2, zod 4.6.7, pino 10.4.0, vitest 5.0.5, prom-client 15.1.3.
- **TypeScript 6.0.x, not 7**: `pnpm add typescript` resolves to 7.0 (native port), but typescript-eslint 8.72 refuses to run on it ("does not support TS 7.0"). Pinned `typescript@6`. TS 6/7 no longer auto-load `@types/*`, so `tsconfig.base.json` sets `"types": ["node"]`.
- **CommonJS output, not ESM**: NestJS decorators + `emitDecoratorMetadata` are simplest on CJS. Vitest uses `unplugin-swc` because esbuild does not emit decorator metadata.
- **Shared packages are consumed from `dist/`** (`main` -> `dist/index.js`), so run `pnpm build` before `typecheck`/`test` (CI does this; `pnpm -r build` is topological).
- **Kysely 0.29 moved the migrator** to the `kysely/migration` entry point.
- **pnpm 12 blocks dependency build scripts by default**; `pnpm-workspace.yaml` `allowBuilds` allows only `@swc/core` and `esbuild`. With `CI=true` pnpm installs are frozen: use `--no-frozen-lockfile` when adding deps.
- **Host ports**: the user's other projects occupy 5432/5433/6379/6380, so Zerodrift publishes Postgres on **55432** and Redis on **56379**. Inside the Compose network services still use the standard ports.
- **Postgres image**: `postgres:17-bookworm` (the `postgres:17` image on this machine was corrupted by an interrupted pull).
- **Environment**: the network is flaky (DNS timeouts, TLS errors during image/npm downloads). Installs and pulls are wrapped in retry loops.
- **Database per service** in one Postgres instance (`ledger`, `payments`, `webhook`, `reconciliation`), created by `infra/postgres/init.sh`. No cross-database access. A shared instance keeps the local stack light; production could split them.
- **Config**: `@zerodrift/config` holds `PRODUCT_NAME`, topic names, and a zod-validated `loadConfig` that fails fast on bad env.

- **Ledger balance convention** (Phase 2): every account's balance = credits - debits, so a funded wallet is positive and `gateway_clearing` (the outside world) goes negative on top-ups. Hence **the sum of all balances is always exactly 0**: the strongest "no money created/destroyed" check, exposed at `GET /internal/invariants` (also verifies balanced transactions, balance == sum of entries, held == sum of active holds, no illegal negatives).
- **Holds**: create moves available -> held (no journal entry); capture posts a journal transaction that debits the payer *from held funds* and returns any unused remainder to available (so partial capture = capture + auto-release; one capture per hold); release/expire return funds. Expiry sweeper takes one hold per short transaction with `FOR UPDATE SKIP LOCKED`, safe with multiple replicas.
- **Reversal** posts the mirror image; `UNIQUE(reverses_transaction_id)` makes a double reversal impossible even concurrently; it refuses (409 `insufficient_funds`) when the money was already spent rather than going negative. Reversals cannot be reversed.
- **Refund design note**: partial refunds are modelled by payments-service as ordinary transfers merchant -> customer (fee share via `proportionalFee`); `reverse` handles full reversal of one ledger transaction.
- **Balances stored, not derived**: `account_balances` is updated in the same DB transaction as the entries (fast reads, row-lock target); the invariant checker proves it always equals the journal.
- **Testing choices**: one Testcontainers Postgres per test run (global setup, `TESTCONTAINERS_RYUK_DISABLED` since we stop it ourselves), a fresh database per test file. `TEST_PG_ADMIN_URI` reuses an existing server. Vitest configs are `.mts` to avoid Vite's CJS-config warning. The model-based property test (fast-check) funds wallets first and has a coverage guard so it cannot pass vacuously; invariants are global so a failure early in a run shrinks to a trivial sequence (known limitation).
- **Mutation check done by hand**: breaking the capture-remainder release made 4 example tests + the property test fail, so the tests do detect that bug class.

### Phase 3 decisions (payments-service + mock-gateway)
- **Flow**: customer funds are HELD in the ledger, the gateway (mock bank) is asked, then the hold is CAPTURED to the merchant (success) or RELEASED (failure). Wallet balance is the funding source; the gateway acts as the authorisation/risk step and produces the settlement file reconciliation uses.
- **Saga** (`saga.service.ts`): every step has a deterministic idempotency key derived from the payment id (`hold:<id>`, gateway reference = id, `capture:<id>`), progress is stored, so the saga can be resumed from any step by the request path, a gateway callback, or the recovery job. **A timeout / network error / 5xx / open circuit is UNKNOWN, never a failure**: the payment stays `processing`, funds stay held. Only a definitive answer (bank decline, ledger rejection) fails it, and a failed payment only becomes `failed` AFTER its hold has been released.
- **Lease** (`payments.lease_until`): short exclusive per-payment lease so the request path and recovery do not both work one payment. Not required for correctness (all steps idempotent, status moves are compare-and-set), it just avoids wasted calls. A crashed worker's lease expires.
- **Status changes** are compare-and-set (`UPDATE .. WHERE status = <seen>`) through `assertTransition` (state machine); losing a race returns the winner's state. Timeline row + outbox event are written in the same transaction.
- **Recovery job** (every 10s, also `POST /internal/recovery/run`): stuck payments (not leased, untouched for `RECOVERY_STUCK_AFTER_SECONDS`) are resumed in RECOVERY mode: ask the bank first (`GET /charges/:ref`). Known -> believe it. Unknown to the bank: young payment -> charge now (idempotent per reference); older than `RECOVERY_ABANDON_AFTER_SECONDS` -> `cancel` (writes a tombstone so a late/duplicate charge cannot succeed afterwards) + release hold + fail. If the bank succeeded but the hold has meanwhile expired, the bank charge is **voided** and the payment fails (customer never ends up charged without paying). It also finishes pending refunds, closes orphaned `in_progress` idempotency keys, deletes expired keys.
- **Gateway callbacks** only NUDGE the saga (which re-queries the bank itself), so duplicated, forged or reordered callbacks cannot change state. HMAC-signed, verified in constant time. Handled in the background with retries because they often arrive while the request still holds the lease.
- **Merchant idempotency** (`idempotency_keys`): claimed INSIDE the same DB transaction that creates the payment, so claim + resource commit atomically and a concurrent duplicate blocks on the unique index. Same key+request: stored response replayed (`Idempotent-Replayed: true`; a stored "202 processing" is answered with the CURRENT state instead of a stale snapshot); still running: 409 `request_in_progress`; different request: 422. Keys expire after 24h.
- **Circuit breaker**: opossum. Counts timeouts/5xx/network errors only (declines are normal results). Defaults: per-attempt timeout 1.5s, 1 retry with exponential backoff + full jitter (`@zerodrift/common` `retry`), opens at >=50% failures over >=10 calls in 10s, probes after 5s. Open circuit = instant UNKNOWN, no waiting. Exported metric `gateway_circuit_open`.
- **Refunds**: payment row locked, amount RESERVED, `pending` refund inserted (concurrent refunds serialise on the lock so they can never exceed the payment); one balanced ledger transaction (credit customer; debit merchant `amount - feeShare`; debit fees account `feeShare`); success -> payment `partially_refunded`/`refunded`; definitive ledger refusal (merchant already spent the money) -> refund `failed` and reservation released; timeout -> stays `pending` for recovery. Fee returned proportionally with cumulative rounding so all shares add up to exactly the fee.
- **API keys** are `zd_live_` + 256 random bits, stored only as SHA-256 (fast hash is fine for high-entropy keys, unlike passwords), shown once. Admin endpoints use a constant-time-compared token (`ADMIN_TOKEN`); dashboard JWT auth, rate limiting and audit log are Phase 8.
- **Top-ups** (`POST /v1/customers/:id/topups`) call the ledger directly (simulated bank funding, idempotent via the ledger key scoped by merchant). Not routed through the gateway.
- **Mock gateway** persists charges in its own Postgres DB (`gateway`, created on first boot via `ensureDatabase`) so killing/restarting it never loses what the "bank" did. Fault knobs (PUT `/admin/faults`): latency range, declineRate, errorRate (HTTP 500), lostResponseRate (processed but never answered), duplicateCallbackRate, callbackDropRate. A decline/success is decided ONCE per reference. Settlement file: `GET /settlement?date=YYYY-MM-DD[&format=csv]` (succeeded, non-voided charges).
- **Shared code moved to packages**: `DomainError` + `ErrorFilter` + `retry/backoffDelayMs` in `@zerodrift/common`, `makeEvent` in `@zerodrift/events`, `minorAmountSchema` in `@zerodrift/money`, `createTestDatabase` + Testcontainers global setup in `@zerodrift/testing` (ESM-only because it imports vitest).
- **Ledger gained** `POST /transactions` (generic balanced posting, used for the multi-source refund shape) and an `@zerodrift/ledger/app` entry point so integration tests start it in-process.
- **Outbox table + `emit()` exist now** (written transactionally with every state change); the Kafka publisher/consumers arrive in Phase 4.

### Bugs found by the Phase 3 tests (fixed)
- *Callback lost while the request held the lease*: the gateway callback arrived ~hundreds of ms after the charge, while the original request was still waiting out its timeout holding the lease; the handler found the lease busy, did nothing, and the nudge was consumed. Fix: acknowledge immediately and retry in the background until the payment settles. Test: "lost response but the async callback arrives".
- *Test isolation via the breaker*: `resetCircuit()` only closed the breaker but kept opossum's rolling failure stats, so later tests re-opened it immediately. (Realistic behaviour; tests now rebuild the breaker.) Property tests lesson: make the generators actually reach the interesting states and add coverage guards.
- *Flaky concurrency test*: asserting exact status codes under a 20-way burst in a single event loop was wrong; the right property is "one payment, one hold, one charge, customer charged once" (503/202/409 are all legitimate answers under load).

## What happens if X fails

## Chaos results

## Interview Q&A

## Progress log

### Phase 0: scaffolding (2026-10-28)
- Done: PROJECT_BRIEF.md, CLAUDE.md, NOTES.md, .gitignore.
- Environment findings: Node v24.21.0 and pnpm 12.15.0 present. **Docker, kind, helm, kubectl, k6 are NOT installed in this WSL distro** (Docker Desktop WSL integration is off).
- Update: Docker 29.8.2 + Compose v5.5.1 now working (hello-world ran). kind, helm, kubectl, k6 still need installing before Phase 9. No SSH key exists in ~/.ssh; GitHub remote not yet provided.

### Phase 1: foundation (2026-10-28)
- Done: pnpm monorepo; shared packages `@zerodrift/{config,money,events,db,common}`; six NestJS service skeletons (ledger 3001, payments 3002, webhook 3003, reconciliation 3004, mock-gateway 3005, chaos-controller 3006) each with `/health`, `/ready`, `/metrics`; migration runner (`@zerodrift/db`, applied on boot; ledger schema arrives in Phase 2); root Dockerfile (`--build-arg SERVICE=`); `docker-compose.yml` (Postgres, Redis, Kafka KRaft, Kafka UI, Prometheus, Grafana, Toxiproxy + services); ESLint; GitHub Actions CI (lint, build, typecheck, test, Docker build matrix).
- Verified: money package tests incl. fast-check properties pass (7); all packages and services build; lint clean; ledger service boots against real Postgres and `/ready` reports postgres up.
- Verified end to end: `docker compose up -d --build` runs all 12 containers; every service answers `/health`; Postgres/Redis/Kafka healthy; Grafana, Kafka UI, Toxiproxy (4 proxies) respond; Prometheus scrapes all 5 app services (`up`). Bug found while verifying: `/metrics` was served as `text/html` so Prometheus rejected it; fixed with the exposition content type + a regression test in `packages/common`.
- Known issues: Kafka/Redis checks are not in `/ready` yet (added with Phase 4); Grafana dashboards are added in Phase 8; chaos-controller is not scraped (no metrics needed).
- GitHub remote: origin = https://github.com/namanpardasani/zerodrift (pushed via Windows Git Credential Manager, no token needed).

### Phase 2: ledger-service (2026-10-28)
- Done: schema + DB-level money rules; posting engine; accounts (get-or-create, system accounts), top-ups, transfers with fee split, full reversals, holds (create / full+partial capture / release / expiry sweeper); invariant checker endpoint; REST API with Idempotency-Key, zod validation, uniform error shape (201 fresh / 200 + `Idempotent-Replayed` on replay / 422 key reuse / 409 conflicts).
- Verified: 37 tests against real Postgres (Testcontainers): core behaviour, DB triggers hit with raw SQL, idempotency (incl. 30 concurrent duplicates via service AND HTTP execute exactly once), 100 parallel opposing transfers (no deadlock, total conserved), 50 concurrent withdrawals vs balance for 10 (exactly 10 succeed), capture-vs-release races, concurrent reversals (exactly one wins), mixed storm, model-based property test (60 random sequences). Also exercised end to end in the Compose stack.
- Known issues: no outbox/`transfer.completed` events yet (Phase 4); no auth on the ledger API (internal network only; merchant auth lives in payments-service); list endpoints are not paginated by cursor beyond `limit`/`before`.

### Phase 3: payments-service + mock-gateway (2026-10-28)
- Done: mock-gateway (faults, idempotent charges, cancel/void, callbacks, settlement); payments-service (merchants + hashed API keys, payment API, state machine, saga, ledger/gateway clients with timeout/retry/jitter/circuit breaker, idempotency, callbacks, recovery job + scheduler, refunds, outbox rows); shared packages (`common`, `events`, `money`, `testing`); ledger generic posting + in-process app factory; Compose wiring.
- Verified: 96 tests pass workspace-wide (money 7, common 10, gateway 10, ledger 39, payments 30; payments suite run 4x in a row for stability). Payments tests run ledger + gateway + payments in-process on real Postgres and cover: happy path + fee split, insufficient funds, bank decline, idempotent replay/mismatch/missing key, 20 concurrent duplicates, gateway 5xx, LOST RESPONSE (callback dropped / delivered / duplicated), abandoned payment + tombstone, ledger unreachable at HOLD / at CAPTURE / before creation, expired hold with a succeeded bank charge (voided), circuit breaker open -> fail fast -> half-open -> closed, partial/full/concurrent/idempotent/failed/stuck refunds, auth + tenancy, validation, orphaned idempotency keys. Also verified live in Docker Compose: a payment hit by a lost response healed itself via the background recovery timer; ledger invariants stayed clean.
- Known issues: outbox rows are not yet published (Phase 4); no rate limiting, audit log, dashboard JWT or OpenAPI yet (Phase 8); `GET /v1/payments` has `limit`/`before` paging only; the settlement-vs-internal comparison is Phase 6.
- Next: Phase 4 (outbox publishers, Kafka topics, idempotent consumers, DLQs).
