# VideoHub on Arch Linux

A port of VideoHub's Windows-only parts. Everything OS-specific is in `server/platform.js`; the rest of the hub is shared.

| Windows version | Linux version |
|---|---|
| PowerShell, `setup.ps1`, `SETUP.cmd` | `setup.sh`, `update.sh`, `uninstall.sh`, `videohub.sh` |
| Recycle Bin via SHFileOperation | `gio trash` → `trash-put` → `kioclient` → own XDG trash (same drive only). Never a hard delete. |
| Explorer (`/select`) | FileManager1 over D-Bus (selects the file), else `xdg-open` |
| Toast notification | `notify-send` |
| Windows folder dialog | `zenity` → `kdialog` → `yad` |
| `Win32_VideoController` | `lspci` |
| `Win32_Process` (RAM hogs) | `ps` |
| Affinity + priority through PowerShell | `taskset -a -c` + nice on every thread of the render's process tree |
| `taskkill /T /F` | walk the tree from `ps`, SIGKILL children first |
| `cmd.exe /c` for command jobs | `sh -c` |
| Registry Run key | `~/.config/autostart/videohub.desktop` |
| `%APPDATA%\RenderGuard` | `~/.config/videohub` |
| Edge / Chrome paths | `chromium`, `google-chrome-stable`, `microsoft-edge-stable`, `brave`, … on `PATH` (or `CHROME=/path`) |

## Known limits
- **GPU encoders:** `nvenc` and `qsv` work with Linux ffmpeg when the drivers are set up; **AMF is Windows-only**. AMD/Intel users on VAAPI fall back to x264 (a `vaapi` encoder is not implemented). Test with `node scripts/init-config.mjs --detect`.
- **Render protection** uses affinity and nice values like the Windows version, not cgroups. It cannot freeze a render. A `systemd-run --user --scope -p CPUQuota=…` wrapper would be a stronger limit; not done.
- **Trash on other drives:** without `gio` or `trash-cli`, files on a different drive than `~/.local/share` are refused, not deleted.
- **History from old RenderGuard logs** is not read on Linux (there is none).
- `PKGBUILD` is a local-build sketch (`makepkg -si` in a clone), not tested; the packaged install keeps data under `~/.local/share/videohub`.
- This port was written without running the test suite or the hub (the sandbox it was written in blocked running cloned code). Run `npm test` and `./setup.sh --dry-run` first and expect to fix small things.
