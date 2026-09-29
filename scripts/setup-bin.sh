#!/usr/bin/env bash
# setup-bin.sh: download the laptop-side tools into .bin/ (gitignored).
#   openshell   NVIDIA's CLI, same version as the control plane
#   wstunnel    tunnel client used by scripts/connect.ts
set -euo pipefail
cd "$(dirname "$0")/.."
OPENSHELL_TAG="${OPENSHELL_TAG:-v0.1.2}"
WSTUNNEL_VERSION="11.0.0"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  os_target=aarch64-apple-darwin;      ws_target=darwin_arm64 ;;
  Linux-x86_64)  os_target=x86_64-unknown-linux-musl; ws_target=linux_amd64 ;;
  Linux-aarch64) os_target=aarch64-unknown-linux-musl; ws_target=linux_arm64 ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p .bin
curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_TAG}/openshell-${os_target}.tar.gz" | tar xz -C .bin openshell
curl -fsSL "https://github.com/erebe/wstunnel/releases/download/v${WSTUNNEL_VERSION}/wstunnel_${WSTUNNEL_VERSION}_${ws_target}.tar.gz" | tar xz -C .bin wstunnel
chmod +x .bin/openshell .bin/wstunnel
.bin/openshell --version
.bin/wstunnel --version
