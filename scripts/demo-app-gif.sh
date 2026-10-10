#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Render a GIF (and optionally an MP4) from the REAL desktop app window.
#
# The app runs on an isolated Xvfb display (not your desktop session), is
# driven with the dashboard's keyboard shortcuts, captured frame by frame with
# ImageMagick `import`, and assembled with ffmpeg.
#
# Requirements: Xvfb, openbox, xdotool, ImageMagick (import), ffmpeg, and a
# built app binary (src-tauri/target/release/linux-doctor, or APP=...).
# On immutable distros, install the first four in a toolbox and run with
# TOOLBOX=<name>; ffmpeg runs on the host.
#
# Usage:
#   scripts/demo-app-gif.sh [output.gif]
#   TOOLBOX=ldbuild scripts/demo-app-gif.sh
#
# Knobs (env):
#   SCREEN=1400x860   Xvfb screen size
#   WINDOW=           force the app window size (e.g. 1820x1120); empty lets the app decide
#   SCALE=940         output width in pixels
#   MP4=              also write an MP4 from the same frames (Reddit prefers video)
#   EXTRACT=          override the crop geometry, e.g. "1600:1000:120:20"
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/docs/screenshots/app.gif"}
APP=${APP:-"$ROOT/src-tauri/target/release/linux-doctor"}
FRAMES_DIR="$ROOT/.demo-app-frames"
FPS=8
SCREEN=${SCREEN:-1400x860}
WINDOW=${WINDOW:-}
SCALE=${SCALE:-940}
MP4=${MP4:-}
EXTRACT=${EXTRACT:-}
# Fallback crop (window region inside the default Xvfb root), used when the
# window geometry cannot be read. Measured from the capture margins.
FALLBACK_CROP="1322:807:78:53"

rm -rf "$FRAMES_DIR"; mkdir -p "$FRAMES_DIR"

# The desktop app needs a session bus: the single-instance plugin and the tray
# both talk to one, and without it the process starts and never maps a window
# (silent hang, no output). A container has none, and pointing the app at the
# host's bus would register a tray icon in the user's real session, so a private
# bus is started for the capture and torn down afterwards.
BUS_PATH="/run/user/$(id -u)/ld-gif-bus"
bus_start() {
  rm -f "$BUS_PATH"
  dbus-daemon --session --address="unix:path=$BUS_PATH" --fork 2>/dev/null || true
  [ -S "$BUS_PATH" ] && echo "session bus: $BUS_PATH"
}
bus_stop() {
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      if (Number(p) === process.pid) continue; // never match this very process
      let c = "";
      try { c = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " "); } catch { continue; }
      if (c.includes(path)) { try { process.kill(Number(p), "SIGTERM"); } catch {} }
    }
    try { fs.unlinkSync(path); } catch {}
  ' "$BUS_PATH" 2>/dev/null || true
}
if [ -n "${TOOLBOX:-}" ]; then trap bus_stop EXIT INT TERM; bus_start; fi

capture() {
  export XDG_RUNTIME_DIR=$(mktemp -d)
  Xvfb :99 -ac -screen 0 "$SCREEN"x24 >/tmp/ld-xvfb.log 2>&1 & local xp=$!
  sleep 2
  export DISPLAY=:99
  openbox >/tmp/ld-openbox.log 2>&1 & local op=$!
  sleep 1
  export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
  if [ -n "${HOST_APP:-}" ]; then
    # Run the app on the HOST so it inspects the host, not this container. A
    # capture taken inside the toolbox showed "Fedora Linux 42" and container
    # skips — a demo of a container, which is not what the README shows. It
    # still renders HERE: the Xvfb socket lands in /tmp/.X11-unix, which toolbox
    # shares with the host, so DISPLAY=:99 crosses the boundary. flatpak-spawn
    # --host is how the container runs anything on the host.
    # GDK_BACKEND=x11 + no WAYLAND_DISPLAY: on the host the app is Wayland-first,
    # and an inherited WAYLAND_DISPLAY makes it render on the real session
    # instead of this Xvfb (a window on the user's screen, and none here).
    flatpak-spawn --host env -u WAYLAND_DISPLAY \
      DISPLAY=:99 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
      WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
      DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
      sh -c 'echo $$ > /tmp/ld-app.pid; exec "$0"' "$APP" >/tmp/ld-app.log 2>&1 & local ap=$!
  else
    "$APP" >/tmp/ld-app.log 2>&1 & local ap=$!
  fi
  local id="" i=0
  for i in $(seq 1 90); do
    id=$(xdotool search --name "Linux Doctor" 2>/dev/null | head -1 || true)
    [ -n "$id" ] && break
    sleep 1
  done
  if [ -z "$id" ]; then
    echo "app window never appeared (see /tmp/ld-app.log)" >&2
    if [ -n "${HOST_APP:-}" ]; then flatpak-spawn --host sh -c '[ -f /tmp/ld-app.pid ] && kill "$(cat /tmp/ld-app.pid)"' 2>/dev/null || true; fi
    kill $ap $op $xp 2>/dev/null || true
    return 1
  fi
  xdotool windowactivate --sync "$id" 2>/dev/null || true
  if [ -n "$WINDOW" ]; then
    xdotool windowsize "$id" "${WINDOW%x*}" "${WINDOW#*x}" 2>/dev/null || true
  fi
  # The host app takes longer to draw its first report than one running in this
  # container (package cold start, real /proc reads): 7s left "Loading…" on
  # screen for the first few frames.
  if [ -n "${HOST_APP:-}" ]; then sleep 25; else sleep 7; fi

  # Crop to the window's client area, so the frame is the app and nothing else.
  # `getwindowgeometry` reports the client window in root coordinates even when
  # the WM reparents it, so no titlebar sneaks into the crop.
  local crop="$FALLBACK_CROP"
  if geo=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null); then
    eval "$geo" # X= Y= WIDTH= HEIGHT=
    if [ -n "${WIDTH:-}" ] && [ -n "${HEIGHT:-}" ]; then
      crop="${WIDTH}:${HEIGHT}:${X:-0}:${Y:-0}"
    fi
  fi
  [ -n "$EXTRACT" ] && crop="$EXTRACT"
  echo "$crop" > "$FRAMES_DIR/.crop"

  # One frame per step; the dashboard shortcuts drive the UI:
  #   1..5 = views, ArrowDown = focus a card, Enter = open it.
  #
  # Order matters for the story: the report lands on Overview first and HOLDS
  # for ~2s, so the score is what a reader sees before anything moves. Only
  # then does it walk the views, comes back to Overview, and opens a finding.
  i=0
  while [ $i -lt 72 ]; do
    import -window root "$FRAMES_DIR/$(printf %04d $i).png" 2>/dev/null || true
    case $i in
      16) xdotool key 2 ;;
      28) xdotool key 3 ;;
      38) xdotool key 5 ;;
      46) xdotool key 1 ;;
      54) xdotool key Down ;;
      60) xdotool key Return ;;
    esac
    i=$((i + 1))
  done
  # Stop the host app by the pid it wrote (pkill -f would also match the shell
  # command line that starts with APP=…, which hangs this very session).
  if [ -n "${HOST_APP:-}" ]; then flatpak-spawn --host sh -c '[ -f /tmp/ld-app.pid ] && kill "$(cat /tmp/ld-app.pid)"' 2>/dev/null || true; fi
  pkill -x Xvfb 2>/dev/null || true
  pkill -x openbox 2>/dev/null || true
  kill $ap $op $xp 2>/dev/null || true
}

if [ -n "${TOOLBOX:-}" ]; then
  toolbox run -c "$TOOLBOX" -- bash -lc "$(declare -f capture); ROOT='$ROOT' APP='$APP' FRAMES_DIR='$FRAMES_DIR' SCREEN='$SCREEN' WINDOW='$WINDOW' EXTRACT='$EXTRACT' HOST_APP='${HOST_APP:-}' DBUS_SESSION_BUS_ADDRESS='unix:path=$BUS_PATH' capture"
else
  capture
fi

CROP=$(cat "$FRAMES_DIR/.crop" 2>/dev/null || echo "$FALLBACK_CROP")

ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES_DIR/%04d.png" \
  -vf "crop=$CROP,fps=$FPS,scale=$SCALE:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=none" \
  -loop 0 "$OUT"
echo "Wrote $OUT ($(identify -format '%wx%h' "$OUT[0]") · $(du -h "$OUT" | cut -f1))"

if [ -n "$MP4" ]; then
  # Reddit prefers video: a GIF over 20 MB is rejected and anything animated is
  # converted to video anyway. H.264 with faststart plays inline.
  ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES_DIR/%04d.png" \
    -vf "crop=$CROP,fps=$FPS,scale=$SCALE:-2:flags=lanczos" \
    -c:v libx264 -crf 24 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$MP4"
  echo "Wrote $MP4 ($(du -h "$MP4" | cut -f1))"
fi

rm -rf "$FRAMES_DIR"
