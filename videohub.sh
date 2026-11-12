#!/usr/bin/env bash
# Opens VideoHub: starts the server if it is not running, then an app window (Chromium family, else the default browser).
#   videohub.sh            server + window
#   videohub.sh --server   server only, no window (what "start at login" runs)
# The server starts the render protection by itself.
set -u
hub="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
port=7788
data="${VIDEOHUB_DATA_DIR:-$hub/data}"
if [ -f "$data/config.json" ]; then
  p="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^﻿/,""));if(c.port)console.log(c.port)}catch{}' "$data/config.json" 2>/dev/null)"
  [ -n "$p" ] && port="$p"
fi
url="http://127.0.0.1:$port"
alive() { curl -fsS -m 1 "$url/api/ping" >/dev/null 2>&1; }

if ! alive; then
  if ! command -v node >/dev/null 2>&1; then
    msg="Node.js was not found. Install it (sudo pacman -S nodejs npm) and run setup.sh in $hub."
    echo "$msg" >&2; command -v notify-send >/dev/null 2>&1 && notify-send -a VideoHub "VideoHub" "$msg"
    exit 1
  fi
  mkdir -p "$data"
  ( cd "$hub" && nohup setsid node server/hub.js >>"$data/hub.log" 2>&1 & )
  for _ in $(seq 1 40); do alive && break; sleep 0.25; done
fi

[ "${1:-}" = "--server" ] && exit 0

for b in chromium google-chrome-stable google-chrome microsoft-edge-stable brave vivaldi-stable thorium-browser; do
  if command -v "$b" >/dev/null 2>&1; then
    nohup setsid "$b" "--app=$url" >/dev/null 2>&1 &
    exit 0
  fi
done
exec xdg-open "$url"
