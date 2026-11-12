#!/usr/bin/env bash
# VideoHub update: pulls the latest code (git clone) or copies this folder's code over an existing install, then
# refreshes packages, the skill and the global rule. Keeps data/ (settings, render queue, caches) and every project's notes.
#   ./update.sh [--target <VideoHub folder>] [--dry-run]
set -u
src="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
target=""; DRY=0
while [ $# -gt 0 ]; do case "$1" in --target) target="${2:-}"; shift;; --dry-run) DRY=1;; *) echo "Unknown option $1" >&2; exit 2;; esac; shift; done
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
c 36 "== VideoHub update"
if [ -z "$target" ] || [ "$(readlink -f "$target")" = "$src" ]; then
  if [ -d "$src/.git" ]; then
    if [ "$DRY" = 1 ]; then c 36 "  [dry run] would: git pull --ff-only in $src, then ./setup.sh --yes"; exit 0; fi
    git -C "$src" pull --ff-only || { c 31 "git pull failed"; exit 1; }
    exec "$src/setup.sh" --yes
  fi
  [ -z "$target" ] && { c 31 "Nothing to update: this folder is not a git clone. Use: ./update.sh --target <installed VideoHub folder>"; exit 1; }
  c 33 "This folder is the installed VideoHub; nothing to copy."; exit 0
fi
[ -f "$target/server/hub.js" ] || { c 31 "No installed VideoHub at $target"; exit 1; }
target="$(readlink -f "$target")"
if [ "$DRY" = 1 ]; then c 36 "  [dry run] would: rsync this folder over $target (keeping data/ and node_modules/), then run $target/setup.sh --yes"; exit 0; fi
if command -v rsync >/dev/null 2>&1; then rsync -a --exclude data/ --exclude node_modules/ --exclude .git/ --exclude .test-tmp/ "$src"/ "$target"/
else ( cd "$src" && tar --exclude=./data --exclude=./node_modules --exclude=./.git --exclude=./.test-tmp -cf - . ) | ( cd "$target" && tar -xf - ); fi
exec "$target/setup.sh" --yes
