# Maintainer: you <you@example.com>
# Arch Linux port of https://github.com/TensaikunYT/Videohub (upstream).
# Local-build PKGBUILD: installs VideoHub to /opt/videohub with a /usr/bin/videohub launcher.
# Run inside a clone:  makepkg -si      (the package unpacks the clone's current files)
# Per-user data goes to ~/.config/videohub and ~/Documents/VideoHub; the install folder is read-only for normal users,
# so set VIDEOHUB_DATA_DIR (the launcher does) to keep config, caches and the render queue in ~/.local/share/videohub.
pkgname=videohub-git
pkgver=0.1.0
pkgrel=1
pkgdesc='Local review studio and render queue for videos Claude Code writes as code'
arch=('any')
url='https://github.com/veetl5/VideoHubForArch'
license=('MIT')
depends=('nodejs>=22' 'npm' 'ffmpeg' 'chromium')
optdepends=('xdg-utils: open files and folders' 'libnotify: render notifications' 'zenity: folder picker'
            'glib2: move files to the Trash' 'pciutils: graphics card detection' 'util-linux: CPU limits (taskset)')
options=('!strip')
source=()

package() {
  install -d "$pkgdir/opt/videohub"
  cp -a "$startdir"/{server,ui,scripts,templates,examples,engine-hooks,skill,claude,docs,package.json,package-lock.json,LICENSE,README.md,videohub.sh} "$pkgdir/opt/videohub/"
  ( cd "$pkgdir/opt/videohub" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
  install -d "$pkgdir/usr/bin" "$pkgdir/usr/share/applications"
  cat > "$pkgdir/usr/bin/videohub" <<'LAUNCH'
#!/bin/sh
export VIDEOHUB_DATA_DIR="${VIDEOHUB_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/videohub}"
mkdir -p "$VIDEOHUB_DATA_DIR"
exec /opt/videohub/videohub.sh "$@"
LAUNCH
  chmod 755 "$pkgdir/usr/bin/videohub"
  cat > "$pkgdir/usr/share/applications/videohub.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Name=VideoHub
Comment=Review studio and render queue for videos Claude Code writes as code
Exec=videohub
Icon=video-x-generic
Terminal=false
Categories=AudioVideo;Video;
DESK
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE" 2>/dev/null || install -Dm644 "$startdir/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
