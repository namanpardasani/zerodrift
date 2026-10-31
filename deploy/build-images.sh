#!/bin/bash
# Build the production images (one Dockerfile, one image per service: slim, non-root, production dependencies only).
#   deploy/build-images.sh                       build all runtime services, tag :latest, local names
#   REGISTRY=ghcr.io/you/ TAG=v1 PUSH=1 deploy/build-images.sh    build, tag and push (you must already be logged in)
#   SERVICES="ledger payments" deploy/build-images.sh             only these
# chaos-controller is NOT built by default: it is a development/test tool and must never run in production.
set -euo pipefail
cd "$(dirname "$0")/.."
REGISTRY="${REGISTRY:-}"
TAG="${TAG:-latest}"
SERVICES="${SERVICES:-ledger payments webhook reconciliation mock-gateway dashboard-api demo-shop}"

for s in $SERVICES; do
  image="${REGISTRY}zerodrift-${s}:${TAG}"
  echo "==> building $image"
  for i in 1 2 3 4; do
    docker build -q --build-arg SERVICE="$s" -t "$image" . >/dev/null && break || { echo "   build attempt $i failed (network?), retrying" >&2; sleep 4; }
  done
  docker image inspect "$image" >/dev/null
  if [ -n "${PUSH:-}" ]; then docker push "$image"; fi
done
echo "done: $(for s in $SERVICES; do printf '%szerodrift-%s:%s ' "$REGISTRY" "$s" "$TAG"; done)"
