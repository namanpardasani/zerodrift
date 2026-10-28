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
- Next: Phase 3 (payments-service, mock-gateway).
