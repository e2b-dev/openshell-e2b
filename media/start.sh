#!/usr/bin/env bash
# start.sh: the two-pane layout the recording runs in.
#   left:  your laptop, running the openshell CLI
#   right: the live event feed from the E2B control plane (npm run watch -- --compact)
cd "$(dirname "$0")/.."
tmux kill-session -t demo 2>/dev/null
tmux -f media/tmux.conf new-session -d -s demo -x "$(tput cols)" -y "$(tput lines)" "bash --rcfile media/demo.bashrc -i"
tmux split-window -h -t demo -l 42% "npm run -s watch -- --compact; read"
tmux select-pane -t demo:0.0 -T "YOUR LAPTOP · openshell CLI"
tmux select-pane -t demo:0.1 -T "E2B CONTROL PLANE · live"
tmux select-pane -t demo:0.0
exec tmux attach -t demo
