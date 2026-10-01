#!/usr/bin/env bash
# Runs the built Liquid Glass extension with Dash to Dock and the test driver
# (lg-driver@liquid-glass.test) in a headless GNOME Shell on a private session
# bus, with its own config, data and cache directories, like run-nested.sh.
# Build first (npm run build). Prints the output directory (shell.log, shots/).
#
#   LG_DRV_SCENARIO   the driver's scenario (default: dock)
#   LG_SPIKE_MONITOR  virtual monitor mode (default: 1920x1080)
#   LG_MONITORS_XML   a monitors.xml to use (e.g. for a fractional scale)
#   LG_EXTRA_EXTENSIONS  more UUIDs from ~/.local/share/gnome-shell/extensions to
#                        enable (e.g. blur-my-shell@aunetx), space separated
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
lg_uuid=liquid-glass@thinkingcoding1231.gmail.com
dtd_uuid=dash-to-dock@micxgx.gmail.com
drv_uuid=lg-driver@liquid-glass.test
dtd_src=${LG_DTD_DIR:-$HOME/.local/share/gnome-shell/extensions/$dtd_uuid}
out=${1:-$(mktemp -d -t lg-glass-XXXXXX)}
mode=${LG_SPIKE_MONITOR:-1920x1080}

ext="$out/data/gnome-shell/extensions"
mkdir -p "$out"/{config,cache,shots} "$ext"
rm -rf "${ext:?}"/*
mkdir -p "$ext/$lg_uuid"
for f in metadata.json extension.js stylesheet.css dist shaders schemas; do
  cp -r "$repo/$lg_uuid/$f" "$ext/$lg_uuid/"
done
cp -r "$dtd_src" "$ext/$dtd_uuid"
cp -r "$here/$drv_uuid" "$ext/"
extra=""
for uuid in ${LG_EXTRA_EXTENSIONS:-}; do
  cp -r "$HOME/.local/share/gnome-shell/extensions/$uuid" "$ext/"
  extra="$extra, '$uuid'"
done
if [ -n "${LG_MONITORS_XML:-}" ]; then
  cp "$LG_MONITORS_XML" "$out/config/monitors.xml"
fi

export XDG_CONFIG_HOME="$out/config"
export XDG_DATA_HOME="$out/data"
export XDG_CACHE_HOME="$out/cache"
export LG_SPIKE_OUT="$out/shots"
export LG_DRV_SCENARIO="${LG_DRV_SCENARIO:-dock}"
export XDG_CURRENT_DESKTOP=GNOME
export XDG_SESSION_DESKTOP=gnome
unset WAYLAND_DISPLAY DISPLAY

socket="lg-glass-$$"
dtd_schemas="$ext/$dtd_uuid/schemas"

dbus-run-session -- bash -c "
  gsettings set org.gnome.shell enabled-extensions \"['$dtd_uuid', '$lg_uuid'$extra, '$drv_uuid']\"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '9999'
  gsettings --schemadir '$dtd_schemas' set org.gnome.shell.extensions.dash-to-dock dock-fixed true
  gsettings --schemadir '$dtd_schemas' set org.gnome.shell.extensions.dash-to-dock intellihide false
  gsettings --schemadir '$dtd_schemas' set org.gnome.shell.extensions.dash-to-dock dock-position 'BOTTOM'
  exec timeout 180 gnome-shell --headless --wayland --virtual-monitor '$mode' --wayland-display '$socket'
" >"$out/shell.log" 2>&1 || true

echo "$out"
