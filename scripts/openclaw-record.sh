#!/usr/bin/env bash
# Record the OpenClaw video: connect if needed, record the scenes live, verify the
# audit, edit the clips, and always clean up the sandbox.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist/openclaw-demo
claw() { node --import tsx --env-file=.env scripts/openclaw-demo.ts "$@"; }
connector=''
finish() {
  result=$?
  claw cleanup >dist/openclaw-demo/cleanup.log 2>&1 || { cat dist/openclaw-demo/cleanup.log >&2; result=1; }
  if [ -n "$connector" ]; then kill "$connector" 2>/dev/null || true; fi
  exit "$result"
}
trap finish EXIT
claw cleanup >/dev/null 2>&1 || true
if ! XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1; then
  OPENSHELL_WORKLOAD_TEMPLATE=openshell-workload-openclaw \
    node --import tsx --env-file=.env scripts/connect.ts >dist/openclaw-demo/connect.log 2>&1 &
  connector=$!
  for _ in $(seq 90); do
    XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1 && break
    kill -0 "$connector" 2>/dev/null || { cat dist/openclaw-demo/connect.log >&2; exit 1; }
    sleep 1
  done
fi
node --import tsx --env-file=.env media/openclaw/record.ts
# Waits stop on real output. Refuse to publish a run whose audit lacks any of the three outcomes.
claw check
node --import tsx media/openclaw/compose.ts
