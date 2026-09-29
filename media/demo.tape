# OpenShell on E2B: demo recording.
#
#   npm run connect -- --new     (terminal 1, keep running)
#   vhs media/demo.tape          (renders media/demo.gif + media/demo.mp4)
#
# Waits for real output instead of fixed sleeps, so pacing follows the actual system.

Output media/demo.gif
Output media/demo.mp4

Require vhs
Set Shell "bash"
Set FontSize 17
Set FontFamily "JetBrains Mono"
Set Width 1400
Set Height 820
Set Padding 28
Set Margin 18
Set MarginFill "#1f2a24"
Set BorderRadius 10
Set WindowBar Colorful
Set Theme "Catppuccin Mocha"
Set TypingSpeed 28ms
Set WaitTimeout 90s

# ---- setup, not recorded ----
Hide
Type `cd ~/Documents/GitHub/openshell-e2b && export XDG_CONFIG_HOME=$PWD/.openshell PS1='\[\e[38;5;208m\]e2b \[\e[0m\]$ ' && os() { .bin/openshell "$@"; } && clear`
Enter
Sleep 1s
Show

# ---- 1. intro ----
Type "# NVIDIA OpenShell: guardrails for AI agents. Here it runs on E2B microVMs."
Enter
Sleep 1.2s
Type "# The CLI talks to a private E2B control box: gateway + our driver."
Enter
Sleep 800ms
Type "os status"
Enter
Wait+Screen /Authenticated \(mTLS/
Sleep 2s

# ---- 2. create ----
Type "# Create a sandbox: our driver starts a fenced E2B microVM for the agent."
Enter
Sleep 800ms
Type "os sandbox create --name demo --no-tty -- sleep infinity &> /dev/null &"
Enter
Sleep 500ms
Type "until os sandbox list | grep -q 'demo .*Ready'; do sleep 1; done; os sandbox list"
Enter
Wait+Screen /demo\s+\S+ \S+\s+Ready/
Sleep 2s

# ---- 3. isolation ----
Type "# Inside: an unprivileged user, zero capabilities, no network of its own."
Enter
Sleep 800ms
Type `os sandbox exec -n demo --no-tty -- sh -c 'id; grep -E "CapEff|NoNewPrivs" /proc/self/status'`
Enter
Wait+Screen /NoNewPrivs:\s+1/
Sleep 2.5s

# ---- 4. default deny ----
Type "# Default deny: GitHub is not in the policy yet."
Enter
Sleep 800ms
Type "os sandbox exec -n demo --no-tty -- curl -sS -m 8 https://api.github.com/zen"
Enter
Wait+Screen /curl: \(\d+\)/
Sleep 2.5s

# ---- 5. policy ----
Hide
Type "os policy get demo --base | sed -n '/^---$/,$p' | sed 1d > /tmp/demo-policy.yaml && printf '\nnetwork_policies:\n  github:\n    name: github-readonly\n    endpoints:\n      - host: api.github.com\n        port: 443\n        protocol: rest\n        enforcement: enforce\n        access: read-only\n    binaries:\n      - path: /usr/bin/curl\n' >> /tmp/demo-policy.yaml && clear"
Enter
Sleep 2s
Show
Type "# Allow api.github.com: read-only, and only for curl."
Enter
Sleep 800ms
Type "tail -11 /tmp/demo-policy.yaml"
Enter
Sleep 3s
Type "os policy set demo --policy /tmp/demo-policy.yaml --wait"
Enter
Wait+Screen /loaded \(active/
Sleep 2s

# ---- 6. enforcement ----
Type "# GET is read-only: allowed."
Enter
Sleep 600ms
Type `os sandbox exec -n demo --no-tty -- curl -sS -m 10 -w '  -> HTTP %{http_code}\n' https://api.github.com/zen`
Enter
Wait+Screen /-> HTTP \d{3}/
Sleep 2s
Type "# POST is a write: blocked by the HTTP-level rule."
Enter
Sleep 600ms
Type `os sandbox exec -n demo --no-tty -- curl -sS -m 10 -o /dev/null -w 'POST -> HTTP %{http_code}\n' -X POST -d '{}' https://api.github.com/gists`
Enter
Wait+Screen /POST -> HTTP \d{3}/
Sleep 2s
Type "# Same host, different program: wget is not in the rule."
Enter
Sleep 600ms
Type `os sandbox exec -n demo --no-tty -- sh -c 'wget -q -T 5 -t 1 -O- https://api.github.com/zen || echo "wget -> $(echo BLOCKED)"'`
Enter
Wait+Screen /wget -> BLOCKED/
Sleep 2s

# ---- 7. audit ----
Type "# Every decision is in the audit log."
Enter
Sleep 600ms
Type `os logs demo 2>/dev/null | grep -E "NET:OPEN|HTTP:" | tail -4 | sed -E 's/^.*\[ocsf\] //' | cut -c1-110`
Enter
Sleep 4s

# ---- 8. cleanup ----
Type "os sandbox delete demo"
Enter
Sleep 4s
Type "# OpenShell policy + E2B microVMs. Driver: sudolabs/openshell-e2b"
Enter
Sleep 3s
