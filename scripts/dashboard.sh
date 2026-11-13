#!/usr/bin/env bash
# Native OpenShell UI plus live worker telemetry. Owns only its demo task pair.
set -euo pipefail
cd "$(dirname "$0")/.."
export STUDIO_DIR=dist/dashboard STUDIO_NAME_PREFIX=gh-demo STUDIO_COMPACT=1 STUDIO_DEMO_DELAY=2500
mkdir -p "$STUDIO_DIR"
if tmux -L openshell-dashboard has-session -t dashboard 2>/dev/null; then
  echo 'Attach to the existing demo: tmux -L openshell-dashboard attach -t dashboard' >&2
  exit 1
fi
node --import tsx --env-file=.env scripts/studio.ts reset
rm -f "$STUDIO_DIR/console-ready" "$STUDIO_DIR/console-captured"
connector=''
feed=''
finish() {
  result=$?
  if [ -f "$STUDIO_DIR/state.json" ]; then
    if ! node --import tsx --env-file=.env scripts/studio.ts cleanup >"$STUDIO_DIR/cleanup.log" 2>&1; then
      cat "$STUDIO_DIR/cleanup.log" >&2; result=1
    fi
  fi
  tmux -L openshell-dashboard kill-session -t dashboard 2>/dev/null || true
  [ -z "$feed" ] || kill "$feed" 2>/dev/null || true
  [ -z "$connector" ] || kill "$connector" 2>/dev/null || true
  exit "$result"
}
trap finish EXIT
if ! XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1; then
  node --import tsx --env-file=.env scripts/connect.ts >"$STUDIO_DIR/connect.log" 2>&1 &
  connector=$!
  ready=0
  for _ in $(seq 90); do
    if XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1; then ready=1; break; fi
    kill -0 "$connector" 2>/dev/null || { cat "$STUDIO_DIR/connect.log" >&2; exit 1; }
    sleep 1
  done
  [ "$ready" = 1 ] || { echo 'Gateway connection timed out.' >&2; exit 1; }
fi
node --import tsx --env-file=.env scripts/studio.ts supervisor-feed >"$STUDIO_DIR/supervisor-feed.log" 2>&1 &
feed=$!
if [ "${1:-}" = '--record' ]; then
  vhs media/dashboard.tape
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync('dist/dashboard/state.json', 'utf8'));
assert.equal(state.phase, 'deleted');
assert.equal(state.checks.length, 14);
assert(state.frozenHeartbeat);
const audit = readFileSync('dist/dashboard/supervisor-events.jsonl', 'utf8');
assert.match(audit, /HTTP:GET.*ALLOWED/);
assert.match(audit, /HTTP:POST.*DENIED/);
NODE
  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 dist/dashboard/full-speed.mp4)
  rate=$(awk -v duration="$duration" 'BEGIN { printf "%.9f", 45 / duration }')
  ffmpeg -y -hide_banner -loglevel error -i dist/dashboard/full-speed.mp4 -vf "setpts=$rate*PTS" -r 30 -c:v libx264 -preset fast -crf 18 -an -movflags +faststart media/openshell-dashboard-demo.mp4
  echo 'Recorded media/openshell-dashboard-demo.mp4 · 45 seconds · live capture, accelerated'
else
  bash media/dashboard-start.sh
fi
