# Feed 采集租约与 Docker 测试改动说明

本文用于说明当前工作区为验证“多个 VRCX 客户端共享一个 MySQL 数据库时，只有一个客户端写入 Feed”所做的全部改动。

当前改动尚未提交，包含三部分：

1. 跨客户端 Feed 采集租约
2. MySQL 兼容性与错误降噪
3. Docker 多客户端测试环境与 DevTools 支持

## 1. 背景与目标

多个 VRCX 客户端可以同时登录并连接到同一个共享数据库。如果每个客户端都采集并写入 Feed，可能产生重复记录。

当前方案的目标不是判断两个事件是否“内容相同”，而是让共享数据库中的多个客户端竞争一个 Feed 采集租约：

- 只有持有租约的客户端允许写入 Feed
- 未持有租约的客户端直接跳过 Feed 写入
- 持有租约的客户端停止续租后，其他客户端可以在租约过期后接管

## 2. 当前没有实现的内容

本次改动**没有实现 Feed 事件去重**，也没有加入以下内容：

- `FEED_DEDUP_WINDOW_MS`
- `hasRecentDuplicate`
- `dedupInsert`
- 120 秒内容相似去重
- `event_key + UNIQUE` 确定性去重
- Feed 表的普通 `user_id` 索引

原因是目前观察到的 WebSocket 和本地 Feed 事件没有可确认的、跨客户端稳定事件 ID。当前优先采用单一采集节点，避免在没有稳定事件 ID 的情况下误删真实事件。

## 3. 跨客户端采集租约

### 3.1 新增租约服务

新增文件：

```text
src/services/database/feedCollectorLease.js
```

租约表：

```text
collector_leases
```

字段：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `lease_key` | `TEXT PRIMARY KEY` | 租约名称，当前固定为 `feed` |
| `owner_token` | `TEXT` | 当前客户端的随机所有者标识 |
| `expires_at` | `BIGINT` | 租约过期时间，使用 JavaScript 毫秒时间戳 |
| `heartbeat_at` | `BIGINT` | 最近一次续租时间，使用 JavaScript 毫秒时间戳 |

租约参数：

- 续租间隔：10 秒
- 租约 TTL：30 秒
- 续租或抢租失败：立即禁止 Feed 写入
- 客户端进程退出：不主动依赖 logout 释放，等待 TTL 过期

抢租和续租使用条件更新：

```sql
lease_key = @leaseKey
AND (owner_token = @ownerToken OR expires_at <= @now)
```

更新成功且 affected rows 大于 0 时，当前客户端获得写入权。

### 3.2 租约生命周期

主账号登录完成后，在 `authStore.loginComplete()` 中启动租约。

次账号登录完成后，在 `AccountSession.login()` 中启动同一个进程级租约。

因此主账号或任一次账号登录都可以启动租约。`start()` 是幂等的，同一进程不会创建多个续租定时器。

本次没有在主账号 logout 时停止租约，因为租约属于进程而不是单个账号。主账号退出时，次账号可能仍在运行；如果此时释放租约，会导致同一进程的账号写入状态不一致。

### 3.3 Feed 写入守卫

修改 `src/services/database/feed.js`，以下五个主账号 Feed 写入口现在都会先检查租约：

- `addGPSToDatabase`
- `addStatusToDatabase`
- `addBioToDatabase`
- `addAvatarToDatabase`
- `addOnlineOfflineToDatabase`

修改 `src/services/accountSession.js`，以下两个次账号直写入口也会检查租约：

- `_writeGPS`
- `_writeOnlineOffline`

守卫逻辑是：

```js
if (!feedCollectorLease.isOwner()) return;
```

这意味着未持有租约时事件不会写入数据库，而不是先写入再删除重复数据。

### 3.4 数据库初始化

修改 `src/services/database/index.js`：

- 全局数据库初始化时创建 `collector_leases`
- 不在全局数据库初始化阶段自动抢租
- 租约字段使用 `BIGINT`，因为 JavaScript 毫秒时间戳超过 MySQL `INT` 范围

此前 Docker 测试中曾经使用 `INT`，导致错误：

```text
Out of range value for column 'expires_at'
```

现已改为 `BIGINT`。已有测试数据库曾手动执行以下迁移：

```sql
ALTER TABLE collector_leases
  MODIFY expires_at BIGINT NULL,
  MODIFY heartbeat_at BIGINT NULL;
```

新数据库会由代码创建正确的 `BIGINT` 字段。

## 4. MySQL 兼容性修复

### 4.1 Feed UNION 的字符集冲突

修改：

```text
src/services/database/adapter/MySQLAdapter.js
```

Feed 查询使用多个 `UNION ALL` 合并不同 Feed 表。MySQL 测试环境中发现：

- Feed 表文本列使用 `utf8mb4_unicode_ci`
- 连接默认使用 `latin1_swedish_ci`
- `CAST(NULL AS CHAR)` 和 `'GPS' AS type` 等表达式继承了连接字符集
- 最终触发：

```text
Illegal mix of collations for operation 'UNION'
```

MySQL 方言映射现在会：

- 将 `CAST(NULL AS TEXT)` 映射为 `CAST(NULL AS CHAR)`，再显式转换为 `utf8mb4`
- 为空文本表达式添加 `COLLATE utf8mb4_unicode_ci`
- 为 Feed 类型常量 `GPS`、`Status`、`Bio`、`Avatar` 添加统一字符集和排序规则

例如：

```sql
CONVERT(CAST(NULL AS CHAR) USING utf8mb4)
  COLLATE utf8mb4_unicode_ci
```

以及：

```sql
_utf8mb4'GPS' COLLATE utf8mb4_unicode_ci AS type
```

### 4.2 performance_schema 权限不足

`onTableChange` 的 MySQL 完备层会读取：

```sql
performance_schema.table_io_waits_summary_by_table
```

该查询只是外部写检测的计数器兜底，不参与 Feed 写入、Feed 查询或租约。

Docker 中的普通 `vrcx` 用户没有该表的 SELECT 权限，首次查询会产生：

```text
SELECT command denied to user 'vrcx' ...
```

修改 `MySQLAdapter._readChangeCounter()`：

- 第一次查询失败时返回 `null`
- 将当前适配器实例标记为 `changeCounterUnavailable`
- 后续轮询直接返回 `null`
- 不再每 5 秒重复访问没有权限的表

没有给应用用户扩大 `performance_schema` 权限，因为这不是 Feed 主路径所必需的能力。

## 5. Docker 多客户端测试环境

新增：

```text
.dockerignore
deploy/docker/Dockerfile
deploy/docker/docker-compose.yml
deploy/docker/entrypoint.sh
deploy/docker/README.md
```

### 5.1 Compose 服务

默认启动四个容器：

| 服务 | 容器 | 用途 |
| --- | --- | --- |
| `mysql` | `vrcx-mysql` | 共享 MySQL 8.4 数据库 |
| `vrcx1` | `vrcx-1` | VRCX 客户端 1 |
| `vrcx2` | `vrcx-2` | VRCX 客户端 2 |
| `vrcx3` | `vrcx-3` | VRCX 客户端 3 |

三个 VRCX 客户端：

- 使用同一个 MySQL 数据库
- 使用独立的 VRCX 配置卷
- 共享同一个 `vrcx-k:latest` 镜像
- 依赖 MySQL healthcheck 后启动

noVNC 端口：

- 客户端 1：`http://服务器地址:6080/vnc.html`
- 客户端 2：`http://服务器地址:6081/vnc.html`
- 客户端 3：`http://服务器地址:6082/vnc.html`

数据卷：

- `vrcx-mysql-data`
- `vrcx-data-1`
- `vrcx-data-2`
- `vrcx-data-3`

### 5.2 数据库配置生成

应用实际读取的是：

```text
/root/.config/VRCX/VRCX.json
```

不是直接读取 `VRCX_DB_*` 环境变量。

因此 `entrypoint.sh` 在配置文件不存在且数据库模式不是 SQLite 时，根据环境变量生成 `VRCX.json`，包括：

- 数据库模式
- 数据库名称
- 数据库主机和端口
- 用户名和密码

已有配置文件不会被覆盖，避免容器重启时丢失登录信息。

### 5.3 镜像构建

`Dockerfile` 使用多阶段构建：

- Builder：`.NET 9 SDK`
- Node.js 24
- `npm run prod-linux`
- 构建 `VRCX-Electron.csproj`
- 下载 bundled .NET runtime
- 使用 `electron-builder` 打包 Linux Electron 文件
- Runtime：Debian Bookworm slim
- 安装 Xvfb、DBus、x11vnc、noVNC 和 Electron 运行库

构建过程使用了可访问的 Node、Debian、Electron 和 NuGet 镜像源配置，以适应当前网络环境。

### 5.4 容器 DevTools

修改：

```text
src-electron/main.js
```

新增以下启用方式：

```text
--open-devtools
VRCX_OPEN_DEVTOOLS=1
```

Docker Compose 为三个 VRCX 容器设置：

```yaml
VRCX_OPEN_DEVTOOLS: "1"
```

该选项只打开 Chromium DevTools，不会像 `--hot-reload` 一样加载 `localhost:9000`，因此不会因为容器没有开发服务器而加载失败。

## 6. 验证结果

### 6.1 单元测试

已验证：

```text
feed.test.js
feedCollectorLease.test.js
MySQLAdapter.unit.test.js
SQLiteAdapter.test.js
changeNotification.test.js
```

最近一次租约、Feed、SQLite 适配器组合测试结果：

```text
3 test files passed
114 tests passed
```

MySQL 适配器及 change notification 针对性测试此前结果：

```text
73 tests passed
```

同时通过了相关文件的 ESLint、oxfmt 检查和 `git diff --check`。

### 6.2 Docker 运行态

已验证：

- MySQL 容器 healthy
- 三个 VRCX 容器正常运行
- 租约表中存在毫秒时间戳
- Feed 能够写入 MySQL
- Feed UNION collation 错误消失
- 租约时间戳溢出错误消失
- 最近运行日志中不再重复出现 `performance_schema` 权限错误
- noVNC 端口为 6080、6081、6082

测试期间 Feed 表曾观察到以下记录数：

```text
feed_gps:            2
feed_status:        67
feed_bio:           67
feed_avatar:         0
feed_online_offline: 1
```

## 7. 已知限制与需要作者确认的事项

### 7.1 首版租约不是严格 fencing

当前租约没有 epoch/token 写入校验。客户端在租约刚过期、但旧客户端尚未感知失租的极短窗口内，理论上仍可能写入。

如果后续需要严格保证旧客户端不能写入，需要进一步设计：

- lease epoch
- 每次写入携带并校验 epoch
- 数据库端 fencing 条件

这不在当前最小实现范围内。

### 7.2 共享数据库是前提

只有连接到同一个 PostgreSQL/MySQL 数据库的客户端才能通过该租约协调。

默认每台电脑独立的 SQLite 文件无法跨计算机选主；如果客户端各自使用本地 SQLite，该租约只会在各自本地文件内生效，不能实现跨电脑协调。

### 7.3 租约抢占失败时的行为

未持有租约的客户端仍然可以运行、登录和读取数据，但 Feed 写入会被跳过。

当当前 owner 停止续租并超过 30 秒 TTL 后，其他客户端可以接管。接管不是立即发生的，取决于其他客户端下一次续租尝试。

### 7.4 Docker 测试用途

当前 Compose 主要用于验证：

- 多客户端共享 MySQL
- 租约选主
- Feed 写入与查询
- 外部写刷新

无游戏环境不会产生依赖本地游戏日志的所有 Feed 事件，例如部分进房和退房记录。

### 7.5 数据库密码

Compose 中的 MySQL 用户名和密码目前是测试用途的明文默认值：

```text
root / vrcx-root
vrcx / vrcx
```

正式部署前应改为 `.env`、Docker secrets 或其他安全配置方式。

## 8. 运行命令

在仓库根目录执行：

```bash
docker compose -f deploy/docker/docker-compose.yml up -d --build
docker compose -f deploy/docker/docker-compose.yml ps
docker compose -f deploy/docker/docker-compose.yml logs -f vrcx1
```

查看租约：

```bash
docker exec -it vrcx-mysql mysql -uvrcx -pvrcx vrcx \
  -e 'SELECT * FROM collector_leases;'
```

停止测试环境：

```bash
docker compose -f deploy/docker/docker-compose.yml down
```

如果需要同时删除数据库和三个客户端配置卷：

```bash
docker compose -f deploy/docker/docker-compose.yml down -v
```

`down -v` 会删除登录配置和测试数据库，请谨慎使用。
