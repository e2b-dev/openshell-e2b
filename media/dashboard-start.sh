#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export STUDIO_DIR=dist/dashboard STUDIO_NAME_PREFIX=gh-demo STUDIO_COMPACT=1 STUDIO_DEMO_DELAY=2500
SOCKET=openshell-dashboard
tmux -L "$SOCKET" -f media/tmux.conf new-session -d -s dashboard -x "$(tput cols)" -y "$(tput lines)" 'env XDG_CONFIG_HOME="$PWD/.openshell-separated" .bin/openshell term --theme dark'
tmux -L "$SOCKET" split-window -v -t dashboard:0.0 -l 10 'bash --rcfile media/dashboard.bashrc -i'
tmux -L "$SOCKET" split-window -h -t dashboard:0.1 -l 39% 'node --import tsx --env-file=.env scripts/studio.ts worker-feed'
tmux -L "$SOCKET" set-option -g mouse on
tmux -L "$SOCKET" select-pane -t dashboard:0.0 -T 'OPENSHELL · native policy and audit dashboard'
tmux -L "$SOCKET" select-pane -t dashboard:0.1 -T 'DEMO CONTROLS · laptop'
tmux -L "$SOCKET" select-pane -t dashboard:0.2 -T 'WORKER B · independent live observation'
tmux -L "$SOCKET" select-pane -t dashboard:0.1
exec tmux -L "$SOCKET" attach -t dashboard
