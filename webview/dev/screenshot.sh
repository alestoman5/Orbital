#!/usr/bin/env bash
# Screenshot a studio tab from a running dev harness with headless Edge/Chrome.
#   webview/dev/screenshot.sh <out.png> "<query>" [width] [height] [port]
#   e.g. webview/dev/screenshot.sh /tmp/spectra-dark.png "tab=spectra&theme=dark" 1400 900
set -euo pipefail
out=$1; query=$2; w=${3:-1400}; h=${4:-900}; port=${5:-5173}
browser=${BROWSER_BIN:-}
for c in "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
         "/c/Program Files/Google/Chrome/Application/chrome.exe" google-chrome chromium msedge; do
  [ -z "$browser" ] && { [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; } && browser=$c
done
profile=$(mktemp -d)
case "$out" in /*|?:*) ;; *) out="$PWD/$out";; esac
timeout 60 "$browser" --headless=new --disable-gpu --hide-scrollbars --no-first-run --window-size="$w,$h" \
  --virtual-time-budget=6000 --user-data-dir="$profile" --screenshot="$out" \
  "http://localhost:$port/?$query&shot=1&fresh=1" >/dev/null 2>&1 || true
rm -rf "$profile"
[ -s "$out" ] && echo "$out" || { echo "screenshot failed" >&2; exit 1; }
