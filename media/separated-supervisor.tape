# Run via npm run demo:record. The wrapper connects, verifies, and cleans up.
Output dist/studio/full-speed.mp4
Require tmux
Require gum
Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 22
Set LineHeight 1.15
Set Width 1920
Set Height 1080
Set Padding 20
Set Margin 20
Set MarginFill "#11111b"
Set BorderRadius 12
Set WindowBar Colorful
Set Theme "Catppuccin Mocha"
Set TypingSpeed 15ms
Set WaitTimeout 120s
Set Framerate 30

Hide
Type "bash media/studio-start.sh"
Enter
Sleep 3s
Type `card "OpenShell + E2B" "The supervisor gets its own microVM." "The agent gets another." "" "Live policy decisions above right." "Live worker heartbeat below right."`
Enter
Sleep 500ms
Show
Sleep 4s

Type "studio create"
Enter
Wait+Screen /PAIR READY/
Sleep 3s

Hide
Type `card "Two independent boundaries" "OpenShell policy in A. E2B network fence around B."`
Enter
Sleep 400ms
Show
Type "studio fence"
Enter
Wait+Screen /FENCE VERIFIED/
Sleep 4s

Hide
Type `card "Change policy. Keep the worker running." "Allow curl to read GitHub. Watch A reload the rule."`
Enter
Sleep 400ms
Show
Type "studio policy"
Enter
Wait+Screen /POLICY ACTIVE/
Sleep 3s
Type "studio requests"
Enter
Wait+Screen /REQUESTS VERIFIED/
Sleep 5s

Hide
Type `card "Now pull the supervisor's plug." "The worker VM survives. Does the agent keep running?"`
Enter
Sleep 400ms
Show
Sleep 2s
Type "studio sever"
Enter
Wait+Screen /FAIL-CLOSED VERIFIED/
Sleep 6s

Hide
Type `card "Separate machines. One task lifecycle." "Delete the pair; keep the shared gateway."`
Enter
Sleep 400ms
Show
Type "studio cleanup"
Enter
Wait+Screen /CLEANUP VERIFIED/
Sleep 3s

Hide
Type `card "The supervisor is outside the worker." "✓ policy decisions in a separate microVM" "✓ worker root cannot bypass the network fence" "✓ supervisor loss freezes the agent" "" "Live demo · OpenShell v0.1.2" "Landlock v2: read-only file truncation is not blocked." "Shared gateway certificate remains a demo limitation."`
Enter
Sleep 400ms
Show
Sleep 5s
