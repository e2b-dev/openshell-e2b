Output dist/dashboard/full-speed.mp4
Require tmux
Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 20
Set LineHeight 1.1
Set Width 1920
Set Height 1080
Set Padding 18
Set Margin 12
Set MarginFill "#11111b"
Set BorderRadius 10
Set WindowBar Colorful
Set Theme "Catppuccin Mocha"
Set TypingSpeed 12ms
Set WaitTimeout 180s
Set Framerate 30
Hide
Type "bash media/dashboard-start.sh"
Enter
Sleep 3s
Show
Sleep 3s
Type "demo create"
Enter
Wait+Screen /PAIR READY/
Sleep 3s
Type "demo fence"
Enter
Wait+Screen /FENCE VERIFIED/
Sleep 3s
# Set DASHBOARD_CAPTURE=1 to pause for an authenticated Console cutaway.
# Continue with: touch dist/dashboard/console-captured
Hide
Type "console_capture"
Enter
Wait+Screen /CONSOLE_READY/
Type "ui policy"
Enter
Sleep 2s
Show
Type "demo policy"
Enter
Wait+Screen /POLICY ACTIVE/
Sleep 5s
Hide
Type "ui logs"
Enter
Sleep 1s
Show
Type "demo requests"
Enter
Wait+Screen /REQUESTS VERIFIED/
Hide
Type "ui audit"
Enter
Sleep 1s
Show
Sleep 7s
Hide
Type "ui follow"
Enter
Sleep 1s
Show
Type "demo sever"
Enter
Wait+Screen /FAIL-CLOSED VERIFIED/
Sleep 7s
Type "demo cleanup"
Enter
Wait+Screen /CLEANUP VERIFIED/
Sleep 3s
Hide
Type "ui home"
Enter
Sleep 1s
Show
Sleep 3s
