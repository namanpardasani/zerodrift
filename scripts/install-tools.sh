#!/bin/bash
# Installs kind, kubectl, helm and k6 into ~/.local/bin WITHOUT sudo (single static binaries, checksum-verified).
# Re-runnable: skips tools that are already installed. Linux x86_64 only.
#   scripts/install-tools.sh            install what is missing
#   FORCE=1 scripts/install-tools.sh    reinstall everything
set -euo pipefail
BIN="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

fetch() { # url dest  (retries: the network may be flaky)
  for i in 1 2 3 4 5 6; do curl -fsSL -m 300 --retry 2 -o "$2" "$1" && return 0; echo "  download attempt $i failed, retrying" >&2; sleep 2; done
  echo "FAILED to download $1" >&2; return 1
}
latest_tag() { curl -fsSLI -m 30 -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest" | sed 's#.*/tag/##'; }
verify() { # sha256 file
  echo "$1  $2" | sha256sum -c --status - || { echo "CHECKSUM MISMATCH for $2" >&2; exit 1; }
}
have() { [ -z "${FORCE:-}" ] && command -v "$1" >/dev/null 2>&1; }

if have kubectl; then echo "kubectl: already installed ($(kubectl version --client -o yaml 2>/dev/null | grep gitVersion | head -1 | awk '{print $2}'))"; else
  V="$(curl -fsSL -m 30 https://dl.k8s.io/release/stable.txt)"; echo "kubectl $V"
  fetch "https://dl.k8s.io/release/$V/bin/linux/amd64/kubectl" "$TMP/kubectl"
  verify "$(curl -fsSL "https://dl.k8s.io/release/$V/bin/linux/amd64/kubectl.sha256")" "$TMP/kubectl"
  install -m 0755 "$TMP/kubectl" "$BIN/kubectl"
fi

if have kind; then echo "kind: already installed ($(kind version | awk '{print $2}'))"; else
  V="$(latest_tag kubernetes-sigs/kind)"; echo "kind $V"
  fetch "https://github.com/kubernetes-sigs/kind/releases/download/$V/kind-linux-amd64" "$TMP/kind"
  verify "$(curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/$V/kind-linux-amd64.sha256sum" | awk '{print $1}')" "$TMP/kind"
  install -m 0755 "$TMP/kind" "$BIN/kind"
fi

if have helm; then echo "helm: already installed ($(helm version --short))"; else
  V="$(latest_tag helm/helm)"; echo "helm $V"
  fetch "https://get.helm.sh/helm-$V-linux-amd64.tar.gz" "$TMP/helm.tgz"
  verify "$(curl -fsSL "https://get.helm.sh/helm-$V-linux-amd64.tar.gz.sha256sum" | awk '{print $1}')" "$TMP/helm.tgz"
  tar -xzf "$TMP/helm.tgz" -C "$TMP" && install -m 0755 "$TMP/linux-amd64/helm" "$BIN/helm"
fi

if have k6; then echo "k6: already installed ($(k6 version | head -1))"; else
  V="$(latest_tag grafana/k6)"; echo "k6 $V"
  fetch "https://github.com/grafana/k6/releases/download/$V/k6-$V-linux-amd64.tar.gz" "$TMP/k6.tgz"
  SUM="$(curl -fsSL "https://github.com/grafana/k6/releases/download/$V/k6-$V-checksums.txt" | grep "k6-$V-linux-amd64.tar.gz" | awk '{print $1}')"
  verify "$SUM" "$TMP/k6.tgz"
  tar -xzf "$TMP/k6.tgz" -C "$TMP" && install -m 0755 "$TMP/k6-$V-linux-amd64/k6" "$BIN/k6"
fi
# A truncated download can still be a valid-looking file: make sure every binary actually RUNS.
echo
for pair in "kubectl:version --client" "kind:version" "helm:version --short" "k6:version"; do
  t="${pair%%:*}"; args="${pair#*:}"
  if ! out="$("$BIN/$t" $args 2>&1 | head -1)" && ! out="$($t $args 2>&1 | head -1)"; then echo "BROKEN: $t does not run; delete it and re-run" >&2; exit 1; fi
  printf '%-8s %s\n' "$t" "$(command -v $t)"
done
