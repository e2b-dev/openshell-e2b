# Project-local shell for the recorded walkthrough.
studio() { node --import tsx --env-file=.env scripts/studio.ts "$@"; }
card() { media/card.sh "$@"; }
PS1='\[\e[38;5;117m\]demo\[\e[0m\] $ '
set +m
clear
card "OpenShell · two private E2B microVMs" \
  "A makes the decisions. B runs the agent." \
  "" "Run: studio create → fence → policy → requests → sever → cleanup" \
  "All commands and side panels use live E2B sandboxes."
