# Security review (Phase 8)

Scope: the Zerodrift services, the operator console, the demo shop and the local/Compose deployment.
This is a **sandbox payments system** (a mock bank, simulated top-ups), so the aim is to demonstrate sound
engineering, not to claim PCI compliance. Where something is a conscious trade-off it is listed under
*Accepted risks*, with the reason.

## Trust boundaries

```
 merchant servers ──(API key, HTTPS in prod)──► payments-service ──► ledger-service ──► Postgres
 merchant servers ◄──(HMAC-signed webhooks)──── webhook-service ◄── Kafka ◄── outbox
 operator browser ──(JWT)──► dashboard-api ──(per-service admin token, internal network)──► services
```

Only `payments` (merchant API), `webhook` (merchant API), `dashboard-api` and the demo shop are meant to be
reachable from outside. The ledger, reconciliation, mock bank and chaos controller are internal.

## What protects what

| Threat | Control | Where / how it is tested |
|---|---|---|
| Stolen database leaks merchant API keys | Keys are 256 random bits, stored only as SHA-256 (a fast hash is safe for high-entropy secrets, unlike passwords); shown once | `payments.test.ts` "API keys are stored only as hashes" |
| Stolen database leaks webhook secrets | AES-256-GCM encrypted at rest (we must read them to sign); authenticated, tamper-evident; rotation with a 24 h overlap | `webhooks.test.ts`, `delivery.test.ts` |
| Forged / replayed / tampered webhook | HMAC-SHA256 over `timestamp.body`, constant-time compare, ±5 min window | `webhooks.test.ts` incl. property test |
| Merchant points a webhook at our internals (SSRF) | http(s) only, no credentials in URLs, private/loopback/link-local/metadata ranges refused at creation AND before every attempt, redirects never followed | `url-guard.test.ts`, `delivery.test.ts` |
| One merchant reads another's data | Every lookup is scoped by merchant id and answers **404** (never 403, so ids are not confirmed) | `payments.test.ts`, `delivery.test.ts` |
| A merchant (or bug) floods the API | Per-merchant token bucket in Redis (atomic Lua; one quota across replicas); `X-RateLimit-*` + `Retry-After` | `ratelimit.test.ts` (exactly 10 of 50 concurrent allowed) |
| API-key guessing | Failed attempts per client are counted; over budget gets 429 before any key lookup | `ratelimit.test.ts` |
| Operator login brute force | 5 failures/min per client then 429; constant-time credential comparison evaluating both fields | `dashboard-api.test.ts` |
| Forged / expired operator tokens | JWT with **pinned HS256**, issuer, audience, role; `alg:none`, wrong-audience, expired, forged all rejected with one generic message | `dashboard-api.test.ts` |
| Secrets in logs | Central pino redaction of authorization/password/secret/token/apiKey/signature/x-admin-token; request logs carry the route **pattern** only (no query string, headers, body) | `http.test.ts` |
| Log / header injection via correlation id | Caller-supplied id accepted only if `[A-Za-z0-9._:-]{1,100}`, otherwise replaced | `http.test.ts` |
| Information leakage in errors | One error shape, generic 500, no stacks or paths; malformed JSON is a clean 400; oversized bodies 413 | `payments.test.ts` "input hardening" |
| Slowloris / hung clients | `headersTimeout` 15 s, `requestTimeout` 30 s, keep-alive 65 s on every service | `bootstrap` in `@zerodrift/common` |
| Cached financial responses | `Cache-Control: no-store`, `nosniff`, `X-Frame-Options: DENY` on API responses; CSP on served UIs | `http.test.ts`, `dashboard-api.test.ts` |
| SQL injection | Kysely parameterises everything; the only `sql.raw` uses are compile-time constants (migration table names) and a database name validated against `^[a-z_][a-z0-9_]*$` | code review (see below) |
| Running with public dev secrets in production | Every service refuses to start in `NODE_ENV=production` if an admin token / callback secret / JWT secret / encryption key is missing or a known dev value | `config.test.ts` + verified on the real binaries |
| Container breakout impact | All services run as the unprivileged `node` user (only the dev chaos controller runs as root, it needs the Docker socket) | `docker compose exec <svc> id` |
| Fault injection reaching production | Chaos controller refuses to start with chaos enabled in production, is a 404 when disabled, whitelists targets (never databases) | `chaos.test.ts` |
| Tampering with history | `journal_entries` and `audit_logs` are append-only (triggers reject UPDATE/DELETE/TRUNCATE); audit rows are written in the same transaction as the action | `ledger.test.ts`, `audit.test.ts` |
| Vulnerable dependencies | `pnpm audit:deps` (queries the npm advisory API for the whole production tree; fails CI on high/critical) | latest run: 362 package versions, 0 advisories |

## Findings from the review and their status

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Services could boot in production with the dev admin token / callback secret / encryption key from `docker-compose.yml` | High | **Fixed** (`refuseDevSecrets`) |
| 2 | No rate limiting on the merchant API | High | **Fixed** (Redis token bucket, fail-open) |
| 3 | No audit trail of who did what | Medium | **Fixed** (append-only, transactional) |
| 4 | Unlimited API-key guessing attempts | Medium | **Fixed** (throttle) |
| 5 | Containers ran as root | Medium | **Fixed** (`USER node`) |
| 6 | No security headers / server timeouts on the services | Medium | **Fixed** (shared `bootstrap`) |
| 7 | Correlation id taken verbatim from the caller (log/header injection) | Low | **Fixed** (validated) |
| 8 | A dead dependency could starve every outbound call of a service (slow DNS failures filling libuv's 4-thread pool; measured: a healthy lookup took 10 s) | Medium (availability) | **Fixed** (`UV_THREADPOOL_SIZE=32`, fail-fast, negative caching) |
| 9 | `pnpm audit` hung on slow networks, so audits were skipped | Low | **Fixed** (`scripts/audit.mjs`, in CI) |
| 10 | A native crash (SIGSEGV) when Kafka admin and consumer clients were torn down concurrently | Medium (availability) | **Fixed** (sequential teardown + regression test) |

## Accepted risks and known limitations

1. **Operator JWT in `sessionStorage`.** An XSS bug would let a script read it. Mitigations: strict CSP (`default-src 'self'`), React escapes output, 1 h lifetime, cleared when the tab closes. An `HttpOnly` cookie resists XSS better but needs CSRF protection (SameSite + token); a reasonable next step.
2. **One shared admin token** is presented by the dashboard API to payments, webhook and reconciliation. Compromise of one service exposes the others' admin APIs. Production should use per-service tokens or mTLS (service mesh) and rotate them.
3. **No TLS inside the Compose network** and none at the edge: terminate TLS at an ingress/load balancer in any real deployment (documented in the Phase 12 deployment guide). Merchant API keys must only ever travel over HTTPS.
4. **Webhook SSRF protection checks DNS then connects** (a hostile DNS server could answer differently in between: DNS rebinding). Production should additionally restrict egress at the network layer.
5. **Failed-auth throttling is per client address.** Behind a proxy all clients share one address unless `trust proxy` is configured, and a throttled address also delays its valid requests for the window. The trade-off is deliberate (cheap, protects the database), but a NAT'd merchant can be affected by a noisy neighbour.
6. **Rate limiter fails open** when Redis is unreachable (a limiter outage must not become a payments outage). During such an outage quotas are not enforced; it is visible in `rate_limit_decisions_total{result="error_allowed"}`.
7. **The chaos controller mounts the Docker socket** (equivalent to root on the host). It exists only in the dev Compose stack and refuses to run in production; do not deploy it.
8. **Mock bank and simulated top-ups**: there is no real card data, no PCI scope, and no KYC/AML. The system must not be pointed at a real payment network without that work.
9. **Secrets in `docker-compose.yml` defaults** are public dev values (the production guard rejects them). `.env.example` and a secrets guide land in Phase 12.
10. **No automated penetration test**; this review is design and code review plus the tests above.

## How to re-run the checks

```bash
pnpm audit:deps                 # dependency advisories (exit 1 on high/critical)
pnpm test                       # includes the security-relevant tests listed above
pnpm e2e:smoke                  # browser checks against the running stack
```
