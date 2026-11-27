# Shell profile for the manager pane in the agent fleet recording.
cd "$(git rev-parse --show-toplevel)"
# stamp <event>: wall-clock mark for media/agents/compose.ts.
stamp() { perl -MTime::HiRes=time -e 'printf "{\"event\":\"%s\",\"t\":%.3f}\n", $ARGV[0], time' "$1" >> "$AGENTS_MARKS"; }
set +m
PS1='\[\e[38;5;111m\]~/openshell-e2b\[\e[0m\] \[\e[38;5;141m\]❯\[\e[0m\] '
