#!/bin/bash
# Run the demo seed INSIDE the production compose network (the services are not published on the host).
#   ADMIN_TOKEN=... scripts/seed-demo.sh            (reads ADMIN_TOKEN from .env if not set)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${ADMIN_TOKEN:?set ADMIN_TOKEN (or put it in .env)}"
NETWORK="${COMPOSE_NETWORK:-zerodrift-prod_internal}"
IMAGE="${REGISTRY:-}zerodrift-dashboard-api:${TAG:-latest}" # any of our images works: they all contain node
docker run --rm --network "$NETWORK" -v "$PWD/scripts/seed-demo.mjs:/seed.mjs:ro" \
  -e ADMIN_TOKEN -e PAYMENTS_URL=http://payments:3002 -e WEBHOOK_URL=http://webhook:3003 -e LEDGER_URL=http://ledger:3001 \
  -e RECON_URL=http://reconciliation:3004 -e GATEWAY_URL="${SEED_GATEWAY_URL:-http://mock-gateway:3005}" \
  -e WEBHOOK_TARGET="${WEBHOOK_TARGET:-}" -e MERCHANTS -e CUSTOMERS -e PAYMENTS \
  "$IMAGE" node /seed.mjs
