#!/bin/bash
# One command to a working local Zerodrift:
#   pnpm start:local            build if needed, start, wait until every service is ready, seed demo data once, print URLs and logins
#   BUILD=0 pnpm start:local    reuse the images you already built (much faster)
#   SEED=force pnpm start:local add another batch of demo data   |   SEED=0 skips seeding
#   FULL=1 pnpm start:local     also start Grafana, Prometheus, Jaeger and Kafka UI (about 1 GB more memory; off by default)
#   pnpm stop:local             stop it (data is kept)
set -uo pipefail
cd "$(dirname "$0")/.."
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"

if [ "${BUILD:-1}" = "0" ]; then ARGS="up -d"; else ARGS="up -d --build"; fi
if [ -n "${FULL:-}" ]; then export OTEL_ENDPOINT=http://jaeger:4318; ARGS="--profile observability $ARGS"; fi
echo "==> starting the stack (docker compose $ARGS)"
for i in 1 2 3 4; do docker compose $ARGS && break || { echo "   attempt $i failed (network or Docker credentials?), retrying" >&2; sleep 6; }; done

echo "==> waiting until every service is ready"
SERVICES="ledger:3001 payments:3002 webhook:3003 reconciliation:3004 mock-gateway:3005 dashboard-api:3008 demo-shop:3009"
for i in $(seq 1 90); do
  pending=""
  for s in $SERVICES; do curl -sf -m 3 "http://localhost:${s##*:}/ready" >/dev/null 2>&1 || pending="$pending ${s%%:*}"; done
  [ -z "$pending" ] && break
  [ $((i % 5)) -eq 0 ] && echo "   still waiting for:$pending"
  sleep 3
done
if [ -n "$pending" ]; then echo "NOT READY:$pending  (see: docker compose logs --tail=50 <service>)" >&2; exit 1; fi
echo "   all services ready"

count=$(curl -s -m 10 -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3002/admin/stats" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(Object.values(j.byStatus||{}).reduce((a,b)=>a+b,0))}catch{console.log('?')}})")
if [ "${SEED:-auto}" = "force" ] || { [ "${SEED:-auto}" = "auto" ] && [ "$count" = "0" ]; }; then
  echo "==> seeding demo data"
  ADMIN_TOKEN="$ADMIN_TOKEN" LEDGER_URL=http://localhost:3001 RECON_URL=http://localhost:3004 GATEWAY_URL=http://localhost:3005 node scripts/seed-demo.mjs | sed 's/^/   /' | tail -14
else
  echo "==> not seeding ($count payments already exist; SEED=force adds more)"
fi

cat <<MSG

Zerodrift is running.
  Landing page        http://localhost:3008
  Operator console    http://localhost:3008/app        login: admin / zerodrift
  Demo shop           http://localhost:3009            no login: click "+₹1,000.00", add an item, Pay from wallet
  Chaos bench         http://localhost:3008/app/chaos  (inside the console)
  Grafana / Jaeger    only with FULL=1:  http://localhost:3000   http://localhost:16686
  Admin token         $ADMIN_TOKEN        (header x-admin-token)
Manual test guide:    docs/MANUAL_TEST.md      Automated feature check: pnpm verify:features
MSG
