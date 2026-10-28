# Zerodrift NOTES

## Architecture

## Money rules

## Decisions and tradeoffs

- **GitHub remote (overrides brief "never push")**: on 2026-10-28 the user explicitly asked to push everything to their GitHub repo and keep it updated. Rule from now: push after every phase commit (and big milestones) once the remote exists. Remote URL and auth are supplied by the user; tokens are never pasted into chat or committed.
- **Kafka client: @confluentinc/kafka-javascript** (v1.11.0, last release 2026-10-07). KafkaJS 2.2.4 was last published 2023-02-27, so it is effectively unmaintained.
- **Circuit breaker: opossum** v10.0.0 (published 2026-08-03).
- **DB layer: Kysely** (v0.29.7, active as of 2026-10-17); chosen over Drizzle for explicit SQL control (`FOR UPDATE`, isolation levels) in the ledger.
- Other verified versions: NestJS 12.3.2, zod 4.6.7, pino 10.4.0. (Pin exact versions at install time.)

## What happens if X fails

## Chaos results

## Interview Q&A

## Progress log

### Phase 0: scaffolding (2026-10-28)
- Done: PROJECT_BRIEF.md, CLAUDE.md, NOTES.md, .gitignore.
- Environment findings: Node v24.21.0 and pnpm 12.15.0 present. **Docker, kind, helm, kubectl, k6 are NOT installed in this WSL distro** (Docker Desktop WSL integration is off).
- Update: Docker 29.8.2 + Compose v5.5.1 now working (hello-world ran). kind, helm, kubectl, k6 still need installing before Phase 9. No SSH key exists in ~/.ssh; GitHub remote not yet provided.
- Next: Phase 1 (monorepo, shared packages, Compose, service skeletons, CI).
