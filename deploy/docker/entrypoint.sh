#!/usr/bin/env bash
# VRCX-K 无头容器入口：虚拟显示 + DBus + 后台常驻
set -euo pipefail

DISPLAY_NUM=99
DISPLAY=":$DISPLAY_NUM"
X_SOCK="/tmp/.X11-unix/X$DISPLAY_NUM"

cleanup() {
  echo "[entry] cleaning up..."
  for p in "$VNCX_PID" "$WEBPID" "$VRCX_PID" "$XVFB_PID" "$DBUS_PID"; do
    [ -n "${p:-}" ] && kill "$p" 2>/dev/null || true
  done
  # 彻底清掉 X 锁，避免下次启动报 "Server is already active for display 99"
  rm -f "/tmp/.X$DISPLAY_NUM-lock" "$X_SOCK"
  wait 2>/dev/null || true
}
trap cleanup EXIT TERM INT

# 1) 先清残留锁（上次非正常退出会留下，正是之前 Fatal error 的原因）
rm -f "/tmp/.X$DISPLAY_NUM-lock" "$X_SOCK"

# 2) session DBus，减少 tray/通知报错
if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
  mkdir -p /run/dbus
  DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/vrcx-dbus.sock" \
    dbus-daemon --session --address="unix:path=/tmp/vrcx-dbus.sock" --fork
  export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/vrcx-dbus.sock"
  export XDG_RUNTIME_DIR=/tmp/vrcx-runtime
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
fi

# 3) 启动 Xvfb。-ac 关闭 X 鉴权：headless 场景无安全顾虑，
#    却能免去 x11vnc/Electron 的 MIT-MAGIC-COOKIE 鉴权问题（之前日志里的报错）
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp -ac &
XVFB_PID=$!
export DISPLAY="$DISPLAY"

# 4) 等 X 真正可用，而不是只看 socket 文件存在。
#    优先用 xdpyinfo 探测（能连上才算就绪），否则退化为 socket+延时。
wait_for_x() {
  for i in $(seq 1 30); do
    if command -v xdpyinfo >/dev/null 2>&1; then
      xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && return 0
    elif [ -S "$X_SOCK" ]; then
      sleep 1 && return 0
    fi
    sleep 0.5
  done
  echo "[entry] X server on $DISPLAY did not come up in time" >&2
  exit 1
}
wait_for_x
echo "[entry] X ready on $DISPLAY"

# 5) 可选 VNC / noVNC：VNC=1 时启用
if [ -n "${VNC:-}" ]; then
  if command -v x11vnc >/dev/null 2>&1; then
    x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw &
    VNCX_PID=$!
  fi
  if command -v websockify >/dev/null 2>&1; then
    websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &
    WEBPID=$!
  fi
  # 等 5900 真的开始监听（x11vnc 从启动到就绪有一两秒）
  for i in $(seq 1 20); do
    if (exec 3<>/dev/tcp/127.0.0.1/5900) 2>/dev/null; then exec 3>&-; break; fi
    sleep 0.5
  done
fi

# 6) 关键参数：--no-sandbox / --x11 / --no-install / --no-desktop / --no-updater
#    改用后台 + wait：容器退出时 trap 能触发清理，保证下次启动无残留锁
/opt/vrcx/vrcx --no-sandbox --no-install --no-desktop --no-updater --x11 &
VRCX_PID=$!
wait "$VRCX_PID"