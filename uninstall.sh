#!/usr/bin/env bash
# VideoHub uninstall: undoes what setup.sh did on this computer. Your films, their notes (.videohub folders), the outputs
# folder and this VideoHub folder itself are NOT touched; delete the folder yourself afterwards if you want.
#   ./uninstall.sh [--dry-run]
set -u
hub="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
doit() { if [ "$DRY" = 1 ]; then c 36 "  [dry run] would: $1"; else shift; "$@"; fi; }
c 36 "== VideoHub uninstall: $hub"
ocdo() { node "$hub/scripts/opencode-config.mjs" "$@" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log("  "+JSON.parse(s).action)}catch{}})'; }

# 1. stop this install's server
for pid in $(pgrep -f "$hub/server/hub.js" 2>/dev/null); do doit "stop the VideoHub server (pid $pid)" kill "$pid"; done

# 2. Claude: MCP server, skill, global rule (only when they belong to THIS install)
if command -v claude >/dev/null 2>&1 && claude mcp get videohub 2>/dev/null | grep -qF "$hub/server/mcp.js"; then
  doit "remove the MCP server videohub" claude mcp remove videohub --scope user
fi
sk="$HOME/.claude/skills/videohub"
if [ -d "$sk" ] && grep -qF "$hub" "$sk"/SKILL.md 2>/dev/null; then doit "remove the skill $sk" rm -r "$sk"; fi
cm="$HOME/.claude/CLAUDE.md"
if [ -f "$cm" ] && grep -qF "$hub" "$cm" && grep -qF 'videohub:begin' "$cm"; then
  if [ "$DRY" = 1 ]; then c 36 "  [dry run] would: remove the VideoHub block from $cm"
  else
    cp "$cm" "$cm.videohub-backup"
    node -e 'const fs=require("fs"),f=process.argv[1];let t=fs.readFileSync(f,"utf8");const a=t.indexOf("<!-- videohub:begin"),e="<!-- videohub:end -->",b=t.indexOf(e);if(a>=0&&b>a){t=(t.slice(0,a).trimEnd()+"\n\n"+t.slice(b+e.length).trimStart()).trim()+"\n";fs.writeFileSync(f,t)}' "$cm"
    c 32 "done: removed the rule from $cm (backup: CLAUDE.md.videohub-backup)"
  fi
fi

# 3. opencode: the MCP server, the skill and the rule (only when they belong to THIS install)
ocHome="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
ocCfg="$ocHome/opencode.json"; [ -f "$ocHome/opencode.jsonc" ] && [ ! -f "$ocHome/opencode.json" ] && ocCfg="$ocHome/opencode.jsonc"
if [ -f "$ocCfg" ] && grep -qF "$hub/server/mcp.js" "$ocCfg"; then
  doit "remove the \"videohub\" MCP server from $ocCfg" ocdo mcp-remove --config "$ocCfg" --expect "$hub/server/mcp.js"
fi
osk="$ocHome/skills/videohub"
if [ -d "$osk" ] && grep -qF "$hub" "$osk"/SKILL.md 2>/dev/null; then doit "remove the opencode skill $osk" rm -r "$osk"; fi
oa="$ocHome/AGENTS.md"
if [ -f "$oa" ] && grep -qF "$hub" "$oa" && grep -qF 'videohub:begin' "$oa"; then
  doit "remove the VideoHub block from $oa" ocdo rule-remove --file "$oa" --expect "$hub"
fi

# 4. menu entry and start at login (only when they point at this install)
for f in "${XDG_DATA_HOME:-$HOME/.local/share}/applications/videohub.desktop" "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/videohub.desktop"; do
  [ -f "$f" ] && grep -qF "$hub" "$f" && doit "remove $f" rm "$f"
done
echo; c 36 "== Done. Left in place: your films, outputs, $hub (data/ holds settings; delete the folder to remove it)."
