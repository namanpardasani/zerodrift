# Deploying Zerodrift (preparation guide)

> Nothing here has been deployed, and no cloud account has been created. Everything below was prepared and **verified locally**:
> the production Compose stack was booted in `NODE_ENV=production` and passed its public-surface checks, the demo seed ran
> against it, and the production Helm values are checked by `pnpm verify:prod`. Free-tier facts were checked on **31 Oct 2026**
> (sources at the end); free tiers change often, so re-check the one you pick before you rely on it.

## 1. What runs live, and what is demo-only

| Component | In a live deployment? | Why |
|---|---|---|
| ledger, payments, webhook, reconciliation | **live** | the product |
| dashboard-api (landing page + operator console) | **live** | the public face and the operator tool; it has its own login |
| Postgres, Kafka, Redis | **live** | state, events, rate limits |
| **mock-gateway** | demo bank | stands in for a real payment gateway. A real deployment replaces it with an adapter for a real PSP. Its fault-injection API is unauthenticated, so it stays on the private network (the Caddyfile and the Ingress never route to it) |
| **demo-shop** | demo only | shows how a merchant integrates. Remove it for a pure API deployment |
| demo-receiver | test only | receives webhooks in tests; not in the production files |
| **chaos-controller** | **never in production** | it kills things on purpose. It is not in the production Compose file, it refuses to start when `NODE_ENV=production`, and the Helm chart refuses to render it with `nodeEnv: production`. Without it the console hides the chaos bench |
| Toxiproxy, Jaeger, Prometheus, Grafana, Kafka UI | test / optional | test-time fault injection and observability; not in the production files (add Prometheus/Grafana from `infra/` if you want dashboards) |

The chaos **results** stay on the landing page as measured numbers; the chaos **tool** does not ship.

## 2. How big a machine

Measured on the production Compose stack right after the demo seed (80 payments), one replica of each service:
**about 1.15 GiB in total** (Kafka 335 MiB, payments 167, ledger 136, reconciliation 123, mock-gateway 119, webhook 102, dashboard-api 97, Postgres 77, demo-shop 36, Caddy 21, Redis 5).
A machine with **2 GB of RAM works for a demo; 4 GB gives headroom** for load and for building the images on the box. One vCPU is slow
but sufficient for a demo; two is comfortable. Disk: a few GB. (The numbers during the 10,000-operation chaos runs on the Kubernetes
replicas were higher; those runs are not a demo workload.)

## 3. Options

There is no free Kafka to be had (see option C), so every free route is "one free or credit-funded virtual machine running the whole
stack". That is also the simplest thing that is honest about what this project is.

### Option A (recommended): one VM + `docker compose` + Caddy

The files: [`deploy/compose/docker-compose.prod.yml`](../deploy/compose/docker-compose.prod.yml), [`deploy/compose/Caddyfile`](../deploy/compose/Caddyfile),
[`.env.example`](../.env.example). Caddy obtains and renews free HTTPS certificates by itself; only ports 80/443 are open; everything else is on a private
Docker network. Where to get the VM for free:

| VM source | What was verified (31 Oct 2026) | Catch |
|---|---|---|
| **Azure for Students** | $100 credit, **no credit card**, valid one year and renewable while you are an active student; you must be 18+ and verify with your college e-mail (Microsoft Learn: *What is Azure for Students?*). The GitHub Student Developer Pack lists the same $100 | the credit is money, not free hours: pick the smallest VM with >= 2 to 4 GB RAM and look up its monthly price in the Azure pricing calculator (not checked here). When the credit or the year ends, resources are shut down unless you upgrade to pay-as-you-go |
| **Oracle Cloud Always Free (Ampere A1)** | the allowance was **cut in June 2026 from 4 OCPU / 24 GB to 2 OCPU / 12 GB** across all A1 instances (effective 15 Jun 2026, with no announcement, according to InfoQ; Oracle's own page could not be fetched here). 12 GB is far more than the 1.15 GiB measured | capacity errors ("Out of host capacity") are common; usage above the allowance can be billed or shut down. Check the Always Free page and the sign-up requirements yourself before relying on it |

Steps (about 30 minutes; nothing below is automated on purpose, because it needs your account):

1. Create the VM (Ubuntu 24.04 LTS, >= 2 GB RAM), open inbound TCP **80 and 443** (and 22 for SSH from your address only).
2. Install Docker Engine and the Compose plugin from Docker's own apt repository (`docs.docker.com/engine/install/ubuntu`).
3. Get three hostnames pointing at the VM's public IP (DNS A records): your own domain, or a free dynamic-DNS name. They are `CONSOLE_HOST`, `SHOP_HOST`, `API_HOST` in `.env`.
4. `git clone https://github.com/namanpardasani/zerodrift && cd zerodrift && cp .env.example .env`, fill every secret (the `openssl` command is next to each), set the three hosts.
5. Build the images on the VM: `deploy/build-images.sh` (the first build is slow on a small machine; or build on your laptop with `REGISTRY=ghcr.io/you/ TAG=v1 PUSH=1 deploy/build-images.sh` and set `REGISTRY`/`TAG` in `.env`).
6. `docker compose -f deploy/compose/docker-compose.prod.yml --env-file .env up -d`. Wait until `docker compose ... ps` shows everything healthy.
7. Check the public surface: `CONSOLE_URL=https://<console host> SHOP_URL=https://<shop host> API_URL=https://<api host> node scripts/verify-prod-stack.mjs` (or the same command from a container with Node). It must end with "The public surface is as intended".
8. Seed demo data: `WEBHOOK_TARGET=https://<shop host>/webhooks scripts/seed-demo.sh`. It prints each merchant's API key once; store them.
9. Open `https://<console host>`, sign in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.

Day-2 notes:
- **Backups:** `docker compose ... exec postgres pg_dump -U zerodrift <db>` for each of the five databases (cron it). Postgres is the source of truth; Kafka only carries events that the outbox tables can re-derive operationally, but keep its volume anyway.
- **Updates:** `git pull && deploy/build-images.sh && docker compose ... up -d` (services roll one by one; migrations run at start-up).
- **Secrets:** changing `WEBHOOK_ENCRYPTION_KEY` makes stored webhook secrets unreadable, rotate it only with a plan. `ADMIN_TOKEN` and `JWT_SECRET` can be rotated by restarting.
- **If it falls over:** [`docs/FAILURES.md`](FAILURES.md) (written in the learning package) says what each failure looks like and how the system recovers.

### Option B: demo from your own laptop, shared through a tunnel (zero cost, zero account)

Run the stack locally (`docker compose up -d --build`, development files) and expose only what a viewer needs through a **Cloudflare Quick Tunnel**
(`cloudflared tunnel --url http://localhost:3008`). Verified: no Cloudflare account or domain is needed, it is free, but it is for testing only: no uptime guarantee,
a new random address every time, at most 200 in-flight requests, no Server-Sent Events, and it is public unless you add the `--allowed-mail` check. Good for a live walk-through in an interview or for recording the demo video; not a place to leave running.
(The development stack uses development secrets: never leave it reachable. Use option A for anything that stays up.)

### Option C: split across free managed services (not recommended as the main route)

| Piece | Free option | Verified limits | Problem |
|---|---|---|---|
| Postgres | Neon free plan | 100 compute-hours per project per month, no time limit, no card; storage 0.5 GB (pricing page) or 1 GB (changelog of 2 Oct 2026): the sources disagree | compute stops when the monthly hours run out and scales to zero when idle. Zerodrift's recovery and sweeper jobs poll all the time, so the compute would never idle: 100 CU-hours is only about 16 days of always-on at the smallest size (0.25 CU, my assumption: check), less than a month. Five databases would need care |
| Redis | Upstash free | 256 MB and 500,000 commands per month | fine for rate limiting (and Zerodrift fails open without it) |
| Kafka | **none** | Upstash Kafka was discontinued on 11 Mar 2025. Redpanda Serverless and Confluent Cloud offer trial credits that expire (about two weeks to a month) | no permanent free Kafka. You would self-host it anyway (option A), and the client code would also need SASL/TLS support that this project does not have yet |

Use it only as a way to learn managed Postgres; the VM in option A is simpler and cheaper.

### What a real-money deployment would still need (honest list)

A real payment gateway adapter in place of the mock bank, PCI-DSS scope analysis (never store card data: use the gateway's hosted fields), KYC/AML for merchants,
multi-node Postgres with automated failover and point-in-time recovery, Kafka with replication factor 3 (the chart and compose use 1), network policies and a WAF,
secret management in a vault, audit-log shipping off-box, on-call and alerting. None of it changes the money rules; all of it is outside a free demo.

## 4. Kubernetes route (also prepared, also not deployed)

[`deploy/helm/zerodrift/values-prod.yaml`](../deploy/helm/zerodrift/values-prod.yaml) is a production-shaped example (managed dependencies, an Ingress that routes only
`/v1` on the API host, secrets from an existing Secret, no chaos controller, no NodePorts, non-root read-only containers, PodDisruptionBudgets).
`pnpm verify:prod` renders it and checks all of that (and that the chart **refuses** `chaos-controller` with `nodeEnv: production`, a console without secrets, and a shop without a public URL).
The same flow works on a small k3s cluster on the VM from option A, but plain Compose is less to run for a demo.

## 5. Before you point real traffic at it (checklist)

- [ ] every secret generated, none reused from development; `.env` is not committed (`.gitignore` ignores it)
- [ ] `node scripts/verify-prod-stack.mjs` passes against the public hostnames
- [ ] the dashboard password is long; the console login throttle is on (default)
- [ ] ports other than 22/80/443 are closed at the cloud firewall
- [ ] `pg_dump` cron in place and one restore tested
- [ ] `pnpm audit:deps` is clean for what ships (it was on 1 Nov 2026: 245 package versions, no known vulnerabilities; it falls back to OSV.dev if npm's advisory endpoint is unreachable; run it again right before you deploy)
- [ ] you ran `pnpm verify:features` and walked through `docs/MANUAL_TEST.md` on your machine
- [ ] you know this is a portfolio project: it does not move real money

## Sources (checked 31 Oct 2026)

- Oracle Always Free cut: [InfoQ, "Oracle Cloud free tier limits"](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/); other reports: [terminalbytes](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026), [braindetox](https://braindetox.kr/en/posts/oracle_always_free_tier_reduced_2026.html)
- Azure for Students: [Microsoft Learn: What is Azure for Students?](https://learn.microsoft.com/en-us/azure/education-hub/about-azure-for-students), [Azure for Students](https://azure.microsoft.com/en-in/free/students), [GitHub Student Developer Pack](https://education.github.com/pack)
- Neon: [pricing](https://neon.com/pricing) and [jetadmin summary](https://www.jetadmin.io/blog/neon-pricing/)
- Upstash: [Upstash vs Redis Cloud, 2026](https://upstash.com/blog/upstash-vs-redis-cloud-a-2026-comparison); Kafka deprecation: [Upstash blog](https://upstash.com/blog/kafka-connectors-deprecation), [Fly.io community notice](https://community.fly.io/t/deprecation-notice-for-upstash-kafka/21775)
- Redpanda: [pricing](https://redpanda.com/pricing); Confluent: [pricing](https://confluent.io/pricing)
- Cloudflare: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
