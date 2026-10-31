#!/bin/bash
# Bring up the whole platform in a local kind cluster. Idempotent: re-run to rebuild/redeploy.
#   deploy/kind/up.sh                 build images, (re)create nothing that exists, deploy infra + app
#   SKIP_BUILD=1 deploy/kind/up.sh    reuse images already built/loaded
#   ONLY="ledger payments" deploy/kind/up.sh   rebuild and roll out just these services
#   deploy/kind/down.sh               delete the cluster
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"
CLUSTER=zerodrift
NS=zerodrift
SERVICES=(ledger payments webhook reconciliation mock-gateway demo-receiver chaos-controller)
[ -n "${ONLY:-}" ] && read -ra SERVICES <<< "$ONLY"
TAG=dev

for t in docker kind kubectl helm; do command -v $t >/dev/null || { echo "missing $t: run scripts/install-tools.sh" >&2; exit 1; }; done

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "==> creating kind cluster"
  kind create cluster --config deploy/kind/kind-config.yaml --wait 180s
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

if [ -z "${SKIP_BUILD:-}" ]; then
  for s in "${SERVICES[@]}"; do
    echo "==> building zerodrift-$s:$TAG"
    for i in 1 2 3 4; do docker build -q --build-arg SERVICE="$s" -t "zerodrift-$s:$TAG" . >/dev/null && break || { echo "   build attempt $i failed (network?), retrying" >&2; sleep 3; }; done
    docker image inspect "zerodrift-$s:$TAG" >/dev/null
  done
fi
for s in "${SERVICES[@]}"; do
  echo "==> loading zerodrift-$s:$TAG into the cluster"
  kind load docker-image "zerodrift-$s:$TAG" --name "$CLUSTER" >/dev/null
done

kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"

echo "==> infrastructure (postgres, kafka, redis, toxiproxy)"
helm upgrade --install infra deploy/helm/zerodrift-infra -n "$NS" \
  --set postgres.nodePort=30432 --set toxiproxy.nodePort=30474 --wait --timeout 8m
echo "==> application"
helm upgrade --install zerodrift deploy/helm/zerodrift -n "$NS" -f deploy/helm/zerodrift/values-kind.yaml --wait --timeout 8m

# The tag never changes (`dev`), so Kubernetes cannot see that an image was rebuilt: restart those deployments.
if [ -z "${SKIP_BUILD:-}" ]; then
  for s in "${SERVICES[@]}"; do kubectl -n "$NS" rollout restart "deploy/$s" >/dev/null; done
  for s in "${SERVICES[@]}"; do kubectl -n "$NS" rollout status "deploy/$s" --timeout=300s; done
fi

echo; kubectl -n "$NS" get pods -o wide | awk '{print $1, $2, $3, $4}' | column -t
echo; echo "Ready. Merchant API http://127.0.0.1:30002   ledger :30001   gateway :30005   receiver :30007   toxiproxy :30474"
