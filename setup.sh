#!/usr/bin/env bash
# VideoHub setup for Arch Linux: a short guided install. Safe to run again (it updates instead of duplicating, keeps every
# answer already given and never moves or overwrites your folders or settings). Works from any folder.
#   ./setup.sh [--dry-run] [--yes] [answers...]
#   --dry-run               ask nothing, assume the recommended answers and print every step; change nothing outside this folder
#   --yes                   accept every recommended answer, ask nothing
# Answers (each question has one; "ask" = ask when needed, the default):
#   --workspace <folder>        where your video work lives (default ~/Documents/VideoHub)
#   --watch-found ask|yes|no    also watch video folders found on the Desktop / in Documents (recommended: no)
#   --gpu-encoder ask|yes|no    render with the graphics card's video encoder when it has one (recommended: yes)
#   --global-rule ask|yes|no    add the "review before rendering" rule to ~/.claude/CLAUDE.md (recommended: yes)
#   --launcher ask|yes|no       application-menu entry "VideoHub" (recommended: yes)
#   --startup ask|yes|no        start VideoHub (server only, no window) when you log in (recommended: no)
#   --example ask|yes|no        add the example film (recommended: yes)
set -u
hub="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
DRY=0; YES=0; WORKSPACE=""; WATCH=ask; GPU=ask; RULE=ask; LAUNCHER=ask; STARTUP=ask; EXAMPLE=ask
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1;; --yes|-y) YES=1;;
    --workspace) WORKSPACE="${2:-}"; shift;;
    --watch-found) WATCH="${2:-ask}"; shift;; --gpu-encoder) GPU="${2:-ask}"; shift;;
    --global-rule) RULE="${2:-ask}"; shift;; --launcher) LAUNCHER="${2:-ask}"; shift;;
    --startup) STARTUP="${2:-ask}"; shift;; --example) EXAMPLE="${2:-ask}"; shift;;
    -h|--help) sed -n 2,16p "$0"; exit 0;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2;;
  esac; shift
done
[ "$DRY" = 1 ] && YES=1

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
say() { c 32 "$1"; }; warn() { c 33 "$1"; }; err() { c 31 "$1"; }; plan() { c 36 "  [dry run] would: $1"; }
todo=()
ask_yn() {  # ask_yn "question" default(yes|no) → 0 for yes
  [ "$YES" = 1 ] && { [ "$2" = yes ]; return; }
  local def="Y/n"; [ "$2" = no ] && def="y/N"; local a
  read -r -p "  $1 [$def] " a || a=""
  case "${a,,}" in y|yes) return 0;; n|no) return 1;; *) [ "$2" = yes ];; esac
}
decide() {  # decide <given> <question> <default> → prints yes|no
  case "$1" in yes|no) echo "$1"; return;; esac
  if ask_yn "$2" "$3"; then echo yes; else echo no; fi
}

echo; c 36 "== VideoHub setup (Arch Linux): $hub"

# 1. requirements
node_ok=0
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//; s/\..*//')"
  if [ "${major:-0}" -ge 22 ]; then node_ok=1; say "Node.js $(node -v): ok"; else err "Node.js is too old ($(node -v)); VideoHub needs 22 or newer."; fi
else err "Node.js is missing."; fi
if [ "$node_ok" = 0 ]; then
  echo "  Install it:  sudo pacman -S nodejs npm      then run ./setup.sh again"; exit 1
fi
command -v npm >/dev/null 2>&1 || { err "npm is missing."; echo "  sudo pacman -S npm"; exit 1; }
if command -v ffmpeg >/dev/null 2>&1; then say "ffmpeg: ok ($(command -v ffmpeg))"
else warn "ffmpeg is missing (renders, previews and frame pictures need it)."; todo+=("Install ffmpeg:  sudo pacman -S ffmpeg"); fi
browser=""; for b in chromium google-chrome-stable google-chrome microsoft-edge-stable brave vivaldi-stable thorium-browser; do command -v "$b" >/dev/null 2>&1 && { browser="$(command -v "$b")"; break; }; done
if [ -n "$browser" ]; then say "Browser for rendering: ok ($browser)"
else warn "No Chromium-based browser found (renders draw every frame in one, invisibly)."; todo+=("Install a browser for renders:  sudo pacman -S chromium"); fi
for t in "xdg-open xdg-utils opening files" "notify-send libnotify render notifications" "zenity zenity folder picker" "gio glib2 sending files to the Trash" "lspci pciutils graphics card detection" "taskset util-linux CPU limits"; do
  set -- $t; command -v "$1" >/dev/null 2>&1 || warn "Optional: $2 is not installed ($3 degrades quietly):  sudo pacman -S $2"
done
claude="$(command -v claude || true)"
if [ -n "$claude" ]; then say "Claude Code: ok ($claude)"
else warn "Claude Code was not found. VideoHub works without it, but Claude Code is what writes the films: https://claude.com/claude-code"; fi

# 2. packages
if [ "$DRY" = 1 ]; then plan "npm install in $hub"
else ( cd "$hub" && npm install --no-audit --no-fund --loglevel=error ) && say "Packages: ok" || { err "npm install failed"; exit 1; }; fi

# 3. config: workspace, watched folders, encoder (the logic lives in scripts/init-config.mjs)
state="$(node "$hub/scripts/init-config.mjs" --state)"
js() { node -e 'const j=JSON.parse(process.argv[1]);const v=process.argv[2].split(".").reduce((a,k)=>a==null?a:a[k],j);console.log(v==null?"":Array.isArray(v)?v.join("\n"):v)' "$state" "$1"; }
if [ "$(js installed)" = "true" ]; then
  say "Already set up: workspace $(js workspace) (kept)"; initargs=()
else
  ws="$WORKSPACE"; [ -z "$ws" ] && ws="$(js defaultWorkspace)"
  if [ -z "$WORKSPACE" ] && [ "$YES" = 0 ]; then read -r -p "  Where should your video work live? [$ws] " a; [ -n "${a:-}" ] && ws="$a"; fi
  why="$(node "$hub/scripts/init-config.mjs" --check "$ws" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.ok?"":j.why)')"
  [ -n "$why" ] && { err "$why"; exit 1; }
  initargs=(--workspace "$ws")
  found="$(node -e 'console.log(JSON.parse(process.argv[1]).discovered.length)' "$state")"
  if [ "${found:-0}" -gt 0 ]; then
    echo "  VideoHub found folders that look like video work:"; node -e 'JSON.parse(process.argv[1]).discovered.forEach(d=>console.log("    "+d.path))' "$state"
    if [ "$(decide "$WATCH" "Watch them too? (nothing is ever moved)" no)" = yes ]; then
      while read -r d; do [ -n "$d" ] && initargs+=(--watch "$d"); done < <(node -e 'JSON.parse(process.argv[1]).discovered.forEach(d=>console.log(d.path))' "$state")
    fi
  fi
  enc=auto
  det="$(node "$hub/scripts/init-config.mjs" --detect $([ "$DRY" = 1 ] && echo --dry-run) 2>/dev/null || echo '{}')"
  gpuenc="$(node -e 'try{const j=JSON.parse(process.argv[1]);console.log((j.available||[]).filter(x=>x!=="x264").join(" "))}catch{}' "$det")"
  if [ -n "$gpuenc" ]; then
    echo "  Your graphics card can encode video ($gpuenc)."
    [ "$(decide "$GPU" "Use it for renders? Same quality, usually faster." yes)" = yes ] && enc=auto || enc=x264
  fi
  initargs+=(--encoder "$enc")
fi
if [ "$DRY" = 1 ]; then plan "write the configuration:"; node "$hub/scripts/init-config.mjs" "${initargs[@]}" --dry-run | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));(j.actions||[]).forEach(a=>console.log("    "+a));if(j.error)console.log("    "+j.error)'
else node "$hub/scripts/init-config.mjs" "${initargs[@]}" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));if(j.error){console.error(j.error);process.exit(1)}(j.actions||[]).forEach(a=>console.log("  "+a))' || exit 1; fi

# 4. MCP server "videohub" for every Claude Code session (user scope)
mcp="$hub/server/mcp.js"
if [ "$DRY" = 1 ]; then plan "register the MCP server: claude mcp add --scope user videohub -- node \"$mcp\""
elif [ -n "$claude" ]; then
  "$claude" mcp remove videohub --scope user >/dev/null 2>&1
  if "$claude" mcp add --scope user videohub -- node "$mcp" >/dev/null 2>&1; then say 'Claude tools (MCP server "videohub") registered; new Claude Code sessions will see the hub_* tools'
  else todo+=("Register the MCP server by hand:  claude mcp add --scope user videohub -- node \"$mcp\""); fi
else todo+=("Register the MCP server once Claude Code is installed:  claude mcp add --scope user videohub -- node \"$mcp\""); fi

# 5. the skill Claude reads (~/.claude/skills/videohub), with this install's path filled in
claudeHome="$HOME/.claude"
if [ "$DRY" = 1 ]; then plan "copy skill/videohub to $claudeHome/skills/videohub (with {{VIDEOHUB_DIR}} = $hub)"
else
  mkdir -p "$claudeHome/skills/videohub"
  for f in "$hub"/skill/videohub/*; do [ -f "$f" ] && sed "s#{{VIDEOHUB_DIR}}#$hub#g" "$f" > "$claudeHome/skills/videohub/$(basename "$f")"; done
  say "Skill installed: $claudeHome/skills/videohub"
fi

# 6. the global rule, between marker lines in ~/.claude/CLAUDE.md (replaced on the next run, removed by uninstall.sh)
cm="$claudeHome/CLAUDE.md"; begin='<!-- videohub:begin (added by VideoHub setup; remove with uninstall.sh) -->'; end='<!-- videohub:end -->'
want="$RULE"
[ "$want" = ask ] && [ -f "$cm" ] && grep -qF 'videohub:begin' "$cm" && want=yes
want="$(decide "$want" "Should Claude show every new film in VideoHub before it renders? (adds a short rule to ~/.claude/CLAUDE.md)" yes)"
if [ "$want" = yes ]; then
  block="$begin"$'\n'"$(sed "s#{{VIDEOHUB_DIR}}#$hub#g" "$hub/claude/global-rule.md")"$'\n'"$end"
  if [ "$DRY" = 1 ]; then plan "write this block into $cm:"; echo "$block" | sed 's/^/    /'
  else
    mkdir -p "$claudeHome"; [ -f "$cm" ] && cp "$cm" "$cm.videohub-backup"
    BLOCK="$block" BEGIN="$begin" END="$end" node -e '
      const fs=require("fs"),f=process.argv[1];let cur="";try{cur=fs.readFileSync(f,"utf8")}catch{}
      const a=cur.indexOf(process.env.BEGIN), b=cur.indexOf(process.env.END);
      let out; if(a>=0&&b>a) out=cur.slice(0,a)+process.env.BLOCK+cur.slice(b+process.env.END.length);
      else out=(cur.trim()?cur.trimEnd()+"\n\n":"")+process.env.BLOCK+"\n";
      fs.writeFileSync(f,out)' "$cm"
    say "Global rule added to $cm (backup: CLAUDE.md.videohub-backup)"
  fi
else echo "  Global rule skipped (run ./setup.sh --global-rule yes to add it later)."; fi

# 7. application-menu entry
chmod +x "$hub/videohub.sh" 2>/dev/null
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"; desktop="$apps/videohub.desktop"
want="$(decide "$LAUNCHER" "Add VideoHub to your application menu?" yes)"
if [ "$want" = yes ]; then
  if [ "$DRY" = 1 ]; then plan "create $desktop -> $hub/videohub.sh"
  else
    mkdir -p "$apps"
    printf '[Desktop Entry]\nType=Application\nName=VideoHub\nComment=Review studio and render queue for videos Claude Code writes as code\nExec="%s/videohub.sh"\nPath=%s\nIcon=video-x-generic\nTerminal=false\nCategories=AudioVideo;Video;\n' "$hub" "$hub" > "$desktop"
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1
    say "Application menu entry: $desktop"
  fi
fi

# 8. start at login (server only)
want="$(decide "$STARTUP" "Start VideoHub (no window) when you log in? It then keeps render protection on all the time." no)"
if [ "$want" = yes ]; then
  auto="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/videohub.desktop"
  if [ "$DRY" = 1 ]; then plan "create $auto"
  else mkdir -p "$(dirname "$auto")"; printf '[Desktop Entry]\nType=Application\nName=VideoHub (server)\nExec="%s/videohub.sh" --server\nTerminal=false\nX-GNOME-Autostart-enabled=true\n' "$hub" > "$auto"; say "Start at login: $auto"; fi
fi

# 9. the example film
want="$(decide "$EXAMPLE" "Add the 10-second example film?" yes)"
if [ "$want" = yes ]; then
  if [ "$DRY" = 1 ]; then plan "copy examples/hello-film into the films folder"
  else node "$hub/scripts/init-config.mjs" --example >/dev/null && say "Example film added"; fi
fi

echo
if [ ${#todo[@]} -gt 0 ]; then warn "Left for you to do:"; for t in "${todo[@]}"; do echo "  - $t"; done; fi
c 36 "== Done"
echo "  Open VideoHub from your application menu, or run: $hub/videohub.sh"
echo "  Then start a NEW Claude Code session so it sees the hub_* tools."
