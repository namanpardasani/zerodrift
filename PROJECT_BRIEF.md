You are the lead engineer building a complete, production-quality project in this empty repo, mostly autonomously. Read this whole message; it is the full context and plan.

=====================================================
0. HOW TO WORK (read first)
=====================================================
- FIRST: save this entire message verbatim as PROJECT_BRIEF.md. Create CLAUDE.md (points to PROJECT_BRIEF.md and summarizes the rules in this section) and NOTES.md (headings: Architecture, Money rules, Decisions and tradeoffs, What happens if X fails, Chaos results, Interview Q&A, Progress log). Create a .gitignore for Node/pnpm, Docker, IDE files and .env. Then give me a 10-line summary of the plan and START building immediately; don't wait for my approval.
- Build phase by phase (section 7) WITHOUT stopping to ask me, except in these cases:
  (1) the DESIGN PAUSE (Phase 10): stop and wait for my screenshots and ideas;
  (2) anything that could cost money or needs my accounts/credentials;
  (3) anything destructive outside this repo or irreversible;
  (4) a real blocker you cannot resolve after trying reasonable alternatives (explain options, recommend one).
  For every other decision: choose the best option yourself, write the decision and reasons in NOTES.md, and continue.
- Make a LOCAL git commit at the end of each phase with a clear message. Never push and never add a remote.
- Keep "Progress log" in NOTES.md updated after every phase with: what's done, what's next, known issues. If the session or context resets, re-read PROJECT_BRIEF.md and NOTES.md and continue from the next unfinished task.
- Quality bar: everything runs with one command, tests pass, no TODO stubs left in finished phases, no fake data or invented numbers anywhere.
- Verify current library versions and maintenance status instead of guessing. Free tools only; tell me before anything could cost money.
- Name: the product is "Zerodrift". Keep the product name in ONE config constant + one place in the frontend so it's easy to change later. Package names use the @zerodrift/ scope.

=====================================================
1. CONTEXT
=====================================================
I'm a 3rd-year B.Tech student (tier-3 college, India) building portfolio projects for 2027 internships and placements, targeting Indian fintech (Razorpay, PhonePe, CRED, Juspay, Cashfree, Groww, Zerodha), product companies and backend roles. I'll study this codebase after it's built, so code must be clean, well-structured and well-commented where logic is non-obvious. Other projects: FlagForge, CodeAtlas, NebulaDB (planned).

=====================================================
2. WHAT WE'RE BUILDING
=====================================================
Zerodrift: a payments and wallet backend, a mini Razorpay, that moves money correctly even when services crash, networks fail, or requests repeat.
Pitch: "A double-entry payments ledger with idempotent APIs and Kafka-based sagas, proven under chaos: 10,000 concurrent transfers with random service crashes, zero balance drift, zero double charges."

Features:
- Merchants and customers with wallet accounts; system accounts (gateway clearing, fees, suspense).
- Payments through a mock gateway: hold/authorize, capture, fail, timeout handling.
- Wallet transfers, top-ups, refunds (full and partial), optional platform fee split.
- Idempotency keys on every money-moving API.
- Payment state machine: created -> processing -> succeeded | failed; succeeded -> partially_refunded | refunded; only valid transitions.
- Double-entry ledger; integer minor units (paise); INR for v1 with currency as a column.
- Transactional outbox -> Kafka events (payment.created/succeeded/failed, refund.created, transfer.completed...).
- Webhooks to merchants: HMAC-signed, retries with exponential backoff + jitter, delivery log, dead-letter after N attempts, manual replay.
- Recovery job for payments stuck in processing (query gateway, then complete or reverse).
- Reconciliation: internal (every journal balanced, balances = sum of entries, total money conserved) and external (vs mock gateway settlement report); mismatch reports.
- Merchant API keys (hashed), dashboard auth (JWT), rate limiting per merchant, audit log.
- Dashboard (React): accounts and balances, payment timeline, ledger entries, webhook attempts, reconciliation reports, metrics, and a CHAOS PANEL (kill a service, slow/fail the gateway, pause Kafka) to watch recovery live.
- Demo shop: a small React store that checks out through Zerodrift, plus a demo merchant webhook receiver.

=====================================================
3. ARCHITECTURE
=====================================================
Services (TypeScript, NestJS):
1. payments-service: merchant API, idempotency, state machine, gateway calls with timeouts/retries/circuit breaker, saga orchestration (hold -> gateway -> capture/release), recovery job, refunds.
2. ledger-service: accounts, journal entries, holds, balances; the single source of truth for money.
3. webhook-service: consumes events, delivers signed webhooks with retries, delivery log, replay.
4. reconciliation-service: scheduled internal + external reconciliation, reports.
5. mock-gateway: fake bank/UPI with configurable latency, failure rate, lost responses (succeeds but never replies), duplicate callbacks, and a daily settlement file.
6. chaos-controller (dev only): endpoints the dashboard uses to kill/restart containers or pods, change gateway fault settings, and toggle Toxiproxy faults. Must be disabled in production config.
Sync REST where an answer is needed now (payments -> ledger), Kafka for async. Each service owns its own Postgres database/schema (no cross-service table access). Outbox + publisher in every producing service; processed_events (inbox) table for idempotent consumers; dead-letter topics.

=====================================================
4. TECH STACK
=====================================================
- Node.js LTS, TypeScript (strict), NestJS for all services; pnpm workspaces monorepo with shared packages (types, money utilities using bigint, event schemas, config).
- PostgreSQL with Kysely or Drizzle (NOT Prisma for the ledger: we need precise transactions, SELECT ... FOR UPDATE, isolation levels); migrations with the chosen tool.
- Money as BIGINT in Postgres and bigint in TypeScript; never number or floats for money. Zod for validation.
- Kafka (KRaft mode) with a maintained Node client (compare @confluentinc/kafka-javascript vs KafkaJS maintenance and pick). Redis via ioredis.
- Resilience: timeouts, retry with backoff + jitter, circuit breaker (choose a maintained lib).
- Observability: OpenTelemetry traces + metrics, Prometheus, Grafana dashboards (provisioned as code), pino structured logs with correlation ids, Kafka UI for local dev.
- Testing: Vitest, Testcontainers for Node (real Postgres/Kafka/Redis), fast-check property tests, k6 load tests, Toxiproxy network faults.
- Frontend: React + TypeScript + Vite + Tailwind for dashboard and demo shop. Functional and clean before the design pause; centralize styling in theme tokens + reusable components so the redesign is easy.
- Infra: Docker + Docker Compose (one command to run everything), Kubernetes (kind or minikube) + Helm charts, GitHub Actions CI (lint, typecheck, tests, Docker builds).
- OpenAPI/Swagger docs for the merchant API.

=====================================================
5. DATA MODEL (starting point; improve it and document changes)
=====================================================
ledger: accounts(id, owner_type[customer|merchant|system], owner_id, currency, type, status, allow_negative, created_at)
journal_entries(id, transaction_id, account_id, direction[debit|credit], amount_minor BIGINT CHECK > 0, currency, created_at) append-only
ledger_transactions(id, type[payment|transfer|refund|topup|fee|reversal], reference_id, idempotency_key UNIQUE, status, created_at)
holds(id, account_id, amount_minor, status[active|captured|released|expired], reference_id, expires_at)
account_balances(account_id PK, available_minor, held_minor, version) updated in the same transaction as entries
payments: payments(id, merchant_id, customer_id, amount_minor, currency, status, gateway_ref, idempotency_key, failure_reason, created_at, updated_at, version)
payment_events(id, payment_id, from_status, to_status, reason, created_at)
idempotency_keys(merchant_id, key, request_hash, response_snapshot JSONB, status[in_progress|completed], created_at, expires_at) UNIQUE(merchant_id, key)
refunds(id, payment_id, amount_minor, status, idempotency_key, ...)
outbox(id, aggregate_type, aggregate_id, event_type, payload JSONB, created_at, published_at)
processed_events(consumer, event_id, processed_at) PK(consumer, event_id)
webhook_endpoints(id, merchant_id, url, secret_encrypted, active); webhook_deliveries(id, event_id, endpoint_id, attempt, status, response_code, next_attempt_at, ...)
recon_runs(...), recon_mismatches(...), merchants(id, name, api_key_hash, rate_limit_per_min), audit_logs(...)

=====================================================
6. MONEY RULES (non-negotiable; enforce in code AND tests)
=====================================================
- Integer minor units only; explicit rounding rules for fees.
- Journal entries are immutable; corrections are reversing entries, never UPDATE/DELETE.
- Every ledger transaction: debits == credits (validated in code and checked in the DB via constraint/trigger or deferred check; justify).
- No account below zero unless allow_negative.
- Concurrency: row locks (SELECT ... FOR UPDATE) or optimistic locking with retry; lock accounts in consistent id order to avoid deadlocks.
- Idempotency: same key + same request -> stored response; same key + different request -> 422; concurrent duplicates must never both execute.
- At-least-once delivery + idempotent consumers + outbox = effectively-once. Document why exactly-once over a network isn't possible.
- Timeouts are UNKNOWN outcomes, never failures; payments stay processing until recovery confirms the real status.

=====================================================
7. PHASES (build in order, commit locally after each)
=====================================================
Phase 1: monorepo, shared packages, Docker Compose (Postgres, Redis, Kafka KRaft, Kafka UI, Prometheus, Grafana, Toxiproxy), NestJS service skeletons with health checks, migrations, config, CI.
Phase 2: ledger-service: schema, posting logic, balances, holds (create/capture partial+full/release/expire), transfers and top-ups API, idempotency; tests including concurrency (e.g., 100 parallel transfers on the same accounts; total conserved) and property tests.
Phase 3: payments-service: merchants + API keys, payment API, state machine, mock-gateway with configurable faults, resilience around gateway calls, saga flow, timeout handling, recovery job, refunds with reversing entries.
Phase 4: outbox + publishers, Kafka topics, idempotent consumers, dead-letter topics, event schemas versioned in a shared package.
Phase 5: webhook-service: signing, retries with backoff + jitter, delivery log, dead-letter, replay; demo merchant receiver that verifies signatures.
Phase 6: reconciliation-service: internal + external reconciliation, settlement file from mock gateway, mismatch reports, scheduled runs.
Phase 7: dashboard + demo shop (functional): accounts, balances, payment timeline, ledger view, webhooks, recon reports, metrics, chaos panel wired to chaos-controller; demo shop checkout end to end.
Phase 8: observability (traces across services, Grafana dashboards for throughput, error rates, latency, Kafka consumer lag, outbox backlog), rate limiting, security review (hashed API keys, webhook HMAC, input validation, no secrets/PII in logs, CORS, dependency audit) with fixes.
Phase 9: THE PROOF: Kubernetes (kind/minikube) + Helm with multiple replicas, then the chaos + load harness:
  - k6: 10,000 concurrent payments/transfers across hundreds of accounts, ~10% duplicate requests (same idempotency key), random client retries.
  - Chaos during the run: random pod kills (payments, ledger, webhook), gateway latency/failures/lost responses, Kafka pause, Toxiproxy network delay and drops.
  - Invariant checker at the end: total money conserved exactly; every transaction balanced; balances == sum of entries; no duplicate charge per idempotency key; no payment stuck in processing after the recovery window; reconciliation clean; every succeeded payment's webhook delivered or dead-lettered exactly once per endpoint.
  - Run it several times. Fix every bug it finds and document each one ("bug the chaos test caught: cause, fix, test added"). Record real results (throughput, p50/p99 latency, faults injected, invariants passed) in docs/CHAOS_RESULTS.md and NOTES.md. Never invent numbers.
  - A one-command script to run the whole chaos test and print the invariant report.
Phase 10: DESIGN PAUSE. STOP here and tell me: "Ready for design." Before stopping, take screenshots of every page (Playwright, local only) and list the pages and components. I will come back with screenshots, references and ideas for a natural, creative, NOT AI-looking design with purposeful animations. Do not start any visual redesign before I send that.
Phase 11 (after my design input): apply the design system and animations exactly as I describe, page by page, with before/after screenshots. Respect prefers-reduced-motion, WCAG AA contrast, keyboard access, and keep performance good.
Phase 12: deployment PREPARATION ONLY (do not deploy, do not create cloud accounts): production Dockerfiles, Helm values for prod, environment variable docs (.env.example), a free-tier deployment guide with 2-3 options (verify current free limits), what runs live vs what is demo-only (chaos-controller disabled in prod), seed data script for a demo, and a 60-90 second demo video script.
Phase 13: LEARNING PACKAGE for me (I'll study after the build):
  - README: pitch, architecture diagram (Mermaid), features, money rules, guarantees, how to run, chaos results, limitations, screenshots placeholders.
  - docs/LEARN.md: a guided tour of the codebase in reading order (which files first and why), each core concept explained simply with the exact file and function where it lives: double-entry posting, holds, idempotency (incl. concurrent duplicates), state machine, saga + compensation, outbox, idempotent consumers, retries/backoff/jitter, circuit breaker, reconciliation, locking and deadlock avoidance, why exactly-once is impossible, chaos test design.
  - docs/FAILURES.md: what happens if each component fails or is slow (each service, Postgres, Redis, Kafka, gateway, network), and how the system recovers.
  - docs/INTERVIEW.md: 50 interview questions with model answers based on how THIS code works, from easy to hard, plus a 2-minute verbal pitch and a 10-minute deep-dive outline.
  - Resume bullets using ONLY measured numbers from the chaos results.
  - Final message to me: what was built, what's verified, known limitations, and what I should study first.
