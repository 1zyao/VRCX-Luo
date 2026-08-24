# VRCX-K 无头 Docker 部署

在没有桌面环境的 Debian 服务器上运行 VRCX-K，使用 WebSocket 和 VRChat API 持续采集 Feed。
Compose 默认启动一个 MySQL 和三个 VRCX 容器，三个客户端共享同一个数据库，用于验证 Feed 采集租约。

## 构建与启动

在仓库根目录执行：

```bash
docker compose -f deploy/docker/docker-compose.yml build
docker compose -f deploy/docker/docker-compose.yml up -d
docker compose -f deploy/docker/docker-compose.yml ps
docker logs -f vrcx-1
```

首次构建会在容器内完成 Node、前端、.NET 后端和 Electron Linux 包构建，通常需要较长时间。三个 VRCX 服务共用同一个构建镜像，但使用独立配置卷。

noVNC 地址：

- `http://服务器地址:6080/vnc.html`：VRCX 1
- `http://服务器地址:6081/vnc.html`：VRCX 2
- `http://服务器地址:6082/vnc.html`：VRCX 3

MySQL 数据保存在 `vrcx-mysql-data`，三个 VRCX 的登录配置分别保存在 `vrcx-data-1`、`vrcx-data-2`、`vrcx-data-3`。

```bash
docker compose -f deploy/docker/docker-compose.yml stop
docker compose -f deploy/docker/docker-compose.yml start
docker compose -f deploy/docker/docker-compose.yml restart
```

首次登录可以通过 noVNC 完成扫码或二次验证。无游戏环境不会产生依赖本地游戏日志的 Feed 事件，例如进房和退房记录。

查看租约表：

```bash
docker exec -it vrcx-mysql mysql -uvrcx -pvrcx vrcx \
  -e 'SELECT * FROM collector_leases;'
```
