#!/bin/sh
# Captures the README screenshots from the demo dashboard (node scripts/demo.mjs must be running on :4321).
# Uses a throwaway Chrome profile; set CHROME to another Chromium-based browser if needed.
set -e
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/docs/screenshots"
BASE="${BASE:-http://127.0.0.1:4321}"
PROFILE="$(mktemp -d)"
mkdir -p "$OUT"
DEMO="$(node -e 'const fs=require("fs"),os=require("os");console.log(fs.realpathSync(os.tmpdir())+"/leanbrain-demo/code/shop-api")')"
ID="$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$DEMO")"
shot() { # name url width height
  "$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size="$3,$4" \
    --use-angle=swiftshader --enable-unsafe-swiftshader --virtual-time-budget=9000 \
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
    --screenshot="$OUT/$1.png" "$BASE/$2" >/dev/null 2>&1
  echo "$OUT/$1.png"
}
shot overview "#/overview" 1440 1000
shot overview-dark "#/overview?theme=dark" 1440 1000
shot project-card "#/projects?p=$ID&tab=card" 1440 1000
shot repo-map "#/projects?p=$ID&tab=map" 1440 1000
shot memory "#/memory" 1440 1000
shot insights "#/insights" 1440 1180
shot usage "#/usage" 1440 1560
shot savings "#/savings" 1440 1000
shot setup "#/setup" 1440 1000
rm -rf "$PROFILE"
