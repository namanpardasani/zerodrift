# Environment variables

Every variable of every service. `*` = required. In production (`NODE_ENV=production`) the services **refuse to start** with a
missing or development secret (`refuseDevSecrets` in `@zerodrift/config`): the error names the variable. A ready-to-fill file for the
single-host stack is [`.env.example`](../.env.example); for Kubernetes the same values go in a Secret (see
`deploy/helm/zerodrift/values-prod.yaml`).

## Shared by every service

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on the development-secret guard and production behaviour |
| `PORT` | per service (below) | HTTP port |
| `SERVICE_NAME` | per service | name in logs, metrics and traces |
| `LOG_LEVEL` | `info` | `fatal` `error` `warn` `info` `debug` `trace` (JSON logs; secrets and tokens are redacted) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | e.g. `http://jaeger:4318`. Tracing is OFF when unset (no overhead, no collector needed) |
| `UV_THREADPOOL_SIZE` | `32` (set in the image) | Node DNS/thread pool; a dead dependency must not starve DNS for healthy ones (found by a browser test) |

## ledger (3001) — the books

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` * | | Postgres, database `ledger` |
| `KAFKA_BROKERS` | unset | `host:9092`. Unset = the outbox relay is off (events stay in the outbox table) |
| `MIGRATE_ON_BOOT` | `true` | run migrations at start-up (set `false` if a separate job migrates) |
| `DB_POOL_MAX` | `20` | connection pool size. Total across replicas must stay below Postgres `max_connections` |
| `HOLD_SWEEP_INTERVAL_SECONDS` | `10` | how often expired holds are released (0 = off) |

## payments (3002) — the merchant API and the payment saga

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` * | | Postgres, database `payments` |
| `LEDGER_URL` * | | the ledger |
| `GATEWAY_URL` * | | the bank / payment gateway |
| `PUBLIC_URL` | unset | where the bank posts async callbacks (this service's address as the bank sees it) |
| `ADMIN_TOKEN` * (prod) | dev value | operator token (admin routes, internal recovery). `openssl rand -hex 24` |
| `GATEWAY_CALLBACK_SECRET` * (prod) | dev value | authenticates the bank's callbacks. `openssl rand -hex 24` |
| `REDIS_URL` | unset | per-merchant rate limiting and failed-auth throttling. Unset = rate limiting OFF (logged). Fails open if Redis dies |
| `KAFKA_BROKERS` | unset | outbox relay target |
| `GATEWAY_TIMEOUT_MS` | `1500` | a bank call slower than this is an UNKNOWN outcome, not a failure |
| `HOLD_TTL_SECONDS` | `1800` | how long money stays held for a payment in flight |
| `RECOVERY_INTERVAL_SECONDS` | `10` | how often the recovery job looks for stuck payments |
| `RECOVERY_STUCK_AFTER_SECONDS` | `30` | a payment in flight this long is picked up by recovery |
| `RECOVERY_ABANDON_AFTER_SECONDS` | `300` | recovery gives up and fails (and voids the bank charge) after this |
| `MIGRATE_ON_BOOT`, `DB_POOL_MAX` | `true`, `20` | as above |

Per-merchant rate limit and fee are set when the merchant is created (`POST /admin/merchants`: `rateLimitPerMin`, `feeBps`).

## webhook (3003) — signed, retried deliveries

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` * | | Postgres, database `webhook` |
| `PAYMENTS_URL` * | | used to authenticate merchants by their API key |
| `WEBHOOK_ENCRYPTION_KEY` * | | base64 of exactly 32 random bytes: `openssl rand -base64 32`. Encrypts signing secrets at rest. **Changing it makes existing secrets unreadable** |
| `ADMIN_TOKEN` * (prod) | dev value | operator token |
| `KAFKA_BROKERS` | unset | the consumer of payment events |
| `WEBHOOK_TIMEOUT_MS` | `5000` | per attempt |
| `WEBHOOK_MAX_ATTEMPTS` | `8` | then the delivery is dead-lettered (replayable) |
| `WEBHOOK_BACKOFF_BASE_MS` / `_MAX_MS` | `15000` / `3600000` | exponential backoff with full jitter between attempts |
| `ALLOW_PRIVATE_WEBHOOK_URLS` | `false` | SSRF guard: merchants' URLs must be public. `true` only for a closed demo, never in production |
| `DB_POOL_MAX`, `MIGRATE_ON_BOOT` | `20`, `true` | as above |

## reconciliation (3004) — do the books, the payments and the bank agree?

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` * | | Postgres, database `reconciliation` |
| `LEDGER_URL` *, `PAYMENTS_URL` *, `GATEWAY_URL` * | | the three sources compared |
| `PAYMENTS_ADMIN_TOKEN` * | | the payments admin token |
| `ADMIN_TOKEN` * (prod) | dev value | its own operator token |
| `INTERNAL_RUN_INTERVAL_SECONDS` / `EXTERNAL_RUN_INTERVAL_SECONDS` | `300` / `900` | scheduled runs (one runner at a time, advisory lock) |
| `RECON_GRACE_SECONDS` | `60` | young payments are not judged yet |
| `RECON_STUCK_AFTER_SECONDS` | `300` | in flight longer than this is a finding |
| `RECON_CONFIRM_DELAY_SECONDS` | `3` | a mismatch is re-checked after this before it is reported |

## mock-gateway (3005) — the demo's bank

A stand-in for a real payment gateway. **Its fault-injection API (`/admin/faults`) is unauthenticated: it must stay on the private network.**

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` * | | Postgres, database `gateway` |
| `ADMIN_DATABASE_URL` | unset | lets it create its own database if missing |
| `GATEWAY_CALLBACK_SECRET` * (prod) | dev value | must equal the payments one |

## dashboard-api (3008) — landing page, operator console, console API

| Variable | Default | Meaning |
|---|---|---|
| `JWT_SECRET` * (prod) | dev value | >= 32 chars. `openssl rand -base64 48` |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` * (prod) | `admin` / dev value | the one operator account (login is rate limited; failures are throttled per address) |
| `TOKEN_TTL_SECONDS` | `3600` | session length |
| `ADMIN_TOKEN` * (prod) | dev value | how the console API calls the services |
| `LEDGER_URL`, `PAYMENTS_URL`, `WEBHOOK_URL`, `RECONCILIATION_URL` | in-network names | where the services are |
| `CHAOS_URL` | `http://chaos-controller:3006` | unreachable in production on purpose: the chaos bench then disappears from the console |
| `PROMETHEUS_URL` | `http://prometheus:9090` | optional; the Metrics page says so when it cannot reach it |
| `ALLOWED_ORIGINS` | empty | extra CORS origins (the console is same-origin, so empty is right) |
| `STATIC_DIR` | `/app/static` (image) | the built landing page and console |
| `LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_SECONDS` | `5` / `60` | login throttle |

## demo-shop (3009), demo-receiver (3007) — demo only

| Variable | Default | Meaning |
|---|---|---|
| `PAYMENTS_URL`, `WEBHOOK_URL` | in-network names | the platform it integrates with |
| `ADMIN_TOKEN` | dev value | used once at start-up to register itself as a merchant + webhook endpoint |
| `PUBLIC_URL` | `http://demo-shop:3009` | where webhooks reach the shop. In production it must be a PUBLIC https URL |
| `STATIC_DIR` | `/app/static` (image) | the built shop |
| `RECEIVER_SECRETS` (receiver) | empty | comma-separated webhook signing secrets it trusts |

## chaos-controller (3006) — test only, never in production

`CHAOS_ENABLED` (default `false`), `CHAOS_BACKEND` (`docker` or `kubernetes`), `ADMIN_TOKEN`, `GATEWAY_URL`, `TOXIPROXY_URL`,
`DOCKER_SOCKET`, `COMPOSE_PROJECT`. It returns 404 for everything unless enabled and **refuses to start when `NODE_ENV=production`**.
The Helm chart refuses to render it with `nodeEnv: production`.

## Infrastructure

| Component | Needs |
|---|---|
| Postgres 17 | five databases: `ledger`, `payments`, `webhook`, `reconciliation`, `gateway` (`infra/postgres/init.sh`). `max_connections` >= sum of every replica's `DB_POOL_MAX` + headroom |
| Kafka 3.9 (KRaft, one node is fine) | topics are created by the services at start-up (`zerodrift.payments.v1`, `zerodrift.ledger.v1`, and `.dlq` for each). Its data directory **must be on a volume** (`KAFKA_LOG_DIRS`) |
| Redis 7 | optional (rate limiting). No persistence needed |
