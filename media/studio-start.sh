#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
SOCKET=openshell-studio
tmux -L "$SOCKET" -f media/tmux.conf new-session -d -s studio -x "$(tput cols)" -y "$(tput lines)" "bash --rcfile media/studio.bashrc -i"
tmux -L "$SOCKET" split-window -h -t studio:0.0 -l 43% "node --import tsx --env-file=.env scripts/studio.ts supervisor-feed"
tmux -L "$SOCKET" split-window -v -t studio:0.1 -l 45% "node --import tsx --env-file=.env scripts/studio.ts worker-feed"
tmux -L "$SOCKET" select-pane -t studio:0.0 -T "LIVE WALKTHROUGH · laptop"
tmux -L "$SOCKET" select-pane -t studio:0.1 -T "A / SUPERVISOR · remote audit"
tmux -L "$SOCKET" select-pane -t studio:0.2 -T "B / WORKER · live kernel state"
tmux -L "$SOCKET" select-pane -t studio:0.0
exec tmux -L "$SOCKET" attach -t studio
