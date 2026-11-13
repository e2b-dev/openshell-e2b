# Repo-local interactive helpers; no shell profile changes.
export STUDIO_DIR=dist/dashboard STUDIO_NAME_PREFIX=gh-demo STUDIO_COMPACT=1 STUDIO_DEMO_DELAY=2500
demo() {
  clear
  if [ "${1:-}" = links ]; then
    node --input-type=module -e 'import {readFileSync} from "node:fs"; const s=JSON.parse(readFileSync("dist/dashboard/state.json")); console.log(`Task: ${s.name}\nA / supervisor: ${s.supervisor}\nB / worker:     ${s.worker}\nControl:        ${s.control}\n\nE2B Console → Sandboxes → sort Started at newest first.\nThe two latest rows are the task pair. Inspect their role metadata.`);'
  elif [ "${1:-}" = ready ]; then
    touch dist/dashboard/console-captured
  else
    node --import tsx --env-file=.env scripts/studio.ts "$@"
  fi
}
# The view commands assume the starting view named in README.md.
ui() {
  case "$1" in
    policy) tmux -L openshell-dashboard send-keys -t dashboard:0.0 Tab Tab Enter ;;
    logs) tmux -L openshell-dashboard send-keys -t dashboard:0.0 l s s ;;
    audit) tmux -L openshell-dashboard send-keys -t dashboard:0.0 PageUp Down Down Down Down Down ;;
    follow) tmux -L openshell-dashboard send-keys -t dashboard:0.0 s G ;;
    home) tmux -L openshell-dashboard send-keys -t dashboard:0.0 Escape; sleep 0.15; tmux -L openshell-dashboard send-keys -t dashboard:0.0 Escape ;;
  esac
}
console_capture() {
  if [ "${DASHBOARD_CAPTURE:-0}" = 1 ]; then
    touch dist/dashboard/console-ready
    while [ ! -f dist/dashboard/console-captured ]; do sleep 1; done
  fi
  echo CONSOLE_READY
}
PS1='\[\e[38;5;117m\]demo\[\e[0m\] $ '
set +m
clear
printf '\033[1;94mOpenShell + E2B · supervisor and worker in separate VMs\033[0m\n\n'
printf 'demo create → fence → policy → requests → sever → cleanup\n'
printf 'Click the native UI above: Tab selects a panel; Enter opens a sandbox.\n'
printf 'Inside a sandbox: [l] logs  [Esc] policy/back. Ctrl-B, D exits.\n'
