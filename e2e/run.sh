#!/bin/bash
# Run the browser smoke test against the running compose stack, inside a container.
#   e2e/run.sh                       # checks only
#   SCREENSHOTS=./screenshots/x e2e/run.sh   # also saves a PNG per page
set -e
cd "$(dirname "$0")/.."
NETWORK="${COMPOSE_NETWORK:-zerodrift_default}"
for i in 1 2 3 4 5; do docker build -q -t zerodrift-e2e e2e && break || { echo "build attempt $i failed (network?), retrying"; sleep 3; }; done
ARGS=(--rm --network "$NETWORK" -e DASHBOARD_URL=http://dashboard-api:3008 -e SHOP_URL=http://demo-shop:3009)
if [ -n "$SCREENSHOTS" ]; then
  mkdir -p "$SCREENSHOTS"
  ARGS+=(-e SCREENSHOTS=/shots -v "$(cd "$SCREENSHOTS" && pwd)":/shots)
fi
docker run "${ARGS[@]}" zerodrift-e2e
