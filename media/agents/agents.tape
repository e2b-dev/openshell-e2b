# Run via npm run demo:record:agents (scripts/agents-record.sh).
Output dist/agents-video/raw.mp4
Require tmux
Set Shell "bash"
Set FontSize 17
Set LineHeight 1.25
Set Width 1920
Set Height 1080
Set Padding 20
Set Margin 80
Set MarginFill "#16161e"
Set WindowBar Colorful
Set WindowBarSize 44
Set BorderRadius 14
Set Theme "TokyoNight"
Set TypingSpeed 35ms
Set WaitTimeout 600s
Set Framerate 30

Hide
Type@1ms "bash media/agents/start.sh"
Enter
Sleep 2.5s
Type@1ms "clear; stamp clip_start"
Enter
Sleep 600ms
Show
Sleep 1.2s
Type "npm run agents"
Sleep 400ms
Enter
Wait+Screen /graders and providers deleted/
Sleep 9s
