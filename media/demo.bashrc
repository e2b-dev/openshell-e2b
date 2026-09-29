# Shell profile for the left pane: this is your laptop.
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export XDG_CONFIG_HOME="$PWD/.openshell"   # CLI config pointing at the E2B gateway
openshell() { "$PWD/.bin/openshell" "$@"; } # the stock NVIDIA OpenShell CLI
card() { media/card.sh "$@"; }
set +m   # no job-control noise ([1] 1234 / Done) in the recording
PS1='\[\e[38;5;117m\]you@laptop\[\e[0m\] \[\e[38;5;245m\]$\[\e[0m\] '
clear
