# Shell profile for the OpenClaw video scenes (sourced, hidden, at the start of each tape).
cd "$(git rev-parse --show-toplevel)"
claw() { node --import tsx --env-file=.env scripts/openclaw-demo.ts "$@"; }
# stamp <event>: wall-clock mark so compose.ts can find the waits in each clip.
stamp() { perl -MTime::HiRes=time -e 'printf "{\"event\":\"%s\",\"t\":%.3f}\n", $ARGV[0], time' "$1" >> "$CLAW_MARKS"; }
set +m
PS1='\[\e[38;5;111m\]~/openshell-e2b\[\e[0m\] \[\e[38;5;141m\]❯\[\e[0m\] '
