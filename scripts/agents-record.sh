#!/usr/bin/env bash
# Record the agent fleet video: connect if needed, record the live run, check the
# fleet report, then edit the clip into media/agents-demo.mp4.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=dist/agents-video
rm -rf "$OUT" && mkdir -p "$OUT"
export AGENTS_MARKS="$PWD/$OUT/marks.jsonl"
connector=''
finish() {
  result=$?
  tmux -L openshell-agents kill-server 2>/dev/null || true
  if [ -n "$connector" ]; then kill "$connector" 2>/dev/null || true; fi
  exit "$result"
}
trap finish EXIT
if ! XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1; then
  OPENSHELL_WORKLOAD_TEMPLATE=openshell-workload-agents \
    node --import tsx --env-file=.env scripts/connect.ts >"$OUT/connect.log" 2>&1 &
  connector=$!
  for _ in $(seq 90); do
    XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1 && break
    kill -0 "$connector" 2>/dev/null || { cat "$OUT/connect.log" >&2; exit 1; }
    sleep 1
  done
fi
vhs media/agents/agents.tape
# Refuse to publish a run where any worker failed.
report=$(ls -t dist/agents/agents-*.json | head -1)
node -e "const r=require('./$report'); if(!r.results.every(x=>x.fixed&&x.agentExit===0&&!x.error)){console.error('fleet run failed: $report');process.exit(1)} console.log('fleet run OK: $report')"
node --import tsx media/agents/compose.ts
