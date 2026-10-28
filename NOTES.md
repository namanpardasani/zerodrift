# Zerodrift NOTES

## Architecture

## Money rules

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
- Known issues: no GitHub remote yet (waiting for the user's repo URL); Kafka/Redis checks are not in `/ready` yet (added with Phase 4); Grafana dashboards are added in Phase 8; images for kafka/kafka-ui/prometheus/grafana/toxiproxy may still need pulling on a flaky network.
- Next: Phase 2 (ledger-service).
