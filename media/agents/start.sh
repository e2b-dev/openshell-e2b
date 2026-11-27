#!/usr/bin/env bash
# Opens the recording layout: the manager on top, a live pane per worker below.
set -euo pipefail
cd "$(dirname "$0")/../.."
SOCKET=openshell-agents
mkdir -p dist/agents/live
for n in 1 2 3; do : > "dist/agents/live/$n.log"; done
pane() { echo "clear; tail -n +1 -F dist/agents/live/$1.log 2>/dev/null"; }
tmux -L "$SOCKET" -f media/agents/tmux.conf new-session -d -s agents -x "$(tput cols)" -y "$(tput lines)" "bash --rcfile media/agents/shell.bashrc -i"
tmux -L "$SOCKET" split-window -v -t agents:0.0 -l 58% "$(pane 1)"
tmux -L "$SOCKET" split-window -h -t agents:0.1 -l 67% "$(pane 2)"
tmux -L "$SOCKET" split-window -h -t agents:0.2 -l 50% "$(pane 3)"
tmux -L "$SOCKET" select-pane -t agents:0.0 -T "MANAGER · your laptop" \; set -p -t agents:0.0 @color "#7aa2f7"
tmux -L "$SOCKET" select-pane -t agents:0.1 -T "1 · CLAUDE CODE · E2B VM pair" \; set -p -t agents:0.1 @color "#e0af68"
tmux -L "$SOCKET" select-pane -t agents:0.2 -T "2 · CLAUDE CODE · E2B VM pair" \; set -p -t agents:0.2 @color "#e0af68"
tmux -L "$SOCKET" select-pane -t agents:0.3 -T "3 · CODEX · E2B VM pair" \; set -p -t agents:0.3 @color "#7dcfff"
tmux -L "$SOCKET" select-pane -t agents:0.0
# After the fleet cleans up, zoom the manager pane so the summary reads full width.
if [ -n "${AGENTS_MARKS:-}" ]; then
  (
    until grep -q '"cleaned"' "$AGENTS_MARKS" 2>/dev/null; do sleep 0.3; done
    sleep 1.5
    perl -MTime::HiRes=time -e 'printf "{\"event\":\"zoom\",\"t\":%.3f}\n", time' >> "$AGENTS_MARKS"
    tmux -L "$SOCKET" resize-pane -Z -t agents:0.0
  ) >/dev/null 2>&1 &
fi
exec tmux -L "$SOCKET" attach -t agents
