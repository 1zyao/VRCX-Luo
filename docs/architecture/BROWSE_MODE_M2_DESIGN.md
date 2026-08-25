# 浏览模式 M2 检测与 UI — 实现设计

> 状态：已通过双评审（scrum-master + product-manager 均有条件通过，2026-08-14）并完成修订整合，待实现
> 分支：`feat/browse-mode`
> 依据：`docs/architecture/BROWSE_MODE_DESIGN.md` §3(D6)/§4(UX)/§6(M2)/§7 + `docs/architecture/BROWSE_MODE_M1_DESIGN.md` §0/§1.2/§2.1/§2.6/§3(M5/M6)/§4.4/§5/§6.3/§8(R1/R7/R8) + 本次任务 Context Brief 的 11 个设计缺口
> 日期：2026-08-14
> 事实来源说明：任务模板中 Context Brief 占位为空（未注入），本设计所有"已核实事实"均以仓库代码直接核实（行号引用即证据），11 个缺口逐条裁决。

## 0. 变更摘要（评审发现 → 处理位置）

| 评审发现/预期评审点 | 级别 | 处理 | 修订位置 |
|---|---|---|---|
| **G0（新发现）**：M1 §6.2 声称 "Dotnet.Tests（xUnit，CI 全自动）"，但现 `.github/workflows/ci.yaml` 无任何 `dotnet test` 步骤（仅 build + vitest）；`github_actions.yml` 亦无 | MEDIUM | 事实修正：Dotnet.Tests 当前仅在本地运行；M2 在 test_mysql/test_pgsql job 内补 `dotnet test --filter` 步骤承载 PG/MySQL 真库只读用例（§5.3） | §3 M26、§5.3、§7 R-13 |
| 缺口 1：auto 时序（readOnly 与检测先后） | HIGH | 定案方案 b：auto 检测在 JS（vrcx.js init()），发现其他活跃 collector → `downgradeToReadOnly()`（initAdapter 重调用换绑门禁，M1 MEDIUM-3 短路径已支持）；连接层只读缺口文档声明（R-9）；否决二次初始化与先探测后建连 | §2.1 |
| 缺口 2：node_registry 写入在 browse 门禁下自注册 | HIGH | 定案方案 a：browse 不写注册表（无豁免）；表 mode 枚举保留 'browse' 备 M4 | §2.2 |
| 缺口 3：心跳 outbox 语义 | MEDIUM | 定案：独立 30s upsert 心跳（单语句原子），不随业务写事务、不引入 outbox 表；D6 :74 澄清 | §2.3 |
| 缺口 4：存量库建表路径 | HIGH | 三引擎 initGlobalSchema（IF NOT EXISTS 已核实）+ SQLite v17 .map + TARGET 16→17 + 检测容错"表缺失→collector"（fail-safe 论证） | §2.4、§3 |
| 缺口 5：心跳挂载点 + 60s 扫描划界 | HIGH | 独立 service `src/services/database/nodeRegistry.js` + workerTimers.setInterval（accountSession._startPolling 模式）；60s 运行中扫描**完全归 M3** | §2.5 |
| 缺口 6：检测查询引擎依赖 | MEDIUM | 单例 adapter + M8 正则容错模板复用 | §2.6 |
| 缺口 7：登录禁用挂点 | HIGH | UI 置灰 + 函数级 guard 双层；autoLoginAfterMounted 允许（只读会话展示）；migrateStoredUsers 不禁用（语义细查结论）；L2 WS 随会话自然建立 | §2.7 |
| 缺口 8：未登录 collector 的 prefixes | MEDIUM | 空 prefixes 仍触发（保守一致性；未登录 collector 仍写全局 gamelog 表） | §2.8 |
| 缺口 9：缺文件对话框链路 | MEDIUM | 已补查 C# Init 异常跨桥链路（main.js:161-176/203-208、Program.cs:295-314/185-225）；双形态对话框挂点定案 | §2.9 |
| 缺口 10：PG/MySQL 只读与 createAdapter/OnConnection 交互 | MEDIUM | 只读串仅 C# Init 默认连接；DataSourceCache 按连接串隔离天然共存；测试覆盖共存 | §2.10 |
| 缺口 11：L1-L4 入口跳过 | HIGH | updateLoop 门控加 `!isBrowse`（一行）；L2 不专门处理；Luo 补全单点 guard；R5 空转归零 | §2.11 |
| 迁移等值测试影响面 | LOW | SQLiteAdapter.test.js:1099 计数断言 `>= 14` 不受影响（追加 node_registry 后仍成立）；idempotent 测试不受影响；spot-check 补 node_registry | §3 M16 |
| **评审修订**（scrum-master 有条件通过 + product-manager 有条件通过，2026-08-14 双评审） | —— | 23 条发现全部修订落地：① product-manager 10 条（H1 快速重启自我误检定案、H2 L1 线程声明更正、R-9 披露、R8 措辞如实化、§11 发布说明、§8 引用更正、un-gate 风险、横幅文案、MySQL 回调前提、i18n 占位策略）；② scrum-master 13 条（H-1 切片撕裂、H-2 PG env 作用域、M-1/M-2/L-1/L-2/L-3 行号漂移、M-3/M-4/M-5 测试落点、L-4/L-5/L-6 文档问题）。逐条修订位置见全文各节（§1/§2/§3/§4/§5/§7/§8/§9/§10）及新增 §11 | 全文（§1/§2/§3/§4/§5/§7/§8/§9/§10/§11） |

## 1. 目标 / 非目标

### 1.1 M2 目标（本设计范围）

1. **`node_registry` 心跳表**（D6 表结构）+ collector/auto 每 30s 心跳 upsert + TTL 120s 新鲜度判定（不比较时间戳）。
2. **`auto` 模式启动检测**：查询 node_registry 发现其他活跃 collector → 自动进入 browse（JS 门禁降级 + UI 提示）；无 → 成为 collector 并注册心跳。**运行中检测降级归 M3，本设计不实现**（划界见 §2.5）。
3. **PG/MySQL 连接层只读**：C# `PostgreSQL.cs::Init()` 追加 `Options=-c default_transaction_read_only=on`；`MySQL.cs::Init()` 改 `MySqlDataSourceBuilder` + `UseConnectionOpenedCallback` + `SET SESSION TRANSACTION READ ONLY`（M1 H-3 定案工作项，机制已按 pin 版驱动验证）。
4. **coordinator L1-L4 采集入口跳过**（browse 模式）：L1 的 C# 采集线程按 **raw `VRCX_NodeMode`** 门控（LogWatcher.cs:52 `NodeMode.IsBrowseMode()`）——仅**显式 browse** 不启动线程；**auto 下 C# 判定 ≡ collector，采集线程照常启动**，auto 检测降级为 browse 后线程仍运行、DB 写被 JS 门禁丢弃（M1 §2.6 回退语义；"JS→C# 停线程 IPC"归 M3 候选，见 §2.11 注记）；剩余 LINUX 轮询路径、L2 WS、L3 轮询、L4 同步、Luo 补全按 §2.11 定案（回退语义取舍按 M1 §2.6 评审点定案）。
5. **UI**：模式横幅 + 状态栏常驻徽章 + 文案（i18n）+ 禁用项置灰（登录/设置/手动操作入口）。接管按钮归 M4，不做。
6. **browse 账号前缀错配**：查询层容错（复用 configRepository M8 模板）+ 登录禁用。
7. **缺文件友好对话框**（替代 M1 fail-fast 裸错误）。
8. **活库/人工验证脚本**：PG/MySQL 连接层只读验证（Dotnet.Tests env-gated 真库用例 + CI 挂接，§5.3/§5.4）。
9. **三引擎 schema**：node_registry 三处 initGlobalSchema 初始化 + SQLite v17 `.map` 迁移 + `TARGET_DB_VERSION` 16→17 + migrationEquivalence 测试扩展。

### 1.2 非目标（明确不做，划界表）

| 内容 | 归属 | 依据 |
|---|---|---|
| 运行中检测降级（对方上线 → 本实例自动降级 browse） | M3 | 设计 D2「不做运行中自动升级」；M2 范围声明 |
| 手动恢复写入（对方离线后恢复 collector） | M3 | 设计 §4 UX「自动恢复：不自动恢复」 |
| 本地测试开关（"始终以浏览模式启动"） | M3 | 设计 §4 交互要求 |
| 接管按钮与 fencing（mode 枚举 'browse' 值写入、fencing 版本号） | M4 | 设计 D7 |
| `node_bus` 消息总线 | M5 | 设计 D8 |
| 运行中模式动态切换（热换 Store/热重连） | M3 | M1 §1.2「启动即定」 |
| 60s 运行中扫描（含提示-only 扫描） | M3 | 本设计 §2.5 划界定案 |
| VRCXStorage（JSON）写入门禁 | 不做 | M1 §1.2（非数据库面） |
| `createAdapter` 实例门禁 | 不做 | M1 §4.5 边界声明（调用方自控连接串） |

## 2. 架构决策（11 个设计缺口定案）

### 2.1 缺口 1：auto 时序 — 定案方案 b（JS 门禁降级 + 连接层缺口文档声明）

**已核实事实链**：
- C# Init 先于 JS：CefSharp `Program.cs::Run()` :295-314 建连后 CEF 才启动；Electron `main.js`:161-176 在渲染进程加载前建连（M1 时序铁律 #1）。**连接形态（只读/可写）启动即定**。
- C# 侧模式判定在 Init 内完成（`SQLite.cs`:203-204 读 VRCX_NodeMode → :264-271 只读串分支）；`auto` 在 C# 层 ≡ collector（M1 决策 2，NodeMode.cs `Normalize` :49）。
- JS 检测必须**先建连才能读库**（读 node_registry 走 adapter）→ 检测发生在连接建立之后，连接形态不可能因检测结果而改变。
- 门禁换绑机制现成：`adapter/index.js` :317-320（同模式短路径 `_applyReadOnlyGate`）与 :300（sqlite 分支），`let adapter` + live ESM binding 保证换绑后所有 importers 生效（M1 §2.2 已实现并测试）。

**候选评估**：

| 候选 | 可行性（逐引擎） | 结论 |
|---|---|---|
| a) 启动期二次初始化 | SQLite：C# Init 进程级一次性（Program.cs/main.js 单点调用）；池连接已按旧串建立（SQLite.cs ConnectionCache :96/755/810 按串隔离但单例 `_connectionString` 重设不清池）；JS 无重连协议。PG/MySQL：DataSourceCache（PostgreSQL.cs:280 / MySQL.cs:95）按连接串隔离、可二次 Build 只读 DataSource，但 JS adapter 单例无换源机制 → 需新增 C# 重建 API + JS 重连协议 | **否决**：侵入启动链路，改动面大收益低 |
| b) auto 降级 = JS 代码门禁（initAdapter 重调用换绑）+ 文档声明连接层缺口 | 三引擎同构：`downgradeToReadOnly()` = `initAdapter(adapter.engineType, { readOnly: true })`；engineType 值 'sqlite'/'postgresql'/'mysql' 与 `_normalizeMode` 令牌一致，短路径换绑（:317-320）与 sqlite 分支（:296-301）均正确；WeakSet 幂等（index.js:101-109） | **采纳**（理由见下） |
| c) 先探测后建连 | CefSharp：C# Init 在浏览器加载前（Program.cs:295-314），JS 探测物理上不可能先于 C# 建连；Electron：需新增主进程 IPC 探测通道 + 双进程握手；SQLite 探测本身也需先开库（只读探测连接可开，但无法把结果传回 C# Init） | **否决**：M2 不重构启动链路；记录为 M3+ 候选（若 M3 需要连接层兜底，可在 C# 侧新增二次建连 API） |

**定案（方案 b）**：
- `auto` 启动检测在 JS（vrcx.js init()，详见 §2.6 伪代码）；发现其他活跃 collector → `downgradeToReadOnly()` 换绑门禁实例 → 走 browse 旁路（升级树跳过）。
- **缺口声明（新增风险 R-9）**：auto 检测降级的 browse 无数据库连接层只读兜底（三引擎均如此——连接串在 C# Init 已定为可写形态）。与 M1 R7 同模式：第一道防线（代码门禁）完整保证零写库，连接层兜底缺口显式声明。显式 `browse` 的连接层只读不受影响（SQLite 已实现；PG/MySQL 为本次 M2 工作项）。
- 检测查询与心跳写入时序：检测在 `resolveDatabaseInit()`（vrcx.js:308）之前完成，保证 UI 门禁打开前模式已定。
- 注意：`interopApi.js`:140 `configRepository.init()`（createTable('configs')）发生在检测之前（auto 下未门禁）——CREATE TABLE IF NOT EXISTS 幂等，最坏副作用是旧库上补建 configs 表（无害，browse 也读它）；文档声明即可。

### 2.2 缺口 2：browse 门禁下的自注册 — 定案方案 a（browse 不写注册表，无豁免）

- **定案**：browse 节点不写 node_registry。检测只认 `mode='collector'` 且心跳新鲜的行；表 `mode` 枚举保留 `'browse'` 值（D6 DDL 注释声明），M2 不写入，备 M4 接管（fencing）使用。
- **与 M1 backstop 原则的一致性**：`upsertPartial` 已在 21 方法名单（readOnlyGate.js:38）→ browse 下即使代码误调心跳也 no-op（守恒返回 0），与"browse 零写库"原则完全一致。**单表豁免会破坏 backstop 完整性**（豁免表即后门），否决方案 b。
- 心跳只由 collector/auto-无对手 执行 → 名单中的 upsertPartial 在 browse 下永不激活，无冲突（§4.3）。

### 2.3 缺口 3：心跳 outbox 语义 — 定案"独立 30s upsert 心跳"

- **D6 :74 澄清**："心跳写入由 withTransaction outbox 语义保证与业务写原子提交时仅记心跳即可"表述有歧义。**定案**：心跳 = 独立 30s `upsertPartial` 单语句（单语句自带原子性），**不随业务写事务、不引入 outbox 表**。
- 理由：心跳是周期冗余数据——丢失一拍由下一拍（30s 后）补上，无业务原子性要求；随业务写事务反而把心跳写入失败与业务失败耦合（业务回滚时心跳也回滚，违背心跳"常驻"意图）。
- 与 withTransaction 的关系：心跳不需要 withTransaction 包裹；若 M4 引入 fencing 版本号需要与业务写原子提交，届时再评估（当前无此需求）。
- 心跳走单例 adapter 正常写路径（collector 未门禁）；失败容错（catch + 下一拍重试，§4.2）。

### 2.4 缺口 4：存量库建表路径 — 三处 initGlobalSchema + v17 迁移 + 检测容错降级 collector

- **新库**：三引擎 `initGlobalSchema` 追加 node_registry DDL——已核实三引擎全部使用 `CREATE TABLE IF NOT EXISTS`（SQLiteAdapter.js:1057+ / PgSQLAdapter.js:1435+ / MySQLAdapter.js:1032+），追加即幂等（§4.1 DDL）。
- **存量库升级**：SQLite 新增 `migrations/17/schema.map`（v17）→ `TARGET_DB_VERSION` 16→17（vrcx.js:51、vrcx.test.js:134）；collector 启动走 Branch A 升级树（vrcx.js:220-225）时执行。PG/MySQL 无版本迁移机制（initGlobalSchema 幂等兜底，与现有 16 张全局表同路径）。
- **browse 旧库（v16，node_registry 不存在）启动 auto**：检测查询抛表缺失类错误 → 容错降级为"未发现节点 → collector"（M8 正则模板，configRepository.js:38-41）。
- **fail-safe 方向论证**（选"表缺失→collector"而非反向）：
  1. 反向（表缺失→browse）会让**所有 v16 升级用户**（单实例最常见场景）失去写入能力——collector 必须显式配置或删配置，不可接受；
  2. "双写窗口"最坏情形 = 两个**新 build** 同时启动且都未见表（启动竞态）→ 各自成为 collector 双写——但这是**启动竞态**（§2.5 划界：由 M3 运行中扫描兜底），且表在首次心跳 upsert 后即存在，后续启动不再复现；
  3. 旧 build 与旧 build 共存本无 browse 概念（现状即双写），非 M2 引入的回归；
  4. 与 M1 归一化契约一致（fail-safe：判定错误的最坏后果是"collector 照常运行"，绝不反向造成 browse 误判）。**例外注记（H1 评审发现）**：本节点**上一会话**的残留行（快速重启自我误检）恰是"反向 browse 误判"——正常退出路径由 §2.5 定案的优雅退出删除本节点行消除矛盾；仅崩溃残留窗口（崩溃后 ≤120s 内重启）仍可能自我误检，该窗口接受（方向安全：误入 browse 零写库，TTL 过期自愈），见 R-14 与 §5.4 人工 #8。
- 注意：两新 build 同时起且都执行 v17 迁移——迁移运行器有幂等保护（migrationTransactionProtection 既有测试），无破坏性。

### 2.5 缺口 5：心跳挂载点 + 60s 扫描划界

- **挂载点**：独立 service `src/services/database/nodeRegistry.js`（新增 N1），**不挂 updateLoop**（isLoggedIn 门控 + browse 顶层跳过下会停摆，且心跳属数据面非 UI 轮询）。
  - 心跳循环：`workerTimers.setInterval(30_000)`（参照 `accountSession._startPolling`，accountSession.js:548-556 模式）；
  - 启动时序：vrcx.js `init()` 内 auto/collector 分支调用 `startHeartbeat('collector')`（**resolveDatabaseInit() :308 之前**，保证 UI 门禁打开时心跳已注册）；显式 browse 分支不调用。
  - node_id：**每会话随机生成**（`crypto.randomUUID()`，回退 `'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)`）。**不可持久化到 VRCXStorage**——同机双实例共享同一 VRCX.json，持久化会使两实例 node_id 相同、自排除失效、检测失明（SQLite 同机双开场景正是 M2 检测的主目标之一）。
  - **H1 快速重启自我误检（评审发现，定案）**：node_id 每会话随机 + 不注册退出清理 → 单实例退出后 120s 内重启会看到**自己上一会话的陈旧行**（心跳新鲜、node_id 不同）→ 误入 browse。**定案（二选一：采纳"优雅退出删除 + TTL 兜底"）**：
    - **优雅退出删除本节点行**：`nodeRegistry.js` 新增 `removeOwnRow()`（`adapter.delete('node_registry', { node_id })`）与 `stopHeartbeat()`；vrcx.js init() 内注册 `window.addEventListener('beforeunload', ...)`（Electron 与 CefSharp 渲染进程关闭均触发）→ fire-and-forget `removeOwnRow()`；**兜底**：main.js 退出路径与 Program.cs 主窗体关闭后延迟 ≤1s 再退出（确保桥侧 delete 落地，具体时序实现会话细化）。
    - **崩溃场景**：钩子不执行 → 行残留由 TTL 120s 兜底；崩溃后 ≤120s 重启仍可能自我误检——**接受**（方向安全：误入 browse 零写库，等待 TTL 过期或手动重启即恢复；M3 手动恢复功能可提前解除）。
    - **理由**：正常退出路径（绝大多数）彻底消除误检，与 §2.4 fail-safe 第 4 点矛盾消解；崩溃残留窗口方向安全（只读不写）且自愈；改动面小（单行删除 + 两个退出钩子），不引入 fencing 版本等 M4 机制。
    - **文案对齐**：横幅文案不再声称"对方退出后下次启动即恢复"（TTL 窗口内不成立），见 §2.12 定稿文案与 R-14。
- **60s 运行中扫描：完全归 M3**。
  - 理由：① M2 范围声明"运行中检测降级归 M3，不得提前实现"；② "提示-only 扫描"（扫描但只提示不降级）是 M3 将被重写的死代码（M3 扫描要驱动状态机：检测 → 降级 → 手动恢复）；③ M2 验收场景（BROWSE_MODE_DESIGN §6 M2）是**启动检测**；④ node_registry 数据面（30s 心跳 + 120s TTL）已为 M3 备好，M3 只需加扫描循环 + 状态机 + 恢复 UI，数据层零改动。
  - 移交注记：启动竞态（§2.4 第 3 点）是 M2 已知限制，M3 运行中扫描即其兜底；M3 开工时 node_registry service 的 `detectActiveCollectors()` 可直接复用（TTL 判定已实现）。

### 2.6 缺口 6：检测查询引擎依赖 + 检测算法

- **查询引擎依赖**：走单例 adapter（auto 下连接为可写形态，读操作透传；显式 browse 不检测）；表不存在 → 降级"无节点 → collector"；统一容错模板复用 configRepository M8 正则：`/no such table|doesn'?t exist|does not exist/i`（configRepository.js:38-41）。
- **TTL 判定**：新鲜度 = `heartbeat_at >= new Date(Date.now() - 120_000).toISOString()`——本地时钟截止线字符串比较（ISO-8601 UTC 字典序 = 时间序）；不做节点间时间戳比较（D6"用 TTL 而非时间戳比较"）；120s 窗口 ≫ 30s 心跳周期，吸收小时钟偏差。
- **检测算法伪代码**（vrcx.js init() 内，:169 版本读取之后、:218 Branch A 之前插入）：

```
rawNodeMode = String(await VRCXStorage.Get('VRCX_NodeMode') ?? '').trim().toLowerCase()
if rawNodeMode == 'browse':
    effectiveMode = 'browse'                       # 显式模式（现有旁路，不检测）
elif rawNodeMode == 'auto':
    others = await nodeRegistry.detectActiveCollectors()   # 失败容错见下
    if others.length > 0:
        effectiveMode = 'browse'                   # auto 检测降级
        await downgradeToReadOnly()                # adapter/index.js 新导出（§2.1）
        state.detectedNodeIds = others.map(n => n.nodeId)   # 供 UI 提示
    else:
        effectiveMode = 'collector'
        nodeRegistry.startHeartbeat('collector')   # 注册 + 30s 定时（§2.5）
else:
    effectiveMode = 'collector'                    # collector / 非法值（fail-safe，M1 契约）
    nodeRegistry.startHeartbeat('collector')
state.nodeMode = rawNodeMode
state.effectiveNodeMode = effectiveMode
if effectiveMode == 'browse':
    ...现有 browse 旁路（:182-217）+ 日志补"检测来源"...
else:
    ...Branch A/B 原逻辑（:218-237）不变（collector 行为不变硬线）...
```

```
detectActiveCollectors():
    rows = []
    try:
        rows = await adapter.select('node_registry', ['node_id','mode','prefixes','heartbeat_at'])
    catch e:
        if e instanceof Error && /no such table|doesn'?t exist|does not exist/i.test(e.message):
            console.warn('[browse] node_registry 不存在（旧库/未初始化），视为无其他节点')
            return []
        throw e                                        # 其他错误不吞（M8 语义）
    cutoff = new Date(Date.now() - 120_000).toISOString()
    return rows
        .map(r => ({ nodeId: r[0], mode: r[1], prefixes: String(r[2] ?? ''), heartbeatAt: r[3] }))
        .filter(n => n.mode == 'collector' && n.nodeId != nodeId && n.heartbeatAt >= cutoff)
```

```
beat(mode):                                    # 每 30s
    now = new Date().toISOString()
    await adapter.upsertPartial('node_registry',
        { node_id: nodeId, mode, prefixes: ownPrefixes.join(','), heartbeat_at: now },
        { mode, prefixes: ownPrefixes.join(','), heartbeat_at: now },
        'node_id')
    # 过期行清理（尽力而为，防表无界增长）：select 全表 → 过滤 heartbeat_at < cutoff → 逐行 delete(node_id)
    # 全部包 try/catch：失败静默，下一拍重试（§4.2）
```

- **downgradeToReadOnly()**（adapter/index.js 新导出）：

```
export async function downgradeToReadOnly() {
    return initAdapter(adapter.engineType, { readOnly: true });   # engineType: 'sqlite'|'postgresql'|'mysql'
}
```
`adapter.engineType` 三引擎已实现（SQLiteAdapter.js:33-35 等）；'sqlite' 分支（:296-301）与同模式短路径（:317-320）均正确换绑；WeakSet 幂等防双包。**换绑失败 → 抛错 → vrcx init 中止（fail-fast）**——re-gate 是纯内存 Proxy 操作，失败只可能源于编程错误，静默继续会让 browse 语义落空且无门禁拦截（双写风险），故 fail-fast 更安全。
- **M5 un-gate 风险（评审发现，文档声明 + 单测锁定）**：`_applyReadOnlyGate(instance, readOnly)` 语义为 `!readOnly` 时返回**原样实例**（index.js:101-109）——同进程缺省 `initAdapter(engineType)`（不传 `{ readOnly: true }`）在**跨引擎**调用下可解除门禁（新建未门禁实例）。评估结论：
  - **同模式缺省调用门禁保持**（无需 sticky 化）：sqlite 分支 `adapter` 变量已换绑为门禁代理且 `proxy instanceof SQLiteAdapter` 为真（:296 不复建 → :300 返回代理）；非 sqlite 同模式短路路径（:317-320）同样返回已换绑代理——**既有测试已锁定**（`adapter/index.test.js` ② `:238-247` `again.toBe(gated)`、⑥ `:279-311`）。
  - **跨引擎缺省调用理论可解除门禁**：`initAdapter('postgresql')`（缺省）在 browse(sqlite) 下会懒加载**未门禁**新实例。M2 语义下 engineType 启动即定（`src/plugins/interopApi.js:138` 单次调用），启动后无任何代码切换引擎——**残留风险仅存在于未来错误调用**，文档声明 + 单测锁定现状（§5.1"downgradeToReadOnly"行补跨引擎用例）。
  - **不做 sticky 化**（改 `_applyReadOnlyGate` 语义为"门禁过一次则永久保持"）：与既有测试 ②⑥ 断言行为冲突，且 M3 若引入运行中模式切换需要的是显式 re-gate/un-gate API 而非隐式 sticky；M3 backlog 记录该升级项（§11 ③）。
### 2.7 缺口 7：登录禁用挂点 — UI 置灰 + 函数级 guard 双层

**语义细查结论**（migrateStoredUsers）：`auth.js:523-536` 仅做本地 configs 表键归一化（savedCredentials 按 user.id 重键），**非 VRChat 登录**；browse 下其写（configRepository.setString）被门禁 no-op，无害不崩 → **不禁用**（避免 App.vue:77 增加条件分支）。autoLoginAfterMounted（auth.js:214-248）用 cookies 恢复既有会话（getConfig + getCurrentUser，不触发 loginComplete，不持久化）→ **允许**，满足"已登录 browse 端保持会话只读展示"；其写路径（loginComplete 的 configs 写）被门禁 no-op，M1 §10"登录不持久化"语义保留。

| 入口 | 位置 | browse 行为 |
|---|---|---|
| Login.vue 表单提交 onSubmit → auth.login | views/Login/Login.vue:391 → auth.js:707 | 置灰 + guard 早退（toast 提示"浏览模式不可登录"） |
| 多账号选择 clickSavedLogin / clickMultiLogin | Login.vue:296 / :359 → relogin auth.js:607 | 置灰 + guard 早退 |
| auth.relogin | auth.js:607 | guard 早退（cookies 恢复路径亦拦） |
| accountHub.addSession（新开副账号会话） | accountHub.js:141-157 | guard 抛错（不创建会话） |
| accountSession.login（login 函数首行 :62 插 guard 为兜底） | accountSession.js:61-138 | guard 早退（双保险：即使穿透，_initTables 写被门禁 no-op） |
| autoLoginAfterMounted | auth.js:214-248 | **允许**（只读会话展示） |
| migrateStoredUsers | auth.js:523-536 | **允许**（本地迁移，写 no-op 无害） |
| L2 initWebsocket | websocket.js:53-71（isFriendsLoaded watch auth.js:128-136） | 随会话恢复自然建立；会话未恢复则不建立——"随登录禁用自然关闭"成立，**不专门处理** |

- guard 实现：登录入口统一走 `vrcxStore.isBrowse` 判断（§2.12 UI 状态模型）；UI 置灰由各组件读取同一状态。
- 已登录 browse 端：store 内存态正常展示（feed/friends 等），DB 写全被门禁丢弃；会话内数据以 DB 为真相（onTableChange 重查，D5）。

### 2.8 缺口 8：未登录 collector 的 prefixes — 空 prefixes 仍触发

- **定案**：任何活跃 collector（`mode='collector'` 且心跳新鲜）均触发 browse，**含空 prefixes（未登录 collector）**——与 D6"任何其他活跃实例均触发降级提示"一致。
- 理由：未登录 collector 仍写**全局无前缀表**（gamelog_* 7 张，DATA_REFRESH §2.1；无前缀隔离，设计 §7 已知边界）——若忽略空 prefixes collector，browse 端可能与其双写全局表；而触发方向（browse 误判）安全（只读不写）。**保守一致性 > 精致区分**。
- prefixes 列 M2 仅**记录**（心跳写入，启动时为空，登录后经 `nodeRegistry.setOwnPrefixes()` 更新——调用点 auth.js loginComplete :1044，collector 模式；browse 不调用），**不参与判定**；备 M4（前缀重叠精细化判定）使用。

### 2.9 缺口 9：缺文件对话框链路 — 补查结论 + 双形态挂点

**第一步小任务补查结论**（C# Init 异常跨桥链路）：

| 形态 | 链路 | 现状 |
|---|---|---|
| Electron | main.js:161-176 引擎 Init（async IIFE 内 node-api-dotnet 调用）→ 异常 → :203-208 `.catch` → 写 bootstrap-error.log + `process.exit(1)` | **无任何用户可见对话框**（裸退出） |
| CefSharp | Program.cs:295-314 `Run()` 内引擎 Init → SQLiteException/MySqlException/PostgresException → :185-201 数据库修复 MessageBox；**其余异常**（含 SQLite.cs:211 缺文件的 InvalidOperationException）→ :205-225 通用崩溃对话框（异常全文，非友好） | 有对话框但非 browse 专属文案 |

**定案**：
- **Electron**：main.js `.catch`（:203-208）内、写日志前插入分支——`String(e?.message ?? '').includes('浏览模式：数据库文件不存在')` → `dialog.showMessageBoxSync({ type: 'error', title: '浏览模式（只读）', message: e.message, detail: '请先以 collector 模式启动一次完成初始化，或检查 VRCX_Database.name 配置。' })`（dialog 已导入 main.js:10）→ 再 exit(1)。非匹配错误保持现行为。
- **CefSharp**：Program.cs 新增 catch 分支（置于 :201 数据库异常分支之后、:205 通用崩溃之前）：`catch (InvalidOperationException e) when (e.Message.StartsWith("浏览模式："))` → MessageBox（标题"浏览模式（只读）"、正文沿用 M1 消息 + 引导语）→ 不再落入通用崩溃框。
- 文案：C# 侧/主进程固定中文文案（与现有 MessageBox 一致，C# 无 i18n 基建；M1 SQLiteBridgeTests 对缺文件消息的断言不变）；渲染进程 UI 文案走 i18n（§2.12）。

### 2.10 缺口 10：PG/MySQL 只读与 createAdapter/OnConnection 路径交互

- **只读串作用域**：只作用于 C# `Init()` 的默认连接（PostgreSQL.cs:433-476 / MySQL.cs:230-286，browse 分支）；`createAdapter` 实例与 `ExecuteJsonOnConnection` 路径（PostgreSQL.cs:516/637/1015、MySQL.cs:571/612/871、SQLite.cs:755/810）不受影响——M1 §4.5 边界声明：createAdapter 实例不门禁、调用方自控连接串（browse 下导入导出等手动操作入口被 §2.7/§2.12 置灰，双保险）。
- **共存机制**：`DataSourceCache`/`ConnectionCache` 为 `ConcurrentDictionary<string, ...>` **按连接串隔离**（PostgreSQL.cs:280 / MySQL.cs:95 / SQLite.cs:96）→ 只读串与可写串天然分池共存，同一进程内 browse 默认连接（只读）+ 用户导出连接（可写）互不干扰。
- **PG 精确变更**：PostgreSQL.cs:458-470 连接串追加 `;Options=-c default_transaction_read_only=on`（仅 browse 分支；collector 分支**逐字符不变**——M1 验收硬线扩展）。
- **MySQL 精确变更**：MySQL.cs:256-283 改 `MySqlDataSourceBuilder` + `UseConnectionOpenedCallback`（回调内 `SET SESSION TRANSACTION READ ONLY`，`Conditions: None|New|Reset` 覆盖池借出全条件；`ConnectionReset=true` 重置后仍有效）；回调失败 → `logger.Warn` 降级（连接保持可写，缺口与 R-9 同文档声明）；新增 `internal` 测试钩子（回调注册标记）供单测断言（连接串无法表达回调）。
- **测试覆盖"只读与可写连接串共存于缓存"**：PostgreSqlBridgeTests/MySqlBridgeTests——先后 browse/collector Init → DataSourceCache 两条目（连接串不同）；PG browse 串含 Options 只读参数（反射读 `_dataSource.ConnectionString`，沿用 SQLiteBridgeTests:232-247 模板）；MySQL 断言回调钩子 + 连接串基线。

### 2.11 缺口 11：L1-L4 入口跳过定案

| 层 | 入口 | 位置 | browse 行为（定案） |
|---|---|---|---|
| L1 采集线程 | LogWatcher.Init | LogWatcher.cs:47-52 | ✅ M1 门控存在但**仅显式 browse 生效**：`if (NodeMode.IsBrowseMode())`（:52）按 raw `VRCX_NodeMode` 判定，**auto 时 C# 判定 ≡ collector → 采集线程照常启动**；auto 检测降级 browse 后线程仍运行，其 DB 写被 JS 门禁丢弃（M1 §2.6 回退语义：采集侧成本残余、持久化归零） |
| L1 LINUX 轮询路径 | `LogWatcher.GetLogLines()` → addGameLogEvent | updateLoop.js:133-141 | 由 updateLoop 门控覆盖（见下） |
| L2 WS | initWebsocket | websocket.js:53-71 | 不专门处理（§2.7：随会话自然建立；事件写被门禁丢弃，仅内存 store 更新） |
| L3 轮询 | getCurrentUser / friends / nonFriend / group | updateLoop.js:76-104 | 由 updateLoop 门控覆盖 |
| L4 全量同步 | runRefreshFriendsListFlow | updateLoop.js:82 | 由 updateLoop 门控覆盖 |
| 每日 optimize | database.optimize | updateLoop.js:150-153 | 由 updateLoop 门控覆盖 |
| Luo 补全 | runSilentInfoFetch | infoFetchCoordinator.js:87（:88-89 现有 isLoggedIn 门控旁） | 新增 browse guard 早退（单点） |

**updateLoop 门控定案**：`:75` 的 `if (watchState.isLoggedIn)` 改为 `if (watchState.isLoggedIn && !vrcxStore.isBrowse)`（一行改动 + store 引用）。**不依赖登录态**——browse 下即使会话恢复（isLoggedIn=true，§2.7 autoLogin 允许）轮询也不跑。
**副作用清单（接受并文档声明）**：browse 端自动更新检查（:105-111）、Discord presence（:123-128）、IPC 超时（:112-114）、缓存清理轮询（:115-122）、游戏状态检测（:142-149）一并暂停——M2 接受（browse 为观览角色，M3 可细化保留项）。
**注记（H2 评审发现）**："JS→C# 停采集线程 IPC"（让 auto 降级后 L1 线程真正停止）**归 M3 候选**——M2 不新增跨桥 IPC；auto 降级后 L1 线程空转成本与 M1 §2.6 回退语义一致（CPU 成本残余、DB 写归零），见 R5。
**R5 空转成本**：updateLoop 顶层跳过后**归零**（除 L2 WS 瞬时事件链的 CPU/网络成本——由登录态决定，接受）；**L1 采集线程例外（H2 更正）**：auto 降级 browse 后 C# 采集线程仍运行（raw 模式门控所致），残余 CPU/内存成本接受（M1 §2.6 回退语义），DB 写已被 JS 门禁丢弃归零；M3 候选 IPC 停线程可消除。

### 2.12 UI 状态模型与文案

**状态（挂 vrcxStore，本 store 拥有者即 vrcx.js，无跨 store 写问题）**：

| 状态 | 类型 | 取值 | 写入点 |
|---|---|---|---|
| `state.nodeMode` | string | raw 配置（'auto'/'collector'/'browse'） | vrcx.js init() 检测后 |
| `state.effectiveNodeMode` | 'collector' \| 'browse' | 判定后模式 | vrcx.js init() 检测后 |
| `state.browseSource` | 'explicit' \| 'auto-detected' \| null | 进入 browse 的来源 | vrcx.js init() |
| `state.detectedNodeIds` | string[] | auto 检测到的其他节点（空数组） | vrcx.js init() |
| computed `isBrowse` | bool | `effectiveNodeMode === 'browse'` | —— |

**UI 挂点**：
- 常驻徽章：`StatusBar.vue` 左段（:52-77 proxy 项同款 border-r 项），仅 `isBrowse` 显示——图标 + `t('browse_mode.badge')`，hover 提示来源（explicit/auto-detected）。
- 模式横幅：新组件 `src/components/BrowseModeBanner.vue`，挂 `MainLayout.vue` SidebarInset 内 router-view 上方（:18-50 区间）；文案（设计 §4 草案 + 禁用"登陆"措辞；**M6/H1 评审修订**）：auto 检测 → "检测到另一个 VRCX 实例正在使用此数据库，已进入浏览模式（只读）。对方停止心跳约 2 分钟后重新启动，将恢复写入；手动恢复功能将在后续版本提供。"——① 去除内部术语"手动恢复归 M3"（改为面向用户的"手动恢复功能将在后续版本提供"）；② "约 2 分钟后"与 TTL 120s 语义对齐（H1：心跳停止后行保留 ≤120s，重启不再检测到旧行才恢复写入；文案不承诺"退出后立即重启即恢复"）。多账号引导语 → "如需监听多账号，请在单个 VRCX 实例内登录多个 VRC 账号。"；接管按钮**不做**（M4）。
- **L-5 未登录场景（评审发现，定案）**：`MainLayout.vue:2` 被 `v-if="watchState.isLoggedIn"` 门控——browse + **未登录**时 MainLayout 不渲染、横幅不可见（用户只见 Login 页）。**定案（选一）**：**Login 页登录区顶部追加横幅挂点**（复用 `<BrowseModeBanner />`，组件自身仅 `isBrowse` 显示，无侵入）——不改变 MainLayout 布局结构；M20（Login.vue 改动）含该挂点，§5.4 人工 #10 验证。
- 置灰入口：Login.vue 表单/保存账号/多登录（§2.7 表）、NavMenu 设置按钮（NavMenu.vue:317-318 handleSettingsClick guard + 置灰样式）、Tools triggerTool（useToolActions.js:81 guard + toast）、ProfileCompletionDialog（经 runSilentInfoFetch guard 生效）。
- i18n：新增 `browse_mode.*` 键组 × 14 语言文件（`src/localization/*.json`，en/zh-CN 必填，**其余 12 语言复制 en 文案作为占位**（L2 评审定案：复制 en 而非空串——空串会渲染空白 UI 且绕过 fallback 显示路径，复制 en 保证任何语言下文案可见；后续本地化逐语言替换））；徽章/横幅/置灰提示均走 `useI18n().t`。
- 登录置灰提示文案：`browse_mode.login_disabled_tooltip`："浏览模式（只读）不可登录新账号"。
## 3. 文件级改动清单

### 3.1 新增文件

| # | 文件 | 内容 |
|---|---|---|
| N1 | `src/services/database/nodeRegistry.js` | 心跳 + 检测 service（§2.3/§2.5/§2.6）：`generateNodeId`、`setOwnPrefixes`、`detectActiveCollectors`、`startHeartbeat(mode)`、`stopHeartbeat`、`beat`（30s upsert + 过期行清理）、M8 正则容错 |
| N2 | `src/services/database/__tests__/nodeRegistry.test.js` | §5.1 用例集 |
| N3 | `src/components/BrowseModeBanner.vue` | 模式横幅（§2.12），挂 MainLayout |
| N4 | `src/services/database/migrations/17/schema.map` | v17：node_registry 表（SQLite 方言 DDL，§4.1） |
| N5 | `docs/architecture/BROWSE_MODE_DESIGN.md`（修改） | §5 基建复用清单：node_registry 心跳/检测状态更新为"✅ M2 实现"；§3 D6 心跳语义注记（§2.3 澄清） |
| N6 | `src/stores/__tests__/authBrowse.test.js` | 登录 guard 集中测试（M-3 评审定案：仓库无 auth.test.js/accountHub/accountSession 测试，M23/M24/M25 用例集中承载于此，§5.1） |
| N7 | `src/stores/__tests__/updateLoopBrowse.test.js` | updateLoop 门控 + infoFetch guard 集中测试（M-5 评审定案：无 updateLoop.test.js / infoFetch 测试，§5.1） |

### 3.2 修改文件

| # | 文件 | 位置 | 改动 |
|---|---|---|---|
| M1 | `src/services/database/adapter/index.js` | 导出区（:437 附近） | 新导出 `downgradeToReadOnly()`（§2.6；`initAdapter(adapter.engineType, { readOnly: true })`）；`adapter` 变量引用（:72）已可读 engineType |
| M2 | `src/stores/vrcx.js` | :51；:169-237 | `TARGET_DB_VERSION` 16→17；init() 内 :179-181 模式判定扩展为 §2.6 伪代码（raw 读取 + auto 检测分支 + downgradeToReadOnly + 心跳启动 + 模式状态写入）；browse 旁路日志补检测来源；**collector 路径（Branch A/B :218-237）逐字节不变** |
| M3 | `src/stores/updateLoop.js` | :75 | 门控改 `if (watchState.isLoggedIn && !vrcxStore.isBrowse)`（§2.11）；其余零改动 |
| M4 | `src/coordinators/infoFetchCoordinator.js` | :87-89 | runSilentInfoFetch 加 `if (vrcxStore.isBrowse) return;` |
| M5 | `src/services/database/adapter/SQLiteAdapter.js` | initGlobalSchema 内 configs DDL（:1129-1131）之后、方法结束（:1132）前 | 追加 node_registry DDL（§4.1） |
| M6 | `src/services/database/adapter/PgSQLAdapter.js` | initGlobalSchema 内 configs DDL（:1493-1495）之后、方法结束（:1534）前 | 追加 public.node_registry DDL（§4.1；M-2 行号修订：:1489 是 cookies 注释中部，非追加点；integrator 复核：:1496 为 Step-2 全局索引注释，方法实际结束于 :1534） |
| M7 | `src/services/database/adapter/MySQLAdapter.js` | initGlobalSchema 内 configs DDL（:1113-1115）之后、:1116（方法结束 `}`）前 | 追加 node_registry DDL（§4.1；M-2 行号修订：:1106 是 cookies 注释首行，非追加点） |
| M8 | `Dotnet/PostgreSQL.cs` | Init :458-470 | browse 分支连接串追加 `;Options=-c default_transaction_read_only=on`；collector 分支逐字符不变；logger.Info 记录模式 |
| M9 | `Dotnet/MySQL.cs` | Init :256-283 | browse 分支改 `MySqlDataSourceBuilder` + `UseConnectionOpenedCallback`（SET SESSION TRANSACTION READ ONLY；回调失败 warn 降级）；internal 测试钩子（回调注册标记）；collector 分支不变 |
| M10 | `Dotnet/Program.cs` | :201 后、:205 前 | 新增 `catch (InvalidOperationException e) when (e.Message.StartsWith("浏览模式："))` 分支 → 友好 MessageBox（§2.9） |
| M11 | `src-electron/main.js` | :203-208 catch 内 | browse 缺文件 → `dialog.showMessageBoxSync` 友好分支后 exit(1)；非匹配保持现状 |
| M12 | `src/stores/__tests__/vrcx.test.js` | :134 常量行 + browse 用例 | **常量 16→17 同步拆入 S1**（H-1 评审：S1 改 vrcx.js:51 后 vrcx.test.js:134 不同步会使 S1 后全量套件红）；S2 只做新增 auto 检测用例（检测到→旁路+re-gate 调用；未检测到→collector 路径；表缺失→collector）；日志断言同步 |
| M13 | `src/services/database/migrations/__tests__/migrationEquivalence.test.js` | 追加 | v17 describe 块（§5.1） |
| M14 | `Dotnet/VRCX.Tests/PostgreSqlBridgeTests.cs` | 追加 | browse 连接串断言 + 只读/可写缓存共存 + env-gated 真库只读拒绝（§5.2） |
| M15 | `Dotnet/VRCX.Tests/MySqlBridgeTests.cs` | 追加 | 回调钩子断言 + 连接串基线 + env-gated 真库拒绝（error 1792，DDL 行为记录） |
| M16 | `src/services/database/adapter/__tests__/SQLiteAdapter.test.js` | :1104 后 | initGlobalSchema spot-check 补 `expect(tables).toContain('node_registry')`（:1099 计数断言 `>= 14` 无需改） |
| M17 | `src/localization/*.json`（15 文件） | 追加 `browse_mode` 键组 | 徽章/横幅/置灰提示/检测来源文案（§2.12） |
| M18 | `src/components/StatusBar.vue` | 左段（:77 proxy 项之后） | 浏览模式常驻徽章项（仅 isBrowse 显示） |
| M19 | `src/views/Layout/MainLayout.vue` | SidebarInset 内（:18-50） | 挂 `<BrowseModeBanner />` |
| M20 | `src/views/Login/Login.vue` | :49/:172/:296/:359 | 表单/保存账号/多登录置灰（disabled + title 提示；L-2 行号修订：多登录按钮 `@click` 在 :172 而非 :171）；**登录区顶部挂 `<BrowseModeBanner />`**（L-5 评审：MainLayout 被 `v-if="watchState.isLoggedIn"` 门控，browse+未登录时横幅须在 Login 页可见） |
| M21 | `src/components/nav-menu/NavMenu.vue` | :317-318 | handleSettingsClick browse guard + 按钮置灰 |
| M22 | `src/composables/useToolActions.js` | triggerTool :81 | browse guard（toast 提示） |
| M23 | `src/stores/auth.js` | login :707 / relogin :607 / loginComplete :1044 | 登录 guard 早退；loginComplete（collector 模式）调 `nodeRegistry.setOwnPrefixes(...)`；guard 用例承载于 N6（M-3） |
| M24 | `src/services/accountHub.js` | addSession :141 | browse guard 抛错；用例承载于 N6（M-3） |
| M25 | `src/services/accountSession.js` | login 函数首行（:62）前 | browse guard 早退（M-1 行号修订：login 实际起于 :61，:108 是函数体中段 `_requestRaw` 调用）；用例承载于 N6（M-3） |
| M26 | `.github/workflows/ci.yaml` | test_mysql :137-167 / test_pgsql :174-214 | 追加 setup-dotnet + `dotnet test Dotnet/VRCX.Tests --filter "Category=ReadOnlyRejection"` 步骤（G0 事实修正）；**test_pgsql 新 dotnet 步骤自带 env 块复制 :207-212 的 PG_TEST_*（H-2 评审：PG_TEST_* 是 step 级 env，新步骤默认拿不到，缺 env 会静默全 Skip 假绿）**；test_mysql 的 MYSQL_TEST_* 已是 job 级 env，新步骤直接继承 |
| M27 | `src/stores/vrcx.js`（状态区 :70-78） | state 追加 | `nodeMode` / `effectiveNodeMode` / `browseSource` / `detectedNodeIds` + computed `isBrowse`（§2.12；L-1 行号修订：state reactive 块实际 :70-78，:100-104 是独立 ref 非状态区） |

### 3.3 明确不动

`EngineAdapter.js`（冻结）、`database/index.js`、`readOnlyGate.js`（21 方法名单含 upsertPartial，无需改）、`migrations/16/*`（v16 迁移不动，v17 追加）、`LogWatcher.cs`（M1 已按 raw `VRCX_NodeMode` 门控——仅显式 browse 不启动采集线程；auto 降级路径线程仍运行，DB 写被 JS 门禁丢弃，H2 评审，见 §2.11）、`interopApi.js`（:137-138 显式 browse 门禁传参不变）、`SQLite.cs`（M1 已实现只读串/缺文件检查）、`general.js`、`configRepository.js`（M8 已实现，仅复用其正则模板）、`websocket.js`、`watchState`。

## 4. 边界定义

### 4.1 node_registry 表 DDL（三方言）

```
SQLite（initGlobalSchema 追加 + 17/schema.map 同款）:
CREATE TABLE IF NOT EXISTS node_registry (
  node_id      TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,        -- 'collector' | 'browse'（M2 只写 collector；'browse' 备 M4）
  prefixes     TEXT NOT NULL,        -- 本实例登录账号前缀列表（逗号分隔，可为空串）
  heartbeat_at TEXT NOT NULL         -- 最近心跳（ISO-8601 UTC，JS 端 now.toISOString()）
)

PostgreSQL（public schema 前缀，对齐 PgSQLAdapter 惯例）:
CREATE TABLE IF NOT EXISTS public.node_registry (
  node_id      TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,
  prefixes     TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
)

MySQL（VARCHAR 惯例对齐 MySQLAdapter）:
CREATE TABLE IF NOT EXISTS node_registry (
  node_id      VARCHAR(64) PRIMARY KEY,
  mode         VARCHAR(16) NOT NULL,
  prefixes     TEXT NOT NULL,
  heartbeat_at VARCHAR(255) NOT NULL
)
```

- 三引擎 initGlobalSchema 追加点：SQLiteAdapter.js configs DDL（:1129-1131）之后、方法结束（:1132）前 / PgSQLAdapter.js configs DDL（:1493-1495）之后、方法结束（:1534）前 / MySQLAdapter.js configs DDL（:1113-1115）之后、:1116 前；IF NOT EXISTS 语义已核实（三引擎全部如此），幂等。
- v17 `.map` 迁移：`17/schema.map`（version: 17，SQLite 方言 DDL）；`TARGET_DB_VERSION` 16→17（vrcx.js:51）；PG/MySQL 无版本迁移机制，靠 initGlobalSchema 幂等兜底。

### 4.2 心跳/检测失败模式

| 场景 | 行为 |
|---|---|
| 心跳 upsert 失败（DB 锁/网络） | `beat` 内 catch 静默 + 下一拍（30s）重试；连续失败 → 本节点行 TTL 过期，**后来者**检测不到本节点 → 可能双写（与 §2.4 第 3 点同接受度；M3 扫描兜底） |
| 检测查询表缺失 | M8 正则容错 → 无节点 → collector（§2.4 fail-safe） |
| 检测查询其他错误 | 不吞，抛出（M8 语义：仅表缺失类容错） |
| 过期行清理失败 | 静默，下一拍重试；表增长受控（每会话至多 1 行，清理兜底） |
| downgradeToReadOnly 失败 | fail-fast（vrcx init 中止；§2.6 论证） |
| 心跳定时器与进程退出 | **优雅退出**：`beforeunload` 钩子（vrcx.js init 注册）→ `nodeRegistry.removeOwnRow()` fire-and-forget 删除本节点行 + main.js/Program.cs 延迟 ≤1s 退出兜底（§2.5 H1 定案）；**崩溃（kill -9/断电）**：钩子不执行 → 行残留，由 TTL 120s 兜底；崩溃后 ≤120s 重启可能自我误检（R-14，方向安全） |

### 4.3 与 M1 门禁名单的关系（无冲突论证）

| 面 | 分析 |
|---|---|
| `upsertPartial` 在 21 方法名单（readOnlyGate.js:38） | 门禁仅在 browse 生效；**心跳只由 collector/auto-无对手 执行**（§2.5 时序），collector 模式不门禁 → 心跳写入永不经过门禁，无冲突 |
| browse 检测查询（select 透传） | select 不在名单（透传清单 §4.3 M1），browse 下正常读 |
| browse 不写注册表（§2.2） | 无豁免 → 名单无需改动，backstop 完整 |
| `execute` 裸 SQL 通道 | 检测/清理全部走结构化 API（select/upsertPartial/delete），不引入 execute 写 SQL，M1 M-1 审计结论不变 |

## 5. 测试计划

### 5.1 vitest 单测（CI 全自动）

| 用例 | 文件 | 覆盖 |
|---|---|---|
| nodeRegistry：TTL 判定边界 | N2 | heartbeat_at = cutoff（120s 整）判新鲜；cutoff-1ms 判新鲜；cutoff+1ms 判过期；模式过滤（'browse' 行忽略）；node_id 自排除 |
| nodeRegistry：表缺失容错 | N2 | select 抛 `no such table` / `doesn't exist` / `does not exist`（三方言消息）→ 返回 [] + warn-once；其他错误 rethrow |
| nodeRegistry：upsert 参数形状 | N2 | beat() 调 upsertPartial（insertData/updateData 含 node_id/mode/prefixes/heartbeat_at，conflictColumn='node_id'）；前缀 join 逗号；空前缀 OK |
| nodeRegistry：过期行清理 | N2 | 清理只删 heartbeat_at < cutoff 行；本节点新鲜行保留；清理失败不抛 |
| nodeRegistry：startHeartbeat 幂等/停止 | N2 | 二次调用不重复建定时器（vi.useFakeTimers + workerTimers mock）；stopHeartbeat 清理；间隔 30000ms |
| downgradeToReadOnly | `adapter/index.test.js`（**已存在**——M-4 事实修正：位于 `adapter/` 根目录而非 `__tests__/` 子目录，vitest include `src/**/*.{test,spec}.js` 匹配，S2 验证命令有效；既有 readOnly-gate describe 块 ①-⑥ 在 :198-312） | engineType 三值映射：'sqlite' 复用分支换绑门禁实例；'postgresql'/'mysql' 同模式短路径（:317-320）换绑；返回值 = 门禁实例；二次调用幂等（WeakSet）；collector 下调用 → 门禁生效；**M5 跨引擎用例**：browse(sqlite 门禁) 下缺省 `initAdapter('postgresql')` → 返回未门禁实例（记录现状为已知限制，§2.6）；同模式缺省调用返回门禁实例（②⑥ 已锁定，回归） |
| vrcx auto 检测（检测到） | M12 | VRCX_NodeMode='auto' + detectActiveCollectors 返回节点 → effectiveNodeMode='browse'、downgradeToReadOnly 被调、Branch A/B 跳过、browse 日志含"auto 检测"、心跳未启动 |
| vrcx auto 检测（未检测到/表缺失） | M12 | 返回 [] / 表缺失 → collector 路径、心跳启动、Branch A/B 正常 |
| vrcx 显式 browse 回归 | M12 | 现有用例（:190-239）在 TARGET=17 下保持（日志断言同步） |
| updateLoop browse 跳过 | N7（`updateLoopBrowse.test.js`，M-5 评审定案：仓库无 updateLoop.test.js） | isBrowse=true 且 isLoggedIn=true → 采集段零调用（friends/group/optimize/LINUX log 均不触发）；isBrowse=false 行为不变 |
| infoFetch guard | N7（同文件承载） | isBrowse=true → runSilentInfoFetch 早退 |
| v17 迁移等值 | M13 | `runMigrations(16,17)` → node_registry 存在且列齐全（node_id/mode/prefixes/heartbeat_at，PRIMARY KEY node_id）；`runMigrations(0,17)` 两次运行 dump 相同（幂等）；v16 既有用例零改动全绿 |
| initGlobalSchema spot-check | M16 | 追加后 listTables 含 node_registry；幂等测试（:1128）继续通过 |
| 登录 guard | N6（`authBrowse.test.js`，M-3 评审定案：仓库无 auth.test.js / accountHub / accountSession 测试，M23/M24/M25 用例集中承载） | isBrowse=true：auth.login/relogin/addSession/accountSession.login 早退；autoLoginAfterMounted 不受影响；migrateStoredUsers 不受影响 |
| UI 组件/文案 | 新增 BrowseModeBanner/StatusBar 徽章测试（如无组件测试基建则人工清单覆盖） | 横幅仅 isBrowse 显示；徽章显示与隐藏；i18n 键存在性（en/zh-CN 扫描） |

### 5.2 Dotnet.Tests（xUnit，本地 + M26 CI 挂接）

| 用例 | 文件 | 覆盖 |
|---|---|---|
| PG 连接串断言（browse/collector） | M14 | browse Init → 反射读 `_dataSource.ConnectionString` 含 `Options=-c default_transaction_read_only=on`；collector Init → 与基线**逐字符相等**（沿用 SQLiteBridgeTests:232-247 模板；VRCXStorageStub 设 VRCX_NodeMode） |
| PG 只读/可写缓存共存 | M14 | browse + collector 两次 Init → DataSourceCache 两条目（连接串不同）；条目按串隔离 |
| MySQL 回调钩子断言 + 基线 | M15 | browse Init → internal 钩子为真 + 连接串基线不变；collector Init → 钩子为假 + 连接串逐字符不变 |
| 真库只读拒绝（env-gated，`[Trait("Category", "ReadOnlyRejection")]` + Skip 条件 PG_TEST_HOST/MYSQL_TEST_HOST 未设） | M14/M15 | PG browse 连接 → INSERT/UPDATE/CREATE TABLE 报 read-only 事务错误、SELECT 正常；MySQL browse 连接 → DML 报 error 1792、SELECT 正常、**DDL 行为随版本记录**（M1 R1 处置） |
| 缺文件分支 | 既有 SQLiteBridgeTests + M10 相关 | M1 消息断言不变；Program.cs 新 catch 分支单测（可选：直接测 `e.Message.StartsWith("浏览模式：")` 判别） |
| collector 回归基线 | 现有全量 | SQLiteSecurityTests 等 60+ 用例零改动全绿 |

### 5.3 env-gated 真库集成与 CI 挂接（G0 事实修正）

- **事实修正**：vitest 环境无 C# 桥（vitest.setup.js:15-23 全 stub），**无法在 vitest 中执行真实 SQL**——"连接层只读"只能由 C# 侧验证（连接串断言在 Dotnet.Tests 单元层；真库拒绝在 Dotnet.Tests env-gated 集成层）。M1 §6.3 人工清单同为佐证。
- **CI 挂接**：test_mysql/test_pgsql job（ci.yaml:137-167/:174-214）追加 setup-dotnet（`dotnet-version: '10.0.x'`，与 build job :43-44 一致）+ `dotnet test Dotnet/VRCX.Tests --filter "Category=ReadOnlyRejection"` 步骤。**env 作用域（H-2 评审）**：test_mysql 的 MYSQL_TEST_* 为 **job 级** env（新步骤直接继承）；test_pgsql 的 PG_TEST_* 为 **step 级** env（:207-212 仅挂"Run PgSQL integration tests"步骤）→ **新 dotnet 步骤必须自带 env 块复制 PG_TEST_*（PG_TEST_HOST/PG_TEST_PORT/PG_TEST_USER/PG_TEST_PASSWORD/PG_TEST_DB/PG_TEST_VERSION）**，否则真库用例静默全 Skip、CI 假绿。vitest 步骤保持不动。
- 本地运行：`PG_TEST_HOST=localhost dotnet test Dotnet/VRCX.Tests --filter Category=ReadOnlyRejection`（对照 PgSQLAdapter.pgsql.test.js:11-14 的 docker 说明）。

### 5.4 人工验证清单

| # | 场景 | 预期 |
|---|---|---|
| 1 | PG 双实例 E2E：实例 A auto 先起（collector + 心跳）；实例 B auto 后起 | B 进入 browse（横幅+徽章），零写库；A 行为不变；node_registry 含 A 行、无 B 行 |
| 2 | MySQL 同 #1；browse 端手工触发登录入口（置灰/guard 双拦） | 同 #1 + 登录被拦 |
| 3 | 显式 browse + 缺文件（Electron 与 CefSharp 两形态） | 友好对话框（非裸错误/非通用崩溃框） |
| 4 | v16 旧库 + auto 启动（单实例） | 不误判 browse，升级到 v17，node_registry 建成，心跳正常 |
| 5 | 回滚验证：删 VRCX_NodeMode 或置 collector | 行为与改造前一致（collector 回归线） |
| 6 | 同机双实例（SQLite）：复制 `%APPDATA%\VRCX` 目录 → 两进程**同一 VRCX.json + 同一 DB 文件**（L-4 措辞修订：VRCX.json 单机共享，不存在"两份独立配置指向同一 DB"的构造；复制目录即为同配置双进程） | 后起者检测到前者 → browse；**两实例 node_id 不同**（查询 node_registry 行） |
| 7 | 会话恢复展示：browse + 已有 savedCredentials | autoLoginAfterMounted 恢复会话只读展示；updateLoop 不轮询；WS 建立但写全丢弃 |
| 8 | **auto 单实例快速重启（H1 评审）**：a) 正常退出（关闭窗口）后 ≤120s 内重启；b) 模拟崩溃（`taskkill /F` 主进程）后 ≤120s 内重启 | a) **不误入 browse**（优雅退出已删本节点行）→ 直接 collector 模式（日志/UI 均无 browse 提示）；b) 允许短暂进入 browse（崩溃残留窗口，R-14）——重启后横幅文案与 TTL 语义一致（"约 2 分钟后恢复"），等待 TTL 过期后再次重启恢复正常 collector；两次均验证 node_registry 无本节点旧行残留（a）/ 有残留且过期后消失（b） |
| 9 | **auto 降级后 L1 无 DB 写（H2 评审）**：auto 模式双实例 E2E（同 #1），后起者降级 browse 后检查 gamelog_* / node_registry 等表 | 降级端 C# 采集线程虽照常运行（LogWatcher raw 模式门控所致），但 **DB 零写入**（门禁丢弃）；日志无异常堆栈（写被 no-op 而非报错） |
| 10 | **横幅/徽章 + 检测来源提示 + 文案核对（M4/L-5 评审）**：browse 已登录 → MainLayout 横幅 + StatusBar 徽章可见，hover 徽章显示来源（explicit/auto-detected）；**browse + 未登录 → Login 页顶部横幅可见**（MainLayout 被 isLoggedIn 门控不渲染） | 横幅/徽章仅 isBrowse 显示；hover 提示来源正确；文案逐字核对 §2.12 定稿（无"手动恢复归 M3"内部术语、含"约 2 分钟"TTL 对齐表述） |

## 6. 失败模式与回滚策略

| 失败模式 | 表现 | 处置 |
|---|---|---|
| v16 旧库双新 build 同时启动（启动竞态） | 双双变 collector（检测互不可见）→ 双写 | **接受**（§2.4 论证：一次性窗口，表建成后消失）；M3 运行中扫描为正式兜底 |
| 心跳写失败持续 | 本节点 TTL 过期 → 后来者检测不到 → 双写窗口 | 接受（与上同源）；日志 warn 可观测 |
| browse 误判（检测把非 collector 行当对手） | 进入 browse 只读 | 安全方向（零写）；模式过滤 + TTL 已最小化 |
| **快速重启自我误检（H1）** | 崩溃后 ≤120s 内重启进入 browse | 正常退出已消除（优雅退出删行）；崩溃残留窗口接受（R-14）：方向安全（零写）、TTL 自愈；人工 #8 验证 |
| downgradeToReadOnly 抛错 | vrcx init 中止 | fail-fast（§2.6）；恢复：重启 |
| auto 检测 browse 无连接层只读 | 门禁遗漏时写可穿透（理论） | R-9 文档声明；显式 browse 无此缺口 |
| MySQL 回调失败降级 | 连接保持可写（warn 日志） | 与 R-9 同文档声明；真库用例记录实际行为 |
| updateLoop 门控误伤（collector 行为改变） | L3/L4 停摆 | 门控条件 `isBrowse` 仅检测后置真；M12 回归测试锁定 collector 路径 |
| i18n 键缺失（非 en/zh-CN 语言） | fallback en 文案 | i18n fallback 机制兜底（plugins/i18n.js:5-9） |

**回滚策略**：配置级——删/改 `VRCX_NodeMode` 即回 collector；代码级——单 commit revert（M2 改动面为新增文件 + 增量修改，无破坏性 schema 变更：node_registry 为 additive 表，v17 迁移幂等，旧 build 读新库不受影响——node_registry 未被任何旧代码引用）。

## 7. 风险清单（含 M1 风险 M2 处置状态）

| ID | 风险 | 处置状态（M2） |
|---|---|---|
| R1（M1） | MySQL DDL 是否被会话只读拦截随版本而异 | **闭环**：真库用例记录（M15）；代码门禁覆盖 DDL（既有 21 方法名单含 createTable） |
| R5（M1） | browse 下 L1-L4 空转 CPU + 读回陈旧数据 | **闭环**：updateLoop 顶层跳过（§2.11），JS 侧轮询空转归零；**L1 C# 采集线程在 auto 降级路径仍运行（H2 更正：raw 模式门控所致），残余 CPU 成本接受、DB 写被门禁丢弃归零**；陈旧数据语义由 M1 §2.6 声明 |
| R7（M1） | PG/MySQL 连接层只读缺口 | **闭环**：M8/M9 实现 + M14/M15 验证；auto 检测路径的连接层缺口转 R-9 |
| R8（M1） | browse 账号前缀错配 | **闭环（M2 评审措辞修订，如实化）**：登录禁用（阻止新错配产生，§2.7 guard 双层）+ 既有 configRepository 降级读兜底（M8 正则模板，configRepository.js:38-41；browse 未初始化账号表时读查询不崩溃）——不新增查询层实现点（原"查询层 M8 容错复用"表述无对应改动清单条目，撤回） |
| **R-9（新增）** | auto 检测降级 browse 无连接层只读兜底（三引擎） | 代码门禁第一道防线完整；文档声明（§2.1）；**M3 明确 backlog 条目（M1 评审升格）：C# 侧新增二次建连 API（按 engineType 重建只读 DataSource/连接并换绑）**——M2 不实现，§11 发布说明披露 |
| **R-10（新增）** | node_id 持久化导致同机双实例失明 | 已规避：每会话随机 node_id（§2.5），不落 VRCXStorage |
| **R-11（新增）** | node_registry 无界增长（每会话 1 行残留） | 心跳内过期行清理（§2.6 beat） |
| **R-12（新增）** | 60s 扫描推迟 M3 → 启动竞态窗口 | 接受（§2.4/§2.5）；M3 运行中扫描为兜底 |
| **R-13（新增）** | Dotnet.Tests 不在 CI 运行（G0 事实修正） | M26 在 test_mysql/test_pgsql job 挂接 env-gated 用例；全量 dotnet test 仍本地 |
| **R-14（新增，H1 评审）** | auto 单实例快速重启自我误检：崩溃后 ≤120s 内重启看到自己上一会话残留行（心跳新鲜、node_id 不同）→ 误入 browse | 正常退出路径已消除（优雅退出删除本节点行，§2.5）；崩溃残留窗口接受（方向安全：误入 browse 零写库，TTL 120s 自愈）；横幅文案已与 TTL 语义对齐（§2.12）；§5.4 人工 #8 验证 |

## 8. 验收标准映射（对照 BROWSE_MODE_DESIGN §6 M2）

| M2 验收 | 证据链（自动化 → 人工） |
|---|---|
| **双实例场景自动进入 browse** | ① M12 vrcx auto 检测单测（检测到→browse）；② N2 detectActiveCollectors 单测（TTL/模式/自排除）；③ M13 v17 迁移等值；④ 人工 #1/#2（PG/MySQL 双实例 E2E）、#6（同机 SQLite 双实例） |
| **并正确提示** | ⑤ 横幅组件 + 状态栏徽章（**M17（i18n）/M18（徽章）/M19（横幅）**——M4 评审修订：原引用"M18/M19/M3"中 M3 是 updateLoop.js 与本验收无关，已更正）+ N3 组件测试或人工 #1/#2/#10（横幅/徽章显示 + hover 来源提示 + 文案逐字核对）；⑥ i18n 键组（M17，en/zh-CN 必填 + 其余复制 en 占位） |
| **心跳注册（collector 数据面）** | ⑦ N2 心跳 upsert 参数/周期/清理单测；⑧ 人工 #1/#4 查询 node_registry 行 |
| **browse 零写库（延续 M1 硬线）** | ⑨ 既有 21 方法门禁测试全绿；⑩ 显式 browse 连接层拒绝（SQLite 已有；PG/MySQL M14/M15 env-gated 真库——**M7 评审注记：MySQL 真库拒绝用例以回调注册为前提（M15 回调钩子断言），回调失败时连接保持可写（warn 降级），该缺口与 R-9 同文档声明**）；⑪ R-9 缺口声明在案（**M1 评审注记：门禁反射测试（readOnlyGate.test.js）+ execute 裸 SQL 审计（M1 M-1）为代码门禁防线的补偿证据**） |
| **collector 行为不变** | ⑫ M12 collector 路径回归（Branch A/B 逐字节不变）；⑬ M14/M15 collector 连接串逐字符等价；⑭ 全量既有 vitest + Dotnet.Tests 零改动全绿；⑮ 人工 #5 |

## 9. 切片计划（scrum-master 风格）

| 切片 | 内容 | 验证命令 | DoD |
|---|---|---|---|
| S1 | 数据面：N1 nodeRegistry.js + N2 单测；N4 17/schema.map + M2 TARGET 16→17 + **M12 常量部分（vrcx.test.js:134 16→17 同步，H-1 评审拆入本切片）** + M13 equivalence + M5/M6/M7 initGlobalSchema × 3 + M16 spot-check | `npx vitest run src/services/database/__tests__/nodeRegistry.test.js src/services/database/migrations/__tests__/migrationEquivalence.test.js src/services/database/adapter/__tests__/SQLiteAdapter.test.js src/stores/__tests__/vrcx.test.js`；typecheck/oxlint/oxfmt | TTL/容错/upsert/清理全绿；v17 迁移等值 + 幂等；三引擎 DDL 幂等；**本切片完成 TARGET=17 同步（vrcx.js:51 + vrcx.test.js:134），全量 `npm test` 保持绿**（H-1：不拆则 S1 后全量套件红） |
| S2 | auto 时序：M1 downgradeToReadOnly + index.test.js 用例（**文件已存在**，M-4 事实修正）；M2 vrcx.js 检测分支 + M27 状态 + **M12 新增 auto 检测用例**（H-1：常量已随 S1 同步，本切片只做新增用例）；M3 updateLoop 门控；M4 infoFetch guard | `npx vitest run src/services/database/adapter/index.test.js src/stores/__tests__/vrcx.test.js src/stores/__tests__/updateLoopBrowse.test.js`（N7） | auto 三路径（检测到/未检测到/表缺失）单测锁定；collector 路径零行为变化；re-gate 幂等；updateLoop/infoFetch 门控用例绿 |
| S3 | UI：N3 横幅 + M18 徽章 + M19 挂载 + M20/M21/M22 置灰（**M20 含 Login 页横幅挂点，L-5**） + M23/M24/M25 登录 guard + N6 用例 + M17 i18n | vitest 对应测试（含 N6）+ `npm run typecheck:js` | 横幅/徽章仅 isBrowse 显示；**browse+未登录时 Login 页横幅可见（L-5）**；登录入口双拦（UI 置灰 + guard）；i18n 键齐全（en/zh-CN 必填 + 其余复制 en） |
| S4 | C#：M8 PG Options + M9 MySQL 回调/钩子 + M10 Program.cs 分支 + M11 main.js 对话框 + M14/M15 Dotnet.Tests + M26 ci.yaml | `dotnet test Dotnet/VRCX.Tests`（本地）；CI 绿（build + vitest + 新增 dotnet 步骤） | PG/MySQL browse 连接串断言 + 真库拒绝（env-gated）；collector 基线逐字符；双形态缺文件对话框；**test_pgsql 新 dotnet 步骤自带 PG_TEST_* env 块（H-2）；无 env 时显式打印 skip 计数，防假绿可观测（H-2 DoD）** |
| S5 | 验收 | `npm run format:check`；`npm run lint`；`npm run typecheck:js`；`npm test`；`dotnet test Dotnet/VRCX.Tests`；人工清单 §5.4 | §8 验收映射全项证据链闭合；R-9/R-12/R-14 文档声明在案 |

依赖：S1 → S2 → S3；S1 ∥ S4 → S5。评审门：G1（S1 后，数据面契约冻结）/G2（S2 后，auto 时序冻结——**L-6 评审修订：评审范围覆盖 S2+S3**，因 §2.7 登录禁用为 HIGH 决策却落在无评审门的 S3，G2 结论需覆盖两切片产物）/G3（S4 后，C# 连接层 + 对话框冻结）/G4（合并前，验收映射全项）。

## 10. Resume-Critical 设计事实（供实现会话快速恢复）

1. **缺口 1 定案（auto 时序）**：C# Init 先于 JS（Program.cs:295-314 / main.js:161-176，M1 时序铁律）→ 连接形态启动即定；auto 检测在 vrcx.js init()（:169 后、:218 前）→ 发现对手 → `downgradeToReadOnly()`（adapter/index.js 新导出 = `initAdapter(adapter.engineType, {readOnly:true})`，复用 :300/:317-320 换绑路径 + WeakSet 幂等）→ browse 旁路；连接层只读缺口 = 新风险 R-9（与 M1 R7 同模式）。re-gate 失败 fail-fast。
2. **缺口 2/3**：browse 不写 node_registry（无豁免，backstop 完整）；心跳 = 独立 30s `upsertPartial` 单语句（无 outbox 表、不随业务事务）；mode 枚举 'browse' 值保留备 M4。
3. **缺口 4**：三引擎 initGlobalSchema 追加 IF NOT EXISTS DDL（SQLiteAdapter.js configs 后 :1129-1131 → 方法结束 :1132 前 / PgSQLAdapter.js configs DDL :1493-1495 后、方法结束 :1534 前 / MySQLAdapter.js configs DDL :1113-1115 后、:1116 前——M-2 行号修订）；SQLite `17/schema.map` + TARGET 16→17（vrcx.js:51、vrcx.test.js:134）；检测"表缺失→collector"（M8 正则 `/no such table|doesn'?t exist|does not exist/i`）；双写窗口（启动竞态）接受，M3 扫描兜底。
4. **缺口 5**：nodeRegistry service（N1）+ workerTimers.setInterval(30s)（accountSession.js:548-556 模式）；启动于 vrcx.js init() 内 resolveDatabaseInit（:308）之前；60s 运行中扫描**完全归 M3**（M2 只做启动检测）。
5. **缺口 6**：检测走单例 adapter + TTL = `heartbeat_at >= Date.now()-120s` ISO 字符串比较（本地时钟，不做节点间时间戳比较）；node_id 每会话随机（`crypto.randomUUID()`，**不可持久化**——同机双实例共享 VRCXStorage）；beat 内过期行清理（select + 逐行 delete(node_id)），避免表无界增长。**H1**：优雅退出 `beforeunload` → `removeOwnRow()` 删本节点行 + main.js/Program.cs 延迟 ≤1s 退出兜底；崩溃残留 TTL 兜底（R-14）。**M5**：同模式缺省 initAdapter 门禁保持（index.test.js ②⑥ 锁定）；跨引擎缺省调用理论可解除门禁——engineType 启动即定（interopApi.js:138），文档声明 + 单测锁定，sticky 化不做（与既有测试冲突，M3 backlog）。
6. **缺口 7**：登录禁用 = UI 置灰 + guard 双层；禁用 login(:707)/relogin(:607)/addSession(accountHub:141)/accountSession.login（**函数首行 :62 插 guard，M-1 行号修订**）；**允许** autoLoginAfterMounted(:214)（只读会话展示）与 migrateStoredUsers(:523)（本地 config 迁移，写 no-op 无害）；L2 WS 随会话自然建立不专门处理；loginComplete(:1044) 调 nodeRegistry.setOwnPrefixes（collector）；guard 用例集中承载于 N6 `authBrowse.test.js`（M-3）。
7. **缺口 8**：空 prefixes collector 仍触发（保守一致；未登录 collector 仍写全局 gamelog 表）；prefixes 仅记录不参与判定。
8. **缺口 9（补查结论）**：Electron 缺文件错误走 main.js:203-208 `.catch`（裸退出无对话框）→ 加 `includes('浏览模式：数据库文件不存在')` 分支 → `dialog.showMessageBoxSync`（dialog 已导入 :10）；CefSharp 走 Program.cs :205 通用崩溃框 → 新增 `catch (InvalidOperationException e) when (e.Message.StartsWith("浏览模式："))` 分支（:201 后、:205 前）。C# 侧固定中文文案（无 i18n 基建），渲染进程走 i18n。
9. **缺口 10**：只读串仅 C# Init 默认连接（PG :458-470 追加 `;Options=-c default_transaction_read_only=on`；MySQL :256-283 改 MySqlDataSourceBuilder + UseConnectionOpenedCallback + SET SESSION TRANSACTION READ ONLY + internal 回调钩子）；DataSourceCache 按连接串隔离（PostgreSQL.cs:280 / MySQL.cs:95）天然共存；createAdapter/OnConnection 路径不动（M1 §4.5）。
10. **缺口 11**：updateLoop.js:75 门控改 `isLoggedIn && !vrcxStore.isBrowse`（一行；副作用：browse 端自动更新/Discord/缓存轮询一并暂停，接受）；runSilentInfoFetch(:87) 加 browse guard（用例承载于 N7 `updateLoopBrowse.test.js`，M-5）；L1 C# 线程按 raw 模式门控（LogWatcher.cs:52）——**仅显式 browse 不启动，auto 降级后线程仍运行、DB 写被门禁丢弃（H2 更正），JS→C# 停线程 IPC 归 M3 候选**；R5 空转归零（L1 线程残余成本接受）。
11. **UI 状态**：vrcxStore.state 追加 nodeMode/effectiveNodeMode/browseSource/detectedNodeIds + computed isBrowse（§2.12；state reactive 块在 :70-78，L-1 行号修订）；徽章挂 StatusBar.vue 左段（:77 后）、横幅组件挂 MainLayout.vue SidebarInset（:18-50）+ **Login 页登录区顶部（L-5：MainLayout.vue:2 被 isLoggedIn 门控，browse+未登录时横幅须在 Login 页可见）**；i18n `browse_mode.*` × 14 语言（en/zh-CN 必填，其余复制 en 占位，L2 定案）。
12. **G0 事实修正**：ci.yaml 无 dotnet test 步骤（M1 §6.2"CI 全自动"不实）→ M26 在 test_mysql/test_pgsql job 挂 `dotnet test --filter "Category=ReadOnlyRejection"`；**H-2：test_pgsql 的 PG_TEST_* 为 step 级 env（:207-212），新 dotnet 步骤须自带 env 块复制，否则静默全 Skip 假绿**；vitest 无 C# 桥无法真库（vitest.setup.js:15-23 全 stub）。
13. **硬线**：collector 分支连接串逐字符不变（PG/MySQL 断言）；Branch A/B 逐字节不变；既有 21 方法门禁测试零改动全绿；v16 迁移与 golden 不动。

## 11. 发布说明清单（随 M2 PR 描述发布）

> 仓库无 CHANGELOG.md，发布说明走 **PR 描述模式**（M3 评审定案）：以下 4 条随 M2 PR 描述对外发布，实现会话在 PR 描述中逐条落地。所有披露项均指向本设计对应章节以便追溯。

| # | 披露项 | 内容 | 依据 |
|---|---|---|---|
| ① | **auto 语义变化生效（L-3 预告落地）** | 此前 auto ≡ collector（等价显式 collector）；本版本起 auto = 启动自动检测：发现其他活跃 collector 自动进入浏览模式（只读）。旧行为用户（依赖 auto 恒为采集节点）需知悉变化。 | §2.1/§2.6；BROWSE_MODE_M1_DESIGN.md §10 L-3 预告 |
| ② | **建议显式配置 collector 锁定采集节点** | 多实例部署中，将采集节点显式配置为 `VRCX_NodeMode=collector`，其余节点 auto 即可——避免 auto 语义变化带来的不确定性（如崩溃残留窗口内的快速重启误检，见 ④）。 | §2.1/§5.4 人工 #8 |
| ③ | **R-9 披露（无连接层只读兜底）** | auto 检测降级的浏览模式**无数据库连接层只读兜底**（三引擎），零写库由 JS 代码门禁保证；显式 browse 模式连接层只读不受影响。M3 backlog：C# 二次建连 API 消除该缺口（R-9）+ 显式 re-gate/un-gate API（M5 un-gate 残留：跨引擎缺省 initAdapter 理论可解除门禁，当前无代码路径触发）+ M7 残留（MySQL 回调失败时连接保持可写 warn 降级）。 | §7 R-9；§2.6 M5；§2.10 M7 |
| ④ | **H1 误检窗口声明** | 优雅退出会删除本节点注册行；**崩溃（kill/断电）后 120 秒内重启**可能短暂进入浏览模式（检测到自己上一会话的残留行），约 2 分钟后（TTL 过期）重启即恢复正常——该窗口方向安全（只读不写）。 | §2.5 H1 定案；§7 R-14；§2.12 横幅文案 |
