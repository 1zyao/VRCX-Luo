# VRCX-K 无头 Docker 部署

在无桌面（headless）Debian 服务器上用 Docker 运行 VRCX-K，用于持续采集
好友动态（Feed）：上下线、状态、Bio、头像、位置变更（L2 WebSocket + L4 轮询）。

不需要服务器预装 .NET / Node / Electron，全部在构建容器内完成。

## 一、准备（只需一次）

1. 本地把 VRCX-K **源码**（修改后的）打包上传到服务器，例如 `/root/vrcx-build/`。
   必须包含：`package.json`、`package-lock.json`、`.npmrc`、`src/`、`src-electron/`、
   `Dotnet/`（不含 obj）、`images/`、`Version`、`deploy/docker/` 等（见仓库根 `.dockerignore`）。
2. 服务器执行（见下方「服务器执行命令」）。

## 二、服务器执行命令

在服务器终端（宝塔终端或任意 SSH）逐条执行：

```bash
# 1) 进入源码目录，确认 Docker 可用
cd /root/vrcx-build
docker version --format 'server: {{.Server.Version}}'

# 2) 构建 VRCX 镜像（首次约 15~30 分钟，保持连接，别关终端）
#    若报 docker compose 不存在，改用备用命令
docker compose -f deploy/docker/docker-compose.yml build
#    备用：docker build -f deploy/docker/Dockerfile -t vrcx-k:latest .

# 3) 启动容器（数据卷 vrcx-k-data 自动创建并持久化）
docker compose -f deploy/docker/docker-compose.yml up -d
#    备用：docker run -d --name vrcx-k --restart unless-stopped \
#          -e TZ=Asia/Shanghai -v vrcx-k-data:/root/.config/VRCX vrcx-k:latest

# 4) 查看启动日志（Ctrl+C 退出日志查看，不影响容器运行）
docker logs -f vrcx-k
```

常用命令：

```bash
docker ps | grep vrcx-k     # 容器状态（Up）
docker logs --tail 100 vrcx-k   # 最近 100 行日志
docker restart vrcx-k       # 重启容器
docker logs -f vrcx-k       # 跟随日志
```

构建常见问题：
- npm / electron 下载慢或失败：Dockerfile 中取消 npm 镜像注释，或检查服务器外网。
- 某个构建步骤失败：把 `docker compose ... build` 的输出末尾错误发回排查。

## 三、日常使用

```bash
# 查看状态 / 日志
docker logs -f vrcx-k
docker ps | grep vrcx-k

# 停止 / 启动 / 重启
docker compose -f deploy/docker/docker-compose.yml stop
docker compose -f deploy/docker/docker-compose.yml start
docker compose -f deploy/docker/docker-compose.yml restart

# 数据在 vrcx-k-data 卷，备份：
docker run --rm -v vrcx-k-data:/data -v "$PWD":/backup alpine tar czf /backup/vrcx-k-data.tar.gz -C /data .
```

## 四、登录（首次需要 GUI，二选一）

1. **本地登录后拷贝**（推荐）：在本地 GUI 的 VRCX 登录一次，把 `~/.config/VRCX`
   整个目录拷进容器卷 `vrcx-k-data`（挂载点 `/root/.config/VRCX`），重启容器即自动登录。
2. **容器内 VNC**：在 Dockerfile runtime 段加装 `x11vnc`，compose 里设 `VNC=1`
   并映射 `5900` 端口，用 VNC 客户端连进去完成扫码/2FA。

## 五、容器里跑了什么

- Xvfb 虚拟显示（`1920x1080x24`）垫底，满足 Electron 创建窗口要求；
- 启动参数 `--no-sandbox --x11 --no-install --no-desktop --no-updater`；
- 会话 DBus 减少系统托盘/通知报错；
- Feed 采集完全走网络（WebSocket + API），不依赖本地 VRChat 游戏日志；
  「进房/退房」（`gamelog_join_leave`）这类依赖游戏日志的 Feed 在无游戏环境缺失。
