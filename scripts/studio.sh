#!/usr/bin/env bash
# Reproducible three-pane demo; only this studio task is cleaned up on exit.
set -euo pipefail
cd "$(dirname "$0")/.."
if tmux -L openshell-studio has-session -t studio 2>/dev/null; then
  echo 'A studio session is already open. Attach with: tmux -L openshell-studio attach' >&2
  exit 1
fi
mkdir -p dist/studio
node --import tsx --env-file=.env scripts/studio.ts reset
connector=''
finish() {
  result=$?
  if [ -f dist/studio/state.json ]; then
    if ! node --import tsx --env-file=.env scripts/studio.ts cleanup >dist/studio/cleanup.log 2>&1; then
      cat dist/studio/cleanup.log >&2
      result=1
    fi
  fi
  tmux -L openshell-studio kill-session -t studio 2>/dev/null || true
  if [ -n "$connector" ]; then kill "$connector" 2>/dev/null || true; fi
  exit "$result"
}
trap finish EXIT
if ! XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1; then
  node --import tsx --env-file=.env scripts/connect.ts >dist/studio/connect.log 2>&1 &
  connector=$!
  ready=0
  for _ in $(seq 90); do
    if XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell status >/dev/null 2>&1; then ready=1; break; fi
    kill -0 "$connector" 2>/dev/null || { cat dist/studio/connect.log >&2; exit 1; }
    sleep 1
  done
  [ "$ready" = 1 ] || { echo 'Gateway connection timed out.' >&2; exit 1; }
fi
if [ "${1:-}" = '--record' ]; then
  vhs media/separated-supervisor.tape
  # Tape waits stop on real results. Refuse to publish an incomplete run.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync('dist/studio/state.json', 'utf8'));
assert.equal(state.phase, 'deleted');
assert.equal(state.checks.length, 14);
assert(state.frozenHeartbeat);
const audit = readFileSync('dist/studio/supervisor-events.jsonl', 'utf8');
assert.match(audit, /HTTP:GET.*ALLOWED/);
assert.match(audit, /HTTP:POST.*DENIED/);
NODE
  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 dist/studio/full-speed.mp4)
  rate=$(awk -v duration="$duration" 'BEGIN { printf "%.9f", 45 / duration }')
  ffmpeg -y -hide_banner -loglevel error -i dist/studio/full-speed.mp4 -vf "setpts=$rate*PTS" -r 30 -c:v libx264 -preset fast -crf 18 -an -movflags +faststart media/separated-supervisor-demo.mp4
  echo 'Recorded: media/separated-supervisor-demo.mp4 (45 seconds, 1080p; accelerated live capture)'
else
  bash media/studio-start.sh
fi
