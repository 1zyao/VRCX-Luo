#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM=99
DISPLAY=":$DISPLAY_NUM"
X_SOCK="/tmp/.X11-unix/X$DISPLAY_NUM"

cleanup() {
  echo "[entry] cleaning up..."
  for p in "${VNCX_PID:-}" "${WEBPID:-}" "${VRCX_PID:-}" "${XVFB_PID:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
  rm -f "/tmp/.X$DISPLAY_NUM-lock" "$X_SOCK"
  wait 2>/dev/null || true
}
trap cleanup EXIT TERM INT

rm -f "/tmp/.X$DISPLAY_NUM-lock" "$X_SOCK"

CONFIG_DIR="${XDG_CONFIG_HOME:-/root/.config}/VRCX"
CONFIG_FILE="$CONFIG_DIR/VRCX.json"
if [ ! -f "$CONFIG_FILE" ] && [ "${VRCX_DB_MODE:-sqlite}" != "sqlite" ]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<EOF
{
  "VRCX_Database": {
    "mode": "${VRCX_DB_MODE}",
    "name": "${VRCX_DB_NAME:-vrcx}",
    "host": "${VRCX_DB_HOST:-mysql}",
    "port": "${VRCX_DB_PORT:-3306}",
    "username": "${VRCX_DB_USERNAME:-vrcx}",
    "password": "${VRCX_DB_PASSWORD:-vrcx}"
  }
}
EOF
  echo "[entry] created database config for ${VRCX_DB_MODE} at $CONFIG_FILE"
fi

mkdir -p /run/dbus
if [ ! -S /tmp/vrcx-dbus.sock ]; then
  dbus-daemon --session --address="unix:path=/tmp/vrcx-dbus.sock" --fork
fi
export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/vrcx-dbus.sock"
export XDG_RUNTIME_DIR=/tmp/vrcx-runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp -ac &
XVFB_PID=$!
export DISPLAY

for _ in $(seq 1 30); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "[entry] X server on $DISPLAY did not come up in time" >&2
  exit 1
fi

if [ -n "${VNC:-}" ]; then
  x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw &
  VNCX_PID=$!
  websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &
  WEBPID=$!
fi

/opt/vrcx/vrcx --no-sandbox --no-install --no-desktop --no-updater --x11 &
VRCX_PID=$!
wait "$VRCX_PID"
