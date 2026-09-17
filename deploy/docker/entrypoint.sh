#!/usr/bin/env bash
# VRCX-K 无头容器入口：虚拟显示 + DBus + 后台常驻
set -e

# 容器内无 systemd，手动起一个 session DBus，减少 tray/通知报错
if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
  mkdir -p /run/dbus
  dbus-daemon --session --address=unix:path=/tmp/vrcx-dbus.sock &
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/vrcx-dbus.sock
fi

# 直接启动 Xvfb 虚拟显示（不用 xvfb-run，避免依赖 xauth）
# 分辨率与 VRCX 默认窗口一致（1920x1080），避免窗口超出屏幕
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:99
# 轮询等待 X socket 就绪，避免竞态导致 Electron 报 Missing X
for i in $(seq 1 30); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.5
done

# 可选 VNC / noVNC（网页访问）：设 VNC=1 时启用
#   5900 = VNC 协议；6080 = noVNC 网页（浏览器访问 /vnc.html）
if [ -n "$VNC" ]; then
  if command -v x11vnc >/dev/null 2>&1; then
    ( sleep 2; exec x11vnc -display :99 -forever -shared -rfbport 5900 -nopw ) &
  fi
  if command -v websockify >/dev/null 2>&1; then
    ( sleep 2; exec websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 ) &
  fi
fi

# 关键参数说明（对应 main.js 逻辑）：
#   --no-sandbox   容器内 root 运行 Electron 必须关闭 SUID sandbox
#   --x11          跳过 --ozone-platform-hint=auto 的自动 relaunch（避免容器双实例）
#   --no-install   阻止 AppImage 安装逻辑（移动/建桌面快捷方式）
#   --no-desktop   跳过创建 .desktop 文件
#   --no-updater   关闭自动更新
exec /opt/vrcx/vrcx \
  --no-sandbox --no-install --no-desktop --no-updater --x11
