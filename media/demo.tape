# OpenShell on E2B: demo recording (split screen).
#
#   left pane:  your laptop, running the stock NVIDIA `openshell` CLI
#   right pane: the live event feed from the E2B control plane
#
#   npm run connect -- --new     (terminal 1, keep running)
#   vhs media/demo.tape          (renders media/demo.mp4 + media/demo.gif)
#
# Waits match left-pane output only, so the live feed can't trigger them.

Output media/demo.mp4
Output media/demo.gif

Require vhs
Require tmux
Require gum
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 19
Set LineHeight 1.25
Set Width 1920
Set Height 1080
Set Padding 20
Set Margin 24
Set MarginFill "#11111b"
Set BorderRadius 12
Set WindowBar Colorful
Set Theme "Catppuccin Mocha"
Set TypingSpeed 32ms
Set WaitTimeout 90s
Set Framerate 30

# ---- layout: tmux with two titled panes (not recorded) ----
Hide
Type "media/start.sh"
Enter
Sleep 4s
Type `card "OpenShell on E2B" "NVIDIA's guardrails for AI agents, running in E2B microVMs." "" "Left: your laptop with the normal openshell CLI." "Right: what happens in the E2B control plane, live."`
Enter
Sleep 500ms
Show
Sleep 5s

# ---- 1. connected ----
Hide
Type `card "You stay on your laptop" "The gateway runs in a private E2B box. The CLI reaches it through an mTLS tunnel."`
Enter
Sleep 400ms
Show
Sleep 1.5s
Type "openshell status"
Enter
Wait+Screen /Authenticated \(mTLS/
Sleep 3s

# ---- 2. create ----
Hide
Type `card "1  Create a sandbox" "Our driver starts a fenced E2B microVM for the agent." "Watch it appear on the right."`
Enter
Sleep 400ms
Show
Sleep 1.5s
Type "(openshell sandbox create --name demo --no-tty -- sleep infinity < /dev/null &> /dev/null &)"
Enter
Sleep 300ms
Type "until openshell sandbox list | grep -q 'demo .*Ready'; do sleep 1; done"
Enter
Sleep 300ms
Type "openshell sandbox list"
Enter
Wait+Screen /demo\s+\d{4}-\d\d-\d\d \S+\s+Ready/
Sleep 3.5s

# ---- 3. inside ----
Hide
Type `card "2  Look inside" "Unprivileged user, zero capabilities, no network of its own."`
Enter
Sleep 400ms
Show
Sleep 1.5s
Type `openshell sandbox exec -n demo --no-tty -- sh -c 'id; grep -E "CapEff|NoNewPrivs" /proc/self/status'`
Enter
Wait+Screen /NoNewPrivs:\s+1/
Sleep 3.5s

# ---- 4. default deny ----
Hide
Type `card "3  Default deny" "GitHub is not in the policy yet."`
Enter
Sleep 400ms
Show
Sleep 1.5s
Type "openshell sandbox exec -n demo --no-tty -- curl -sS -m 8 https://api.github.com/zen"
Enter
Wait+Screen /curl: \(\d+\)/
Sleep 3.5s

# ---- 5. policy ----
Hide
Type "openshell policy get demo --base | sed -n '/^---$/,$p' | sed 1d > /tmp/demo-policy.yaml && printf '\nnetwork_policies:\n  github:\n    name: github-readonly\n    endpoints:\n      - host: api.github.com\n        port: 443\n        protocol: rest\n        enforcement: enforce\n        access: read-only\n    binaries:\n      - path: /usr/bin/curl\n' >> /tmp/demo-policy.yaml"
Enter
Sleep 2s
Type `card "4  Allow GitHub: read-only, curl only" "One policy block. Applied live, no restart."`
Enter
Sleep 400ms
Show
Sleep 1.5s
Type "tail -11 /tmp/demo-policy.yaml"
Enter
Sleep 3.5s
Type "openshell policy set demo --policy /tmp/demo-policy.yaml --wait"
Enter
Wait+Screen /loaded \(active/
Sleep 3s

# ---- 6. enforcement ----
Hide
Type `card "5  Enforcement" "Every request is checked by program, host and HTTP method."`
Enter
Sleep 400ms
Show
Sleep 1.5s
Type "# GET is read-only: allowed"
Enter
Type `openshell sandbox exec -n demo --no-tty -- curl -s -w '  -> HTTP %{http_code}\n' https://api.github.com/zen`
Enter
Wait+Screen /-> HTTP 200/
Sleep 2.5s
Type "# POST is a write: blocked"
Enter
Type `openshell sandbox exec -n demo --no-tty -- curl -s -o /dev/null -w 'POST -> HTTP %{http_code}\n' -X POST https://api.github.com/gists`
Enter
Wait+Screen /POST -> HTTP 403/
Sleep 2.5s
Type "# same host, different program: blocked"
Enter
Type `openshell sandbox exec -n demo --no-tty -- sh -c 'wget -q -T 5 -t 1 -O- https://api.github.com/zen || echo "wget -> $(echo BLOCKED)"'`
Enter
Wait+Screen /wget -> BLOCKED/
Sleep 4s

# ---- 7. cleanup ----
Hide
Type `card "6  Clean up"`
Enter
Sleep 400ms
Show
Sleep 1s
Type "openshell sandbox delete demo"
Enter
Wait+Screen /deletion accepted|Deleted sandbox/
Sleep 3s

# ---- end card ----
Hide
Type `card "OpenShell + E2B" "✓ each agent in its own private E2B microVM" "✓ per-program network policy, HTTP-level rules, audit log" "✓ no API keys or gateway tokens in the agent box" "" "github.com/e2b-dev/openshell-e2b"`
Enter
Sleep 400ms
Show
Sleep 6s
