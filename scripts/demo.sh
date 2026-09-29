#!/usr/bin/env bash
# demo.sh: the OpenShell-on-E2B demo, step by step. Run `npm run connect` first
# (in another terminal) so the CLI can reach the gateway.
#
#   1. create a sandbox        → a fenced E2B microVM, policed by OpenShell
#   2. show the isolation      → uid 1500, zero capabilities, no network of its own
#   3. default deny            → unlisted host doesn't resolve, raw TCP is blocked
#   4. allow GitHub read-only  → for curl only
#   5. enforcement             → GET 200, POST 403, other programs denied
#   6. audit log               → OCSF allow/deny records
#   7. delete
set -euo pipefail
cd "$(dirname "$0")/.."
export XDG_CONFIG_HOME="$PWD/.openshell"
os() { .bin/openshell "$@"; }
in_sandbox() { os sandbox exec -n "$NAME" --no-tty -- sh -c "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

NAME="${1:-demo-$(date +%H%M%S)}"
POLICY="$(mktemp)"

step "1. create sandbox '$NAME'"
start=$(date +%s)
# The main process is `sleep infinity`; create attaches to it, so run it in the background.
(os sandbox create --name "$NAME" --no-tty -- sleep infinity >/dev/null 2>&1 &)
until os sandbox list 2>/dev/null | grep -q "^$NAME .*Ready"; do sleep 1; done
echo "Ready after $(( $(date +%s) - start ))s"
os sandbox list | grep -E "^NAME|^$NAME "

step "2. isolation inside the sandbox"
in_sandbox 'echo "identity:  uid=$(id -u) gid=$(id -g)"; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status; echo "kernel:    $(uname -r) (E2B)"'

step "3. default deny"
in_sandbox 'printf "curl api.github.com (not in policy) -> "; curl -sS -m 8 -o /dev/null https://api.github.com/zen 2>&1 | head -1
  printf "raw TCP to 1.1.1.1:443           -> "; bash -c "echo > /dev/tcp/1.1.1.1/443" 2>/dev/null && echo CONNECTED || echo blocked'

step "4. allow api.github.com, read-only, for curl only"
os policy get "$NAME" --base | sed -n '/^---$/,$p' | sed 1d > "$POLICY"
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
os policy set "$NAME" --policy "$POLICY" --wait | tail -1

step "5. enforcement"
in_sandbox '
  printf "curl GET  api.github.com/zen   -> "; curl -sS -m 10 -o /tmp/z -w "HTTP %{http_code}" https://api.github.com/zen; echo "  \"$(cat /tmp/z)\""
  printf "curl POST api.github.com/gists -> "; curl -sS -m 10 -o /dev/null -w "HTTP %{http_code}\n" -X POST -d "{}" https://api.github.com/gists
  printf "wget GET  api.github.com/zen   -> "; wget -q -T 5 -t 1 -O /dev/null https://api.github.com/zen && echo allowed || echo denied
'

step "6. audit log (OCSF)"
os logs "$NAME" 2>/dev/null | grep -E "NET:OPEN|HTTP:" | tail -5 | cut -c1-160

step "7. delete"
os sandbox delete "$NAME"
rm -f "$POLICY"
