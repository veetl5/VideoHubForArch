# VideoHub: notes for Claude working on this repo

Local hub for videos written as code (catalog, live preview with no render, review notes, protected render
queue, MCP tools). Node 22+, ES modules, no build step, vanilla-JS UI, render protection built in. The agent side is
Claude Code **or opencode**: `setup.sh` registers the same MCP server, rule and skill in both
(`scripts/opencode-config.mjs`). Architecture, map and the pitfalls behind past bugs:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What a film project must look like:
[docs/PROJECT-CONTRACT.md](docs/PROJECT-CONTRACT.md).

## Installing VideoHub for the user (Arch Linux)
When the user opened this folder in Claude Code and asks to install or set up VideoHub (and `data/config.json` does not
exist yet, or they ask to redo it), do the install for them: one step at a time, in their language, one sentence on what
a step is for before running it, never ask them to type a command. Do not change VideoHub's code during an install.

1. **Requirements.** `node -v` (22+), `ffmpeg -version`, a Chromium-family browser. For each missing one say what it is for
   and ask before installing it with `sudo pacman -S nodejs npm` / `ffmpeg` / `chromium`.
2. **Look, change nothing.** `./setup.sh --dry-run`; `node scripts/init-config.mjs --state`; `node scripts/init-config.mjs --detect`.
3. **Ask the user** (question tool, recommended answer first, skip what `--state` shows as decided): workspace folder
   (default `~/Documents/VideoHub`; check a typed path with `node scripts/init-config.mjs --check "<folder>"`), watch
   found folders (no), graphics-card encoder (yes, only if detected), the review-before-render rule (yes), opencode too
   (yes when `command -v opencode` finds it), application-menu entry (yes), start at login (no), example film (yes).
4. **Install once:** `./setup.sh --workspace "<folder>" --watch-found yes|no --gpu-encoder yes|no --global-rule yes|no --opencode yes|no --launcher yes|no --startup yes|no --example yes|no`.
   Show errors in plain words and stop; do not work around them.
5. **Check:** `node server/cli.js hub_workspace`; `./videohub.sh` opens the window. With `--opencode yes`, also check
   `~/.config/opencode/opencode.json` has `mcp.videohub` and `~/.config/opencode/AGENTS.md` has the rule block.
6. **Tell the user what now:** where the workspace is, how to open VideoHub, the first thing to try, and that they must
   start a **new** session (Claude Code, or opencode where the tools are named `videohub_hub_*`) for the tools to load.

## Setup on a new computer (what `setup.sh` does)
`./setup.sh` (`--dry-run` changes nothing outside this folder; `--yes` takes every recommended answer). It checks Node 22+,
ffmpeg and a Chromium browser, runs `npm install`, asks the questions above (logic in `scripts/init-config.mjs`, unit-tested),
registers the MCP server `videohub` (user scope) and installs `skill/videohub` into `~/.claude/skills`; with opencode it
also writes `mcp.videohub` into `~/.config/opencode/opencode.json` (or `.jsonc`), the rule into
`~/.config/opencode/AGENTS.md` and the skill into `~/.config/opencode/skills` (text splices that keep the user's other
settings and comments; `scripts/opencode-config.mjs`, unit-tested). Uninstall: `./uninstall.sh`.
Linux-specific code lives in `server/platform.js` (trash, notifications, file manager, folder picker, process tree, autostart);
see docs/ARCH.md.

## Map (short)
- `server/hub.js` HTTP + SSE; `scan.js` projects; `live.js` live preview; `notes.js` notes; `jobs.js` render queue;
  `tools.js` the `hub_*` tools (`mcp.js`, `cli.js`); `legacy.js` + `ui/values.js` stored values and legacy aliases;
  `config.js` settings and default folders (the workspace, `~/Documents/VideoHub/…` by default); `encoders.js` render
  encoders; `scripts/init-config.mjs` setup's config helper; `scripts/opencode-config.mjs` setup's opencode helper.
- `ui/app.js` pages, `ui/review*` review editor, `ui/thumbstudio*` Thumbnail Studio.
- `server/platform.js` OS-specific code; `engine-hooks/` page-side editor hooks; `examples/hello-film` the example film;
  `templates/new-film` the starter for new films; `templates/thumbnail` built-in thumbnail templates.

## Rules
- Test on copies: a scratch project added as a root of a test hub, never the user's real projects. Other sessions may be
  rendering.
- Setup while developing VideoHub: only ever `--dry-run`; test its logic through `scripts/init-config.mjs --data <scratch>`.
  (A real run is for "Installing VideoHub for the user" above, with their answers.)
- Render script (`templates/new-film/render.js`, same file as `examples/hello-film/render.js`): test renders only on a
  scratch copy of the example under `.test-tmp`, short clips, one at a time; see docs/RENDER-SPEED.md for the checks.
- Test hub: `VIDEOHUB_PORT=7799 VIDEOHUB_GUARD=off VIDEOHUB_JOBS=off VIDEOHUB_NO_WINDOW=1 VIDEOHUB_BASE_DIR=<scratch>`.
  Set `VIDEOHUB_PORT` on every CLI call too, or the tool starts a hub on the real port.
- No renders in parallel; use the queue. Never hard-delete files. A `mode:"command"` job waits for the user's approval
  on the Renders page before it runs (`config.render.confirmCommands`).
- English UI text and comments. Keep each file's dense style. Stored values are English; read old files through
  `legacy.js`.
- The UI must never import from `server/`. After a UI change open the pages and check the console.
- Before committing: `npm test` and `node --check` on every changed file.
- Publishing goes through GitHub's browser upload, which drops every name starting with a dot: no file VideoHub needs may
  have one (`scripts/upload-rules.test.js` checks). Build the folder to drag in with `node scripts/make-upload.mjs`.

## Pitfalls
See "Things that matter when changing the code" in docs/ARCHITECTURE.md (hub blocking, fs.watch reads, per-frame
layout reads, note pictures from ffmpeg, security of the local server).
