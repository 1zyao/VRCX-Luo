# 浏览模式（单写多读）设计

> 状态：设计稿（分支 `feat/browse-mode`）
> 关联：PR #19（已转草稿，本设计取代其方向）
> 日期：2026-08-08

## 1. 背景与问题定义

多个 VRCX 实例连接同一数据库（SQLite 文件 / MySQL / PostgreSQL）时，每个实例各自全量采集（L1 游戏日志 / L2 WS / L3 轮询 / L4 全量 + Luo 补全）并写入同一批表，产生双写。PR #19 尝试在写入层做"120s 窗口 + 内容全等"去重，评审确认其存在结构性缺陷：

- **窗口单向**：只覆盖"检测时间差 ≤ 120s"的子集；休眠唤醒、断网重连、慢网络（分钟级偏差）必然漏判；
- **判定不可靠**：MySQL FOR UPDATE 依赖优化器索引路径；SQLite deferred 事务下预检与写入不原子；
- **fail-closed**：预检失败静默丢事件；
- **数据源形态不匹配**：VRC 同账号多端在线是合法常态（约束为实例内唯一）；客户端高频上报导致观测状态秒级抖动；数据源多式多份（账号级 feed / 设备级 gamelog / 服务端消息），去重只覆盖其一。

**结论**：写入层互相去重方向不可行。正解是职责分配——**单写多读**：采集职责集中在运行 VRC 的节点，其余节点以只读方式接入。双写在数据源层面消失，无需任何去重逻辑。

## 2. 目标 / 非目标

### 目标

- 引入 **collector / browse（浏览）双模式**：collector 保持现有采集+写入行为；browse 只读展示、不写任何业务表；
- **节点活跃检测**：启动时与运行中检测其他活跃实例，browse 模式自动生效（显式配置为主，自动检测为辅）；
- **UI 刷新**：browse 端基于现有 `onTableChange` 通道感知数据变化并重查（秒级），不引入额外轮询；
- **人性化 UX**：模式横幅/常驻徽章、明确文案、禁用项置灰、可选的"接管为写入者"操作；
- **硬兜底**：browse 模式使用数据库只读连接，代码层写入门禁 + 数据库层拒绝双保险。

### 非目标（本阶段）

- 不做多节点分工采集（如按账号前缀分片到不同节点）——引导用户"单实例内登录多账号"（VRCX 已支持 AccountHub）；
- 不做 browse 端实时通知（通知依赖事件流处理，browse 端仅基于数据变化刷新）；
- 不落地完整消息总线（`node_bus` 推迟；本阶段仅需 `node_registry` 心跳表）；
- 不做数据库连接级杀操作（MySQL `KILL CONNECTION` / PG `pg_terminate_backend`）：需特权且会打断进行中事务，风险大于收益。

## 3. 架构决策

### D1：单写多读模型

| 模式 | 采集（L1~L4） | 业务写（feed/gamelog/friendLog 等） | 数据读取 |
|---|---|---|---|
| `collector` | ✅ | ✅ | ✅ |
| `browse` | ❌ | ❌ | ✅（onTableChange 刷新） |

### D2：模式判定——显式配置为主，自动检测为辅

- 显式：`VRCXStorage` 配置 `VRCX_NodeMode: 'collector' | 'browse' | 'auto'`（默认 `auto`）；
- 自动（`auto`）：启动时查询 `node_registry`，发现其他活跃 collector 节点 → 进入 browse 并提示；无 → 成为 collector 并注册心跳；
- **不做运行中自动升级**（心跳过期不自动抢占写入权，避免双写窗口），恢复写入需用户操作或重启。

### D3：硬兜底——只读连接

browse 模式下数据库连接使用只读连接串（SQLite `Read Only: True` 已支持；PG/MySQL 对应只读连接参数）。即使代码层门禁遗漏，数据库层拒绝写入。

### D4：写入门禁

- `database.*` 所有写方法（feed/gameLog/friendLogHistory 等）在 browse 模式 no-op（集中门禁，放在 adapter 或 database 聚合层）；
- 各 coordinator 采集入口（L1 LogWatcher / L2 WS 写库 / L3 轮询写库 / L4 同步 / Luo 补全）在 browse 模式跳过。

### D5：UI 刷新通道

复用 EngineAdapter `onTableChange` 完备层（现成实现：SQLite `PRAGMA data_version` / PG `xact_commit` / MySQL 计数器，订阅驱动、无订阅零轮询，精确语义为"外部写者检测器"）。browse 端对订阅表重查（静默模式，参考 PR #19 的 `feedTableLookup({silent: true})` 思路）。

### D6：节点检测——`node_registry` 心跳表

```sql
node_registry (
  node_id      TEXT PRIMARY KEY,      -- 实例唯一 ID（启动时生成）
  mode         TEXT NOT NULL,         -- 'collector' | 'browse'
  prefixes     TEXT NOT NULL,         -- 本实例登录账号前缀列表（逗号分隔）
  heartbeat_at TEXT NOT NULL          -- 最近心跳（ISO）
)
```

- 心跳：collector 每 30s upsert；TTL 判定 120s（**用 TTL 而非时间戳比较，规避时钟偏差**；心跳写入由 `withTransaction` outbox 语义保证与业务写原子提交时仅记心跳即可）；
- 检测：启动与每 60s 扫描，`heartbeat_at` 新鲜且 `node_id != self` 且前缀重叠 → 判定"其他活跃实例"；
- 前缀重叠判断：同前缀（同账号）必然冲突；不同前缀仅 gamelog 全局表冲突——本阶段保守处理：**任何其他活跃实例均触发降级提示**（引导语引导单实例多账号）。

### D7：接管为写入者（协商式）

- browse 端 UI 提供"接管为写入者"：更新 `node_registry` 中自身 `mode='collector'` 并递增全局 fencing 版本号；
- 对方在下一心跳轮询发现 fencing 版本变化 → 优雅降级为 browse（避免双写窗口）；
- 对方无响应（崩溃/网络分区）→ 本地 TTL 过期后自行恢复为 collector（用户确认后）；
- **不做**数据库连接 KILL（见非目标）。

### D8：消息总线（推迟至后续里程碑）

如需节点间交换 in-flight 数据（事件认领、轮询游标），采用数据库消息总线模式：`node_bus` 消息表 + 唤醒信号 + 自增 id 游标 + outbox 事务。引擎差异：
- PG：`LISTEN/NOTIFY` 唤醒（毫秒级，当前代码未落地，需新增）；
- MySQL：无推送 → 自建 `node_version` 版本计数器表（同事务 bump）+ 1~5s 轮询（**不依赖 performance_schema 权限**）；认领可用 `FOR UPDATE SKIP LOCKED`（MySQL 8.0+ / MariaDB 10.6+）；
- SQLite：文件锁 + data_version（同机场景）。
本阶段仅实现 `node_registry`，`node_bus` 留接口。

## 4. UX 设计

### 文案（草案）

- 标题：**浏览模式（只读）**
- 检测到其他活跃实例：
  > 检测到另一个 VRCX 实例正在使用此数据库，已进入浏览模式（只读）。
  > 对方退出或失去连接后，可手动恢复写入。
  - ⚠️ 禁用"登陆"措辞：用户会误以为是 VRChat 账号被盗。
- 多账号引导（浏览模式横幅内）：
  > 如需监听多账号，请在单个 VRCX 实例内登录多个 VRC 账号。
- 接管按钮：
  > 接管为写入者
  - 点击 → 确认对话框（"接管后对方将停止采集，其数据将不再更新，确定？"）
  - 成功 → 恢复写入，横幅消失
  - 失败 → "未能联系到对方，已尝试强制接管；对方恢复连接后将自动降级"
- 自动恢复：不自动恢复（见 D2），提示"检测到对方已离线，可手动恢复写入"。

### 交互要求

- 常驻状态：标题栏/状态栏常驻"浏览模式"徽章（非一次性 toast）；
- 禁用项置灰：设置、登录新账号、手动操作入口在 browse 模式置灰 + 悬停提示；
- 本地双实例测试场景：提供"始终以浏览模式启动"开关，避免每次启动弹窗；
- 运行中降级：对方上线 → 当前实例降级为 browse 并提示（降级前检查是否有未完成写事务）。

## 5. 基建复用清单

| 基建 | 位置 | 状态 |
|---|---|---|
| `onTableChange` 完备层（外部写者检测） | `EngineAdapter.js` + 三引擎计数器 | ✅ 已实现 + 测试 |
| 只读连接串 | SQLiteAdapter `_buildConnectionString`（`Read Only`）等 | ✅ 已支持 |
| 账号前缀体系 | `userTable(prefix, name)` | ✅ 已实现 |
| `withTransaction` 栈 | EngineAdapter | ✅ 已实现（outbox 语义基础） |
| `VRCXStorage` 配置体系 | CONFIG_REFACTOR 设计 | ✅ 已实现 |

## 6. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 最小可用** | `VRCX_NodeMode` 配置 + database 写入门禁 + browse 只读连接 | browse 模式零写库（连接层拒绝验证）；collector 行为不变 |
| **M2 检测与 UI** | `node_registry` 心跳 + 启动检测 + 横幅/徽章 + 文案 + 禁用项置灰 | 双实例场景自动进入 browse 并正确提示 |
| **M3 动态切换** | 运行中检测降级 + 手动恢复 + 本地测试开关 | 对方上线/离线时模式正确流转，无双写窗口 |
| **M4 接管协商** | fencing 版本号 + 接管按钮 + 失败反馈 | 接管后唯一写入者；对方优雅降级 |
| **M5 消息总线（可选）** | `node_bus` + 版本计数器唤醒（MySQL 自建 / PG NOTIFY） | 节点间 claim/cursor/state 消息可用 |

## 7. 风险与已知边界

- **SQLite data_version**：仅在 WAL + 同机/同文件场景有效；跨机 SQLite 共享本身应避免（网络文件系统锁不可靠）；
- **心跳时钟偏差**：新鲜度一律 TTL 判定，不做时间戳比较；
- **gamelog 全局表**：多账号多实例共享库时 gamelog 7 张表无前缀隔离、存在混写——本阶段通过引导语（单实例多账号）规避，不做 schema 改动；
- **误报**：同机双实例（测试）触发降级 → 提供显式模式配置/开关绕过；
- **降级中断**：运行中降级需先完成/回滚进行中的写事务（withTransaction 栈保证原子性）；
- **只读连接语义差异**：PG/MySQL 只读连接需验证与现有连接串/池的兼容（C# 桥层）。

## 8. 与 PR #19 的关系

- PR #19 方向性搁置（已转草稿），其 120s 窗口去重、FOR UPDATE、碰撞信号均不进入本分支；
- 保留价值：`onFeedExternalWrite` 的"静默重查"思路并入 D5（onTableChange 订阅重查）；
- 其 globals.d.ts connId 修正可独立提取（SQLite/PG 声明同样缺失，一并补齐）。

## 9. 参考

- 评审：PR #19 review（XChen446 详细评审 + kipfel-bot 独立见解）
- 相关文档：DATA_REFRESH.md（数据源分层）、ADAPTER_API.md §9（onTableChange 消费方指南）、TRANSACTION_DESIGN.md（outbox 事务基础）
