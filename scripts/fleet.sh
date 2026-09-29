#!/usr/bin/env bash
# fleet.sh: one gateway, many workloads. Run `npm run connect` first (in
# another terminal) so the CLI can reach the gateway.
#
#   npm run fleet            3 workloads, deleted at the end
#   npm run fleet -- 5       5 workloads
#   KEEP=1 npm run fleet     leave them running (then: openshell sandbox delete <name>)
#
#   1. create N sandboxes in parallel → N private E2B microVMs, one control box
#   2. each is its own machine       → one E2B box per sandbox, same fence
#   3. per-sandbox policy            → only the first may read api.github.com
#   4. enforcement per sandbox       → first GET 200, the rest denied
#   5. delete
set -euo pipefail
cd "$(dirname "$0")/.."
export XDG_CONFIG_HOME="$PWD/.openshell"
os() { .bin/openshell "$@"; }
in_sandbox() { os sandbox exec -n "$1" --no-tty -- sh -c "$2"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

COUNT="${1:-3}"
PREFIX="fleet-$(date +%H%M%S)"
NAMES=(); for i in $(seq 1 "$COUNT"); do NAMES+=("$PREFIX-$i"); done
FIRST="${NAMES[0]}"
POLICY="$(mktemp)"

cleanup() {
  rm -f "$POLICY"
  [ "${KEEP:-}" = 1 ] && return
  step "5. delete"
  for n in "${NAMES[@]}"; do os sandbox delete "$n" >/dev/null 2>&1 && echo "deleted $n" & done
  wait
}
trap cleanup EXIT

step "1. create $COUNT sandboxes on one gateway"
start=$(date +%s)
# Each create attaches to its `sleep infinity`, so run them in the background.
for n in "${NAMES[@]}"; do (os sandbox create --name "$n" --no-tty -- sleep infinity >/dev/null 2>&1 &); done
until [ "$(os sandbox list 2>/dev/null | grep -c "^$PREFIX-.* Ready")" -ge "$COUNT" ]; do
  [ $(( $(date +%s) - start )) -gt 300 ] && { echo "timed out waiting for Ready"; exit 1; }
  sleep 2
done
echo "all $COUNT Ready after $(( $(date +%s) - start ))s"
os sandbox list | grep -E "^NAME|^$PREFIX-"

step "2. each workload is its own E2B box, same fence"
# The fence hides the E2B sandbox id from the workload, so ask the E2B API:
# the driver tags every box with its OpenShell sandbox name.
npx tsx --env-file=.env scripts/sbx.ts ls | grep " $PREFIX-" | awk '{print $5, "-> E2B box", $1}' | sort
for n in "${NAMES[@]}"; do
  printf '%-20s ' "$n"
  in_sandbox "$n" 'echo "uid=$(id -u) $(grep CapEff /proc/self/status | tr -s "\t" " ")"'
done

step "3. allow api.github.com (read-only, curl) for $FIRST only"
os policy get "$FIRST" --base | sed -n '/^---$/,$p' | sed 1d > "$POLICY"
cat >> "$POLICY" <<'EOF'

network_policies:
  github:
    name: github-readonly
    endpoints:
      - host: api.github.com
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
    binaries:
      - path: /usr/bin/curl
EOF
os policy set "$FIRST" --policy "$POLICY" --wait | tail -1

step "4. enforcement is per sandbox"
for n in "${NAMES[@]}"; do
  printf '%-20s curl GET api.github.com/zen -> ' "$n"
  in_sandbox "$n" 'curl -sS -m 8 -o /dev/null -w "HTTP %{http_code}\n" https://api.github.com/zen 2>&1 | head -1' || true
done
