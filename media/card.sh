#!/usr/bin/env bash
# card.sh "Title" ["subtitle" ...]: clear the pane and show a chapter card.
clear
title="$1"; shift
gum style --border rounded --border-foreground "#fab387" --foreground "#fab387" \
  --bold --padding "0 2" --margin "1 0 0 0" "$title"
for line in "$@"; do gum style --foreground "#a6adc8" --margin "0 1" "$line"; done
echo
