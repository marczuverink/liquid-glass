#!/usr/bin/env bash
# Runs the packed extension in GNOME Shell 51 as a window on the current
# desktop (gnome-shell --devkit), inside the Fedora distrobox "gnome51" whose
# home is ~/gnome51-home. Works from the host and from inside the box.
#
#   run.sh            install the last packed zip and start the shell
#   run.sh --pack     npm run pack first (host only, needs npm)
#   run.sh --no-ext   start the shell with Liquid Glass disabled, to compare
#
# LG51_AUTOSTART='kitty & gnome-text-editor' runs commands in the nested
# session once the shell is up.
#
# The shell gets its own session bus, runtime dir, PipeWire and dconf (in the
# box's home), so the real session's settings and extensions are untouched.
# Log: ~/gnome51-home/g51.log
set -euo pipefail

BOX=gnome51
UUID=liquid-glass@thinkingcoding1231.gmail.com
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
repo=$(cd "$here/../.." && pwd)
ext_src="$repo/$UUID"
zip="$ext_src/$UUID.shell-extension.zip"

in_box() { [ -n "${CONTAINER_ID:-}" ] || [ -f /run/.containerenv ]; }

if ! in_box; then
  if [ "${1:-}" = --pack ]; then
    (cd "$ext_src" && npm run pack)
    shift
  fi
  exec distrobox enter "$BOX" -- "$here/run.sh" "$@"
fi

enabled="[\"$UUID\"]"
case "${1:-}" in
  --pack) echo "--pack needs npm on the host; installing the existing zip instead" >&2 ;;
  --no-ext) enabled="[]" ;;
esac
[ -f "$zip" ] || { echo "no $zip; run 'npm run pack' on the host" >&2; exit 1; }

# Inside the box $HOME is the box's own home.
ext="$HOME/.local/share/gnome-shell/extensions/$UUID"
rm -rf "$ext" && mkdir -p "$ext"
unzip -q "$zip" -d "$ext"
glib-compile-schemas "$ext/schemas"

# The devkit window is a client of the real desktop.
host_wayland="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${WAYLAND_DISPLAY:-wayland-0}"
[ -S "$host_wayland" ] || { echo "no Wayland socket at $host_wayland" >&2; exit 1; }

runtime=$(mktemp -d /tmp/g51rt.XXXXXX)
cleanup() {
  fusermount3 -u "$runtime/doc" 2>/dev/null || true
  rm -rf "$runtime" 2>/dev/null || true
}
trap cleanup EXIT

export XDG_RUNTIME_DIR="$runtime"
# The box has no system bus socket of its own; the host's is under /run/host.
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/host/run/dbus/system_bus_socket
export HOST_WAYLAND="$host_wayland"
# What apps started by the nested shell, or activated over its session bus,
# need: a GNOME session and the nested display rather than the host's.
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=lg51
unset DISPLAY
# The host's input method (fcitx) is not in the box.
unset GTK_IM_MODULE QT_IM_MODULE XMODIFIERS
export XDG_DATA_DIRS="$HOME/.local/share/flatpak/exports/share:/usr/local/share:/usr/share"
export ENABLED_EXTENSIONS="$enabled"

echo "starting GNOME Shell $(gnome-shell --version | awk '{print $3}'), log: $HOME/g51.log"
dbus-run-session -- bash -c '
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions "$ENABLED_EXTENSIONS"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "9999"
  # A test profile: the extension logs to g51.log.
  gsettings --schemadir "'"$ext"'/schemas" set org.gnome.shell.extensions.'"$UUID"' output-logs true
  # --devkit streams the nested screen to its window through PipeWire.
  pipewire >/dev/null 2>&1 &
  pw=$!
  sleep 0.5
  wireplumber >/dev/null 2>&1 &
  wp=$!
  sleep 0.5
  if [ -n "${LG51_AUTOSTART:-}" ]; then
    (sleep 6; bash -c "$LG51_AUTOSTART") &
  fi
  # Xwayland would need a systemd unit, which the box does not have.
  WAYLAND_DISPLAY="$HOST_WAYLAND" gnome-shell --devkit --wayland --no-x11 --wayland-display lg51
  kill $wp $pw 2>/dev/null || true
' 2>&1 | tee "$HOME/g51.log"
