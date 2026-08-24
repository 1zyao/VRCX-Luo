# 浏览模式 M1 最小可用 — 实现设计（v2）

> 状态：已通过设计评审（scrum-master + product-manager gate），待实现
> 分支：`feat/browse-mode`
> 依据：`docs/architecture/BROWSE_MODE_DESIGN.md` §2/§3(D1–D4)/§6(M1)/§7 + `docs/architecture/CONFIG_REFACTOR.md`
> 日期：2026-08-09

## 0. 变更摘要（评审发现 → 处理位置）

| 评审发现 | 级别 | 处理 | 修订位置 |
|---|---|---|---|
| H-3 只读连接声明不实 | HIGH | **定案：SQLite C# 池只读入 M1；PG/MySQL 连接层只读降级为"代码门禁 + 文档缺口"，随 C# 工作排 M2**（采纳 PM 建议）；验收措辞修正 | §2.1、§5、§9 |
| H-1 Proxy 双路径包装 | HIGH | 挂载点明确到 initAdapter 两分支 + 返回值 = 包装实例 + WeakSet 幂等 | §2.2、§3 M1 |
| H-2 LogWatcher 直写担忧 | HIGH（已推翻） | 核实 LogWatcher.cs:297 仅推事件进 JS，写经 JS 侧 adapter 被门禁覆盖；M1 实现落地为"browse 不启动 LogWatcher 采集线程"（切片计划 S2），"采集运行+门禁丢弃"为 M2 回退语义 | §2.6、§4.5 |
| MEDIUM-1 withTransaction this 绑定 | MEDIUM | 透传机制说明（get trap 返回未绑定函数，this 链=Proxy）+ 专项测试 | §2.2、§6.1 |
| MEDIUM-2 名单遗漏 dropUserSchema | MEDIUM | 名单扩为 21 方法（+PgSQLAdapter:1148 dropUserSchema）；完整性测试改**原型反射 + 写动词谓词** | §4.1、§6.1 |
| MEDIUM-3 非门禁写通道错误涌出 | MEDIUM | 允许涌出（backstop 证据）+ L-1 修正消除误导弹窗 + log-once | §4.3、§7 |
| MEDIUM-4 browse+空库/低版本库 | MEDIUM | 新增"空库/低版本行为"小节：探测 → 警告 → 降级不崩溃；configRepository 读容错；C# 缺文件 fail-fast 可行动报错 | §4.4、§3 M4/M11/M12 |
| MEDIUM-5 JS/C# 判定一致性 | MEDIUM | 统一归一化契约 `trim+lower，'browse' 生效，其余→collector`（fail-safe）；双端单测锁定 | §2.5、§6.1/6.2 |
| M-1 execute() 裸 SQL 通道 | MEDIUM/LOW | 审计结论：单例路径 execute 全为读调用点；不入门禁名单；文档声明"约定只读 + 连接层兜底" | §4.3、§6.1 |
| M-3 browse 账号前缀错配 | MEDIUM/LOW | M1 文档约束 + 已知限制；查询层容错归 M2 | §4.4、§8 |
| L-1 handleSQLiteError 误映射 | LOW | M1 低成本修复：readonly 错误独立分支（warn 不弹"Database is locked" modal） | §3 M7 |
| R-4 空库/低版本 + 启动日志三连 | 修订要求 | 新增小节 + 三连日志（模式/版本/只读警告）+ 登录不持久化警告 | §4.4、§10 |
| R-5 测试计划扩展 | 修订要求 | 门禁 22 方法 + execute 审计、H-1 四路径、LogWatcher 链路、连接层只读、collector 基线、配置校验、升级旁路 | §6 |
| R-6 M1 最小 UX | 修订要求 | 启动日志警告（模式/只读/登录不持久化）作为 M2 横幅临时替代 | §10 |
| R-8 基建复用清单错误声明 | 修订要求 | BROWSE_MODE_DESIGN.md §5 "只读连接串 ✅ 已支持" 修正为待实现 | §3 N5、§10 |

## 1. 目标 / 非目标

### 1.1 M1 目标（本设计范围）

1. **`VRCX_NodeMode` 配置**：flat 键 `'collector' | 'browse' | 'auto'`（默认 `auto`），走 VRCXStorage flat 键模式（读侧 fallback、无 bootstrap、用户操作才 Set，同 `VRCX_CloseToTray` 模式 general.js:194-198）。
2. **database 写入门禁**：browse 模式下所有写方法 no-op（adapter/index.js 构造点单点注入，双路径覆盖）。
3. **SQLite 只读连接**：**C# 池连接串**在 browse 下拼 `Read Only=True` 并跳过写 PRAGMA（H-3 定案：SQLite 入 M1，PG/MySQL 排 M2，见 §2.1）。
4. **验收（修正措辞）**：
   - browse 模式零写库：**全引擎代码门禁**（自动化）+ **SQLite 连接层拒绝**（CI 真库自动化验证）；
   - **PG/MySQL 连接层只读缺口已文档声明（§8 R7），M2 补齐**——其机制（Npgsql `Options` / MySqlConnector `UseConnectionOpenedCallback`）已完成 pin 版驱动验证，M2 工作项可直接落地；
   - collector 行为不变（含 `auto` 默认路径逐字节不变）。

### 1.2 非目标（M1 明确不做）

| 内容 | 归属 | 依据 |
|---|---|---|
| `node_registry`、启动/运行中检测、`auto` 自动判定 | M2 | 设计 §6 M2 |
| 模式横幅/徽章、禁用项置灰、接管按钮 | M2–M4 | 设计 §6；M1 以启动日志警告临时替代（§10） |
| coordinator L1–L4 采集入口跳过（coordinator 侧检测/开关） | M2（M1 已实现"browse 不启动 LogWatcher 采集线程"，见 §2.6） | 决策 6；H-2 核实无 C# 直写，无稳定性风险 |
| PG/MySQL 连接层只读 | M2（机制已验证，见 §2.1） | H-3 定案 |
| `createAdapter` 实例门禁 | 不做（边界声明 §4.5） | C# 桥 doc：调用方自控连接串 |
| VRCXStorage（JSON）写入门禁 | 不做 | 非数据库面 |
| 运行中模式动态切换 | M3 | 设计 D2 |

## 2. 架构决策

### 2.1 决策 1（H-3 修订）：只读连接定案 → **SQLite C# 池只读入 M1；PG/MySQL 排 M2，缺口显式声明**

**事实更正（评审确认）**：三引擎**单例主连接**当前均无只读机制——SQLite C# `Init()` 池连接串（SQLite.cs:205-247）硬编码无 `Read Only`（JS 侧 `'Read Only': 'True'` 仅服务 createAdapter 外部连接流，SQLiteAdapter.js:157）；PG 无 `Options`；MySQL 无 `ConnectionOpenedCallback`。"连接层拒绝验证"验收**必须依赖 C# 改动**，原设计"三引擎对称落地"的表述暗示已支持，不实——本版修正。

**定案**（采纳 PM 建议，理由）：

| 引擎 | M1 处理 | 理由 |
|---|---|---|
| SQLite（默认引擎，覆盖绝大多数用户） | **C# Init() browse 分支拼只读串 + 跳过写 PRAGMA**（§5），CI 真库可自动化验证"连接层拒绝" | 机制零成本（System.Data.SQLite 原生关键字，仓库已在 OnConnection 路径验证过）；验收获得自动化证据链 |
| PG / MySQL（opt-in 远程模式） | **仅代码门禁 + 文档声明缺口**；连接层只读（Npgsql `Options=-c default_transaction_read_only=on` / MySqlConnector `UseConnectionOpenedCallback`+`SET SESSION TRANSACTION READ ONLY`）作为 **M2 C# 工作项**，机制已按 pin 版驱动 XML 验证（Npgsql 10.0.3 "Set PostgreSQL configuration parameter default values for the connection"；MySqlConnector 2.6.1 `MySqlConnectionOpenedCallback` 返回 `ValueTask`、`Conditions: None\|New\|Reset`） | 无活库 CI 无法自动化验证，M2 配测试库落地；M1 零写库仍由代码门禁（第一道防线）完整保证；缺口显式声明而非静默 |

**验收措辞修正**（§9 同步）："browse 模式零写库：**代码门禁全引擎自动化验证 + SQLite 连接层拒绝（CI 真库）**；PG/MySQL 连接层只读为 M2 项（缺口已声明，风险 R7 跟踪）"。

### 2.2 决策 3（H-1 修订）：门禁挂载点 → **initAdapter 双分支收敛 + 返回值=包装实例 + WeakSet 幂等**

候选否决记录不变（③ EngineAdapter 加只读状态不可行——基类冻结且写方法无基类汇聚点；② database/index.js 逐方法包不可行——写调用面实测 ~100 处且 `feed.js`/`configRepository.js`/`accountSession.js`/`pullEngine.js` 直接 import `adapter`）。

**挂载点（评审 H-1 精确化）**——`adapter/index.js`：

1. **模块加载单例（:71）**：`let adapter = new SQLiteAdapter()` 同步构造于模块加载期，早于 `initAdapter` 调用。因 `initAdapter` 的 sqlite 分支（:261-263）**复用**现有实例（`if (!(adapter instanceof SQLiteAdapter)) adapter = new SQLiteAdapter()`），故单例路径与复用路径**在 initAdapter 内收敛**；live ESM binding 保证换绑后所有 importers 看到包装实例。启动契约（interopApi.js:132 在一切 DB 操作前调用 initAdapter）保证不存在先于 initAdapter 的实例捕获。
2. **包装动作统一为 `_applyReadOnlyGate(instance)`**，在两处构造/复用后调用：
   - sqlite 分支：:262 之后、`return adapter`（:265）之前；
   - 非 sqlite 分支：:308 `adapter = new AdapterClass()` 之后（`.then` 内、:311 `return adapter` 前）。
3. **返回值 = 包装实例**：:265 与 :320（`return _initPromise`，resolve 到包装后的 adapter）两处均返回包装实例——测试直接断言返回值行为。
4. **幂等**：模块级 `const _gatedInstances = new WeakSet()`；`_applyReadOnlyGate` 仅在 `options.readOnly && !_gatedInstances.has(instance)` 时包装并登记，防双重包装/重复包装。
5. **启动即定**：`_readOnly` 取首次 `initAdapter` 调用的 `options.readOnly`；运行中切换属 M3，本设计不提供。
6. **透传机制（MEDIUM-1）**：Proxy `get` trap 返回 `Reflect.get(inner, prop, proxy)`（**未绑定函数**）——调用 `proxy.method()` 时 `this === proxy`，inner 方法内部 `this._normalizeArgs`/`this._txStack` 等链式访问继续经 get trap 透传，行为与直接调 inner 一致；`withTransaction` 基类实现（EngineAdapter.js:679）透传，其体内 `fn` 调用各自绑定的 `adapter`（=Proxy）→ 写被拦截、`commit` 正常执行（只读事务合法）。

### 2.3 决策 2（不变）：auto 语义 → **auto ≡ collector**

M1 无检测（M2 内容）。`auto` 与 `collector` 行为完全一致，仅显式 `'browse'` 生效；非法值按 auto 处理并 warn。发布说明级留痕见 §10（L-3）。

### 2.4 决策 4（不变，细化）：启动流语义 → **"跳过"**

- adapter 层自动覆盖：`createTable`/`insert`（configRepository、schema init）均在门禁名单。
- **vrcx.js 升级决策树整树旁路**（:173-195）：browse 不进入 Branch A/B，否则 `runMigrations` 在只读连接抛错 → 升级弹窗 → `return false` → 启动中止。
- 不写 `VRCX_databaseVersion`（归 collector 维护）。
- **新增（MEDIUM-4）**：旁路前执行 schema 探测与版本日志（§4.4）。

### 2.5 决策 7 补充（MEDIUM-5）：JS/C# 模式判定一致性契约

两端共用同一归一化函数（各自实现，测试锁定等价）：

```
normalizeNodeMode(raw): String(raw ?? '').trim().toLowerCase() === 'browse' ? 'browse' : 'collector'
```

- `'browse'`（大小写/首尾空白不敏感）→ browse；`'auto'`/`'collector'`/空/非法 → collector（**fail-safe**：判定错误的最坏后果是"collector 照常运行"，绝不反向造成 browse 误判）。
- C#：`NodeMode.cs`（`IsBrowseMode()`）；JS：`readOnlyGate.js`（导出 `normalizeNodeMode`，interopApi.js 与 vrcx.js 共用）。
- 双端单测：`NodeModeTests.cs` + `readOnlyGate.test.js` 同表用例。

### 2.6 决策 6（H-2 修订）：M1 实现 = browse 不启动 LogWatcher 采集线程；"采集运行+门禁丢弃"为 M2 回退语义

- **H-2 核实结论**：`Dotnet/LogWatcher.cs` 全文件无 SQLite/MySQL/PostgreSQL 引用，仅 :297 `ExecuteScriptAsync("window?.$pinia?.gameLog.addGameLogEvent", logLine)` 推事件进 JS；写入发生在 JS 侧 gameLogCoordinator → adapter → 被 Proxy 覆盖。**不构成稳定性风险**。
- **M1 实现（与实际落地一致，切片计划 S2 决定）**：browse 模式**不启动 LogWatcher 采集线程**（`LogWatcher.cs::Init()` 经 `NodeMode.IsBrowseMode()` 门控跳过启动，避免采集线程空转），比"采集运行写丢弃"更保守；collector/auto 行为不变。
- **M2 回退语义（评审点）**：若后续需要 L1 事件流可见性（browse 下日志事件展示），回退为"采集运行 + 门禁丢弃"语义——L1–L4 采集照常运行，其所有 DB 写被门禁静默 no-op 丢弃。副作用（文档声明）：① CPU/网络空转；② 采集管线若读回刚写的数据将看到陈旧/缺失数据（browse 展示本质如此）；③ **不会崩溃**——no-op 不抛错（返回守恒值），唯一抛错路径是绕过门禁的 backstop 涌出（§4.3）。
- coordinator L1–L4 采集入口跳过（含自动检测）仍归 M2，与回退语义的取舍在 M2 评审点一并决策。

## 3. 文件级改动清单

### 3.1 新增文件

| # | 文件 | 内容 |
|---|---|---|
| N1 | `src/services/database/adapter/readOnlyGate.js` | `createReadOnlyAdapter(inner)`（Proxy，get trap 返回未绑定 inner 函数）；`WRITE_METHODS` **22 方法**名单（§4.1）；守恒 no-op + once-warn（模块级 Set）；透传；导出 `normalizeNodeMode(raw)`（§2.5）；导出 `WRITE_METHODS` 供反射测试 |
| N2 | `Dotnet/NodeMode.cs` | `internal static class NodeMode`：`IsBrowseMode()` = `normalize(Get("VRCX_NodeMode")) === 'browse'`；`normalize` 纯函数（trim+lower）；非法值 `logger.Warn`；纯函数供测试 |
| N3 | `src/services/database/adapter/__tests__/readOnlyGate.test.js` | 门禁契约 + 归一化 + withTransaction 绑定测试（§6.1） |
| N4 | `Dotnet/VRCX.Tests/NodeModeTests.cs` | 归一化/默认/非法值（§6.2） |
| N5 | `docs/architecture/BROWSE_MODE_DESIGN.md`（修改） | **修正 §5 基建复用清单**："只读连接串 ✅ 已支持" → "❌ 待实现：M1 仅 SQLite C# 池只读；PG/MySQL 排 M2（机制已验证）"（R-8） |

### 3.2 修改文件

| # | 文件 | 位置 | 改动 |
|---|---|---|---|
| M1 | `src/services/database/adapter/index.js` | `initAdapter`（:248-321） | 签名 `initAdapter(mode = 'sqlite', options = {})`，`options.readOnly`；`_gatedInstances` WeakSet + `_applyReadOnlyGate`（§2.2 挂载点）；sqlite 分支 :262 后、非 sqlite `.then` :308 后调用；两处返回均保证为包装实例；`createAdapter`（:343）不动 |
| M2 | `src/plugins/interopApi.js` | :108-132 | 同批读取 `VRCX_NodeMode` → `bootNodeMode = normalizeNodeMode(...)`；:132 `await initAdapter(bootMode, { readOnly: bootNodeMode === 'browse' })` |
| M3 | `src/stores/vrcx.js` | :168-195 | browse 旁路：`normalizeNodeMode(await VRCXStorage.Get('VRCX_NodeMode')) === 'browse'` → 跳过升级树 + **schema 探测 + 启动日志三连**（§4.4）；否则原逻辑 |
| M4 | `Dotnet/SQLite.cs` | `Init()` :190-257 | browse 分支：parts = Data Source + Version=3 + `Read Only=True` + Pooling + Max Pool Size（**跳过** CollectOptions 四 PRAGMA：journal_mode/optimize 属写、busy_timeout/locking_mode 无意义）；**缺文件前置检查**：`!File.Exists(dataSource)` → 抛可行动错误（§4.4）；collector 分支连接串**逐字符不变**；`logger.Info` 记录模式 |
| M5 | `Dotnet/PostgreSQL.cs` | —— | **M1 不改**（H-3 定案）；M2 工作项引用：`Init()` :458-470 追加 `;Options=-c default_transaction_read_only=on` |
| M6 | `Dotnet/MySQL.cs` | —— | **M1 不改**（H-3 定案）；M2 工作项引用：`Init()` :256-283 改 `MySqlDataSourceBuilder` + `UseConnectionOpenedCallback`（失败 warn 降级） |
| M7 | `src/services/database/adapter/SQLiteAdapter.js` | `handleSQLiteError` :60-117（L-1） | 拆出 `isReadOnly = msg.includes('attempt to write a readonly database')` 独立分支：**不弹 modal**，`console.warn`（once）+ 归入重抛；:69-71 `isLocked` 缩回仅 `'database is locked'` |
| M8 | `src/services/database/configRepository.js` | `getString` :20-30（MEDIUM-4） | `selectOne` 包 try/catch：表缺失类错误（`/no such table|does not exist/i`）→ 返回 defaultValue + warn-once；无条件启用（collector 下 configs 表启动期必已创建，实际零影响） |
| M9 | `src/services/database/adapter/index.test.js` | 追加 | H-1 四路径测试（§6.1） |
| M10 | `Dotnet/VRCX.Tests/SQLiteBridgeTests.cs` | 追加 | browse Init 连接串断言 + 真库只读拒绝（§6.2） |
| M11 | `src/stores/vrcx.test.js`（或同级） | 追加 | 升级旁路 + 探测日志 + 登录不持久化警告（§6.1） |
| M12 | `src/services/database/__tests__/configRepository.test.js`（如无则新建） | 追加 | 表缺失降级读（§6.1） |

**明确不动**：`EngineAdapter.js`（冻结）、`database/index.js`、`migrations/*`、21 个业务模块、`Program.cs`、`src-electron/main.js`、`general.js`。

## 4. 门禁边界定义

### 4.1 拦截名单（`WRITE_METHODS`，22 方法，MEDIUM-2 修订 + PR#26 增 initValueColumnsLongText）

```
executeNonQuery, insert, bulkInsert, update, updateWhere, delete, deleteAll,
deleteWhere, increment, upsertPartial,
createTable, createIndex, alterTableAddColumn, alterTableDropColumn,
alterTableRename, dropTable,
vacuum, optimize, initUserSchema, initGlobalSchema,
dropUserSchema                                   ← 新增（PgSQLAdapter.js:1148 独有）
```

**名单完整性测试（MEDIUM-2 修订）**：不再硬编码 20 名——改为**原型反射**：遍历 `SQLiteAdapter`/`PgSQLAdapter`/`MySQLAdapter` 三个 `prototype` 的 own method names，用写动词谓词（`/^(executeNonQuery|insert|bulkInsert|update|updateWhere|delete|deleteAll|deleteWhere|increment|upsertPartial|create[A-Z]|alter[A-Z]|drop[A-Z]|vacuum|optimize|init[A-Z])/`）过滤，断言命中集合 ⊆ `WRITE_METHODS`（显式例外表随测试注释维护，当前为空）。引擎未来"只增"写方法时测试即失败，迫使名单同步；连接层兜底为第二道防线。

### 4.2 no-op 契约

| 维度 | 契约 |
|---|---|
| 返回值 | `Promise<number>` → `0`；`Promise<void>` → `undefined` |
| 异常 | 不抛（正常 resolve） |
| 副作用 | 零 SQL 发出；每进程每方法一次 `console.warn('[browse] 只读模式，写方法已跳过: name')` |
| 事务 | `withTransaction`/`beginTransaction`/`commit`/`rollback`/`keepAlive` 透传（只读事务合法）；事务体内写仍被拦截（MEDIUM-1 测试锁定） |

### 4.3 透传清单 与 非门禁写通道（M-1/MEDIUM-3 修订）

**透传（不拦截）**：`execute`、`select*`、`count*`、`listTables`、`getTableColumns`、`listTablesTypes`、`userTable`、`sql*` 片段、`daysAgoISO`、`onTableChange`/`_onFunnelEvent`、`getPoolStats`、`clearIdleConnections`、`isConnected`、`getHealth`、`engineType`、`connectionString`、`withPrefix`、`_normalizeArgs`、`_txStack` 等。

**`execute()` 裸 SQL 通道（M-1 审计结论）**：C# `ExecuteJson` 经 `ExecuteReader`（SQLite.cs:716-759）**确实会执行写 SQL**。单例路径 `execute` 调用点逐一审计：`gameLog.js:1573`（SELECT）、`migrations/index.js:914`（子查询读）等**全部为读**。决策：**不加入门禁名单**（会误伤读路径），文档声明契约——"单例路径 `execute` 约定仅读；写 SQL 穿透由连接层兜底"（M1 的 SQLite 只读池可拒；PG/MySQL 为 M2 缺口 R7）。

**MEDIUM-3 涌出策略**：绕过门禁的写（`execute` 写 SQL、C# 桥直调）在 browse 下抛 DB 层错误——**允许涌出**（backstop 生效的证据），不新增抑制；由 L-1 修订（M7）保证错误不再被误映射为"Database is locked"误导弹窗，改为可辨识的 warn + rethrow；涌出频率预期极低（单例路径读约定 + 门禁覆盖），log-once 防刷屏。

### 4.4 空库/低版本/缺文件行为（MEDIUM-4 + R-4 新增小节）

| 场景 | 探测 | 行为 |
|---|---|---|
| browse + 空库（文件存在但无 configs 表） | vrcx.js 旁路内 `await adapter.listTables('configs')` 为空 | `console.warn('[browse] 空库：configs 表不存在，仅可读已存在表（通常为空）。请先以 collector 模式启动完成初始化。')`；继续启动；`configRepository.get*` 走 M8 容错降级（返回默认值），**不崩溃** |
| browse + 低版本库（0 < v < TARGET） | 版本读取（:168）+ 探测 | `console.warn('[browse] 库版本 {v} 低于当前 {T}，浏览模式不执行升级；schema 可能不兼容，部分查询可能失败。建议以 collector 模式启动一次完成升级。')`；继续启动 |
| browse + 版本未知（v == 0） | 版本读取 | `console.warn('[browse] 数据库版本未知（空库或从未初始化）。')` |
| browse + 文件不存在（SQLite） | C# Init browse 分支 `File.Exists` 前置检查（M4） | **fail-fast**：抛 `InvalidOperationException("浏览模式：数据库文件不存在：{path}。请先以 collector 模式启动一次完成初始化，或检查 VRCX_Database.name 配置。")`——可行动报错而非裸 `unable to open database file`；M2 换友好对话框。不降级为可写打开（违反 backstop 原则） |
| browse + 账号前缀错配（M-3） | —— | **M1 文档约束**：browse 仅能读 collector 已初始化的账号表；登录未初始化账号 → 查询抛 `no such table`（已知限制，§8 R8）；查询层容错与登录禁用归 M2 |

**启动日志三连（R-4，vrcx.js browse 旁路）**：
```
[browse] 浏览模式（只读）已启用：VRCX_NodeMode=browse
[browse] 数据库版本：{v}（目标 {TARGET_DB_VERSION}）
[browse] 只读：DB 写入被门禁丢弃；登录状态与本地设置不会持久化
```

### 4.5 门禁覆盖面与豁免（H-2 语义并入）

| 面 | 门禁 | 说明 |
|---|---|---|
| 单例 adapter（默认连接） | ✅ Proxy（22 方法） | 全部业务模块 + configRepository + 迁移 runner + coordinators + **L1 采集链（LogWatcher→JS→adapter）** 均经此 |
| `createAdapter` 实例（pullEngine dst、OnConnection 路径） | ❌ 不门禁 | 用户显式导出流，目标非共享库；SQLite createAdapter 默认已只读（pullEngine:226-229 显式覆盖才可写）；C# doc 调用方自控连接串 |
| raw `execute` 写 SQL / C# 桥直调 | 连接层兜底（SQLite M1；PG/MySQL M2） | 允许涌出 + L-1 可辨识报错（§4.3） |
| VRCXStorage（JSON） | ❌ 不门禁 | 非数据库面；`VRCX_NodeMode` 持久化依赖 |

## 5. 三引擎只读连接方案（H-3 修订：M1 仅 SQLite，PG/MySQL 为 M2 参考）

| 引擎 | 归属 | 精确变更 |
|---|---|---|
| SQLite | **M1（本次实现）**，`SQLite.cs::Init()` :204-253 | browse 分支 parts = `Data Source="..."` + `Version=3` + **`Read Only=True`** + `Pooling=True` + `Max Pool Size=16`；**跳过** `CollectOptions()` 四 PRAGMA；缺文件前置检查（§4.4）；collector 分支逐字符不变 |
| PG | M2 参考（机制已验证：Npgsql 10.0.3 `Options` = "Set PostgreSQL configuration parameter default values for the connection"） | `PostgreSQL.cs::Init()` :458-470 追加 `;Options=-c default_transaction_read_only=on`；池化参数不变；`DataSourceCache` 按连接串隔离只读/可写池（:280/516） |
| MySQL | M2 参考（机制已验证：MySqlConnector 2.6.1 `UseConnectionOpenedCallback`，`ValueTask` 可异步、`Conditions: None\|New\|Reset` 覆盖池借出全条件；**无** init_command/只读关键字） | `MySQL.cs::Init()` :256-283 改 `MySqlDataSourceBuilder` + 回调内 `SET SESSION TRANSACTION READ ONLY`（每次打开重新施加，`ConnectionReset=true` 重置后仍有效）；回调失败 warn 降级 |

**M2 前置条件**：活库 CI 或人工验证脚本就绪后落地（§6.3 清单沿用）。

## 6. 测试计划（R-5 扩展）

### 6.1 vitest 单测（CI 全自动）

| 用例 | 文件 | 覆盖 |
|---|---|---|
| no-op 契约全表（22 方法） | N3 | 逐个断言返回 0/undefined、底层未调用（vi.fn 包 inner）、once-warn 次数 |
| 名单完整性（反射） | N3 | §4.1 原型反射谓词测试（MEDIUM-2） |
| **H-1 四路径** | M9 `index.test.js` | ① 模块加载单例 + `readOnly:true` → 包装；② `initAdapter('sqlite')` 复用路径（现存在实例）→ 包装；③ `initAdapter('postgresql')` 新建路径 → 包装（mock 懒加载模块）；④ **两处返回值（:265 与 :320）均为包装实例**；⑤ 双重调用幂等（WeakSet 不重复包） |
| **MEDIUM-1 withTransaction 绑定** | N3 | `proxy.withTransaction(async () => { await proxy.insert(...); await inner.selectOne(...) })` → insert no-op、读正常、commit 不抛、`_txStack` 平衡；`this` 链：inner 方法内部 `this._normalizeArgs` 经 proxy 正常 |
| **LogWatcher 链路（H-2）** | N3/集成 | M1 下 browse 不启动 LogWatcher（LogWatcher.cs::Init 门控，S2 测试覆盖启动跳过）；本条验证 **M2 回退语义**：模拟 `addGameLogEvent` → gameLogCoordinator 写路径 → 门禁实例 → 全部 no-op、无异常（断言"采集运行"下不崩溃） |
| 透传 | N3 | 读方法/`engineType`/`connectionString`/`onTableChange` 透传 |
| 归一化契约（MEDIUM-5） | N3 | `normalizeNodeMode`：'browse'/' Browse '→browse；'auto'/'collector'/''/null/'BROWSE' 大小写→collector |
| **升级旁路 + 探测 + 日志三连** | M11 | browse 分支：跳过 Branch A/B；`listTables` 探测分支日志；版本日志；登录不持久化警告 |
| **configRepository 降级读** | M12 | 表缺失 → `getInt/getString` 返回默认值 + warn-once；表存在 → 原行为 |
| **execute 审计回归** | N3/现有 | 单例路径 execute 读调用点（gameLog.js:1573、migrations:914）在门禁下不受影响（透传） |
| collector 回归基线 | 现有全量 | `adapterContract`/`changeNotification`/`transaction`/`connectionStringRouting`/`migrationEquivalence`/各引擎 unit test **零改动全绿**（`initAdapter` 缺省 readOnly=false 分支无逻辑变化） |

### 6.2 Dotnet.Tests（xUnit，CI 全自动）

| 用例 | 文件 | 覆盖 |
|---|---|---|
| SQLite 连接串断言 | M10 | browse Init → 含 `Read Only=True`、不含 `PRAGMA` 段；collector Init → 与基线字符串**逐字符相等** |
| **连接层拒绝（验收核心自动化证据）** | M10（真文件库） | browse Init 后 `ExecuteNonQuery("INSERT ...")` / `("CREATE TABLE ...")` → 抛 `attempt to write a readonly database`；`ExecuteJson("SELECT 1")` 正常；**缺文件 → 可行动错误消息断言** |
| 归一化契约（MEDIUM-5） | N4 | `NodeMode.normalize`：与 JS 同表用例（'browse'/'Browse '/auto/collector/空/非法） |
| collector 回归基线 | 现有全量 | SQLiteSecurityTests 等 60+ 用例零改动全绿 |

### 6.3 需活库/人工验证（PG/MySQL，M2 落地时执行；M1 记录在案）

| # | 场景 |
|---|---|
| 1 | PG browse 连接 → INSERT/UPDATE/CREATE TABLE 均报 read-only 错误；collector 正常（M2 实现后） |
| 2 | MySQL browse 连接 → DML 报 error 1792；**DDL 行为随版本记录**（R1） |
| 3 | 双实例端到端：collector 正常采集；browse 零写库、读正常、启动不弹升级框 |
| 4 | 回滚验证：删 `VRCX_NodeMode` 或置 auto → 行为与改造前一致 |

## 7. 失败模式与回滚策略

| 失败模式 | 表现 | 处置 |
|---|---|---|
| browse + SQLite 文件不存在 | Init 抛**可行动错误**（M4），启动中止 | fail-fast（M1 接受；M2 友好对话框）。恢复：删 `VRCX_NodeMode` 或置 collector 重启 |
| browse + 空库/低版本 | 探测 warn + 降级读（M8/M11），**不崩溃** | §4.4 行为；建议先用 collector 初始化 |
| 非门禁写通道涌出（execute 写 SQL） | SQLite 连接层抛 readonly 错误 | 允许涌出（backstop 证据）；L-1 修订后 warn + rethrow，不再误导为"Database is locked"（M7） |
| PG/MySQL browse 写穿透（M1 无连接层兜底） | 写**成功**落库（缺口 R7） | 门禁已拦已知写面；风险显式声明，M2 补连接层 |
| 升级树旁路遗漏某分支 | 只读连接抛错 → 误导弹窗 | M7 修错误映射；M2 统一文案 |
| 名单漏新写方法 | 穿透 → SQLite 连接层拒绝（响亮） | 反射测试（§4.1）+ 连接层兜底 |
| collector 连接串被误改 | M10 等价性断言失败 | CI 拦截 |

**回滚策略**：配置级——删/改 `VRCX_NodeMode` 即回 collector；代码级——单 commit revert（M1 改动面 8 源文件 + 5 测试/文档文件，无迁移、无 schema 变更）。

## 8. 风险清单

### 8.1 新增/修订风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | MySQL DDL 是否被会话只读拦截随版本而异（M2 事项） | 代码门禁覆盖 DDL；M2 人工验证记录 |
| R2 | 只读连接 + WAL/optimize PRAGMA 冲突 | browse 分支不拼 PRAGMA parts（M4）；测试断言 |
| R3 | browse 缺文件 fail-fast | 可行动报错（M4）；M2 对话框 |
| R4 | Proxy 名单维护义务 | 反射测试 + 连接层兜底 |
| R5 | browse 下 L1–L4 空转 CPU + 读回陈旧数据 | 接受（决策 6 语义显式声明 §2.6）；M2 随检测关闭 |
| R6 | `auto` 用户期待自动检测而 M1 无 | 语义文档 + 发布说明（§10） |
| R7 | **PG/MySQL 连接层只读缺口（H-3 定案引入）** | 显式文档声明 + §6.3 人工清单 + M2 工作项（机制已验证，含 §5 参考变更） |
| R8 | browse 账号前缀错配（M-3） | 文档约束；查询容错与登录禁用归 M2 |

### 8.2 设计 §7 已知风险的处理

- "只读连接语义差异：PG/MySQL 需验证与现有连接串/池兼容" → M2 事项（机制已验证：`DataSourceCache` 按连接串隔离池）；M1 不再声称已解决。
- 心跳时钟偏差 / gamelog 全局表 / 同机双实例误报 / 降级中断 → M2+ 范围，不受 M1 影响。

## 9. 验收标准映射（H-3 措辞修订）

| M1 验收 | 证据链（自动化 → 人工） |
|---|---|
| **browse 模式零写库（代码门禁）** | ① N3 22 方法 no-op 契约 + 反射名单测试；② M9 H-1 四路径 + 返回值断言；③ M11 升级旁路 + 探测；④ 端到端人工 #3 |
| **browse 模式零写库（SQLite 连接层拒绝）** | ⑤ M10 真库 INSERT/DDL 抛 readonly 错误（CI 自动化）；⑥ 连接串断言（Read Only=True、无 PRAGMA） |
| **PG/MySQL 连接层只读（M2 项）** | ⑦ 缺口声明（§8 R7）+ §6.3 人工清单；M1 不验收此项 |
| **collector 行为不变** | ⑧ `initAdapter` 缺省分支零逻辑改动（M9 回归）；⑨ M10 collector 连接串逐字符等价断言；⑩ 全量现有 vitest + Dotnet.Tests 零改动全绿；⑪ 人工 #4 |

## 10. M1 最小 UX 与文档留痕（R-6 / L-3）

**R-6 启动日志警告（M2 横幅的 M1 临时替代，vrcx.js browse 旁路实现）**：
```
[browse] 浏览模式（只读）已启用：VRCX_NodeMode=browse
[browse] 数据库版本：{v}（目标 {T}）；schema 探测：{configs 表存在/缺失}
[browse] 只读：DB 写入被门禁丢弃；登录状态与本地设置不会持久化；建议单实例多账号
```

**L-3 发布说明级声明（随 M1 PR 的 CHANGELOG/PR 描述）**：
- M1 行为：`VRCX_NodeMode` 默认 `auto` 且**等价 collector**（无自动检测）；仅显式 `browse` 生效只读。
- M2 行为变更预告：`auto` 将具备自动检测（发现其他活跃实例 → 自动降级 browse），届时默认值语义变化，请用户提前显式配置 `collector` 以锁定采集节点。

## 附：Resume-Critical 设计事实（v2）

1. **时序铁律**：数据库连接由主进程先建（Program.cs:295-314 / main.js:161-176），browse 只读必须在 C# `Init()` 内生效（M4）；JS 门禁只覆盖渲染进程面。
2. **H-3 定案**：M1 = SQLite C# 池只读（连接串 `Read Only=True` + 跳过写 PRAGMA + 缺文件可行动报错）；PG/MySQL 连接层只读 = M2（机制已验证：Npgsql 10.0.3 `Options` / MySqlConnector 2.6.1 `UseConnectionOpenedCallback`）。
3. **门禁挂载**：`adapter/index.js` `initAdapter` 双分支收敛 + `_gatedInstances` WeakSet 幂等；**返回值 = 包装实例**（:265 与 :320 两处）；get trap 返回未绑定 inner 函数（this 链=Proxy，MEDIUM-1 透传正确）。
4. **名单 22 方法**（含 `dropUserSchema` PgSQLAdapter:1148、`initValueColumnsLongText` MySQLAdapter PR#26）；完整性测试用原型反射 + 写动词谓词，非硬编码。
5. **no-op 契约**：守恒返回（0/undefined）、不抛、once-warn；`withTransaction` 透传；`execute` 不入名单（单例路径读约定 + 连接层兜底，M-1 审计结论）。
6. **空库/低版本/缺文件**：探测 → warn → 降级不崩溃（M8 configRepository 容错 + M11 探测日志三连）；缺文件 fail-fast 可行动报错（M4）。
7. **归一化契约**：`trim+lower === 'browse'` → browse；其余（含 auto/collector/非法）→ collector（fail-safe）；C#/JS 双端同表测试（MEDIUM-5）。
8. **H-2 结论**：LogWatcher 无 C# 直写（仅 :297 ExecuteScriptAsync 推事件）；**M1 实现 = browse 不启动 LogWatcher 采集线程**（`LogWatcher.cs::Init()` 门控，切片计划 S2）；"采集运行 + 门禁丢弃"为 M2 回退语义（§2.6 评审点）。
9. **L-1**：`handleSQLiteError`（SQLiteAdapter.js:60-117）拆 readonly 独立分支，warn 不弹误导 modal。
10. collector 分支连接串逐字符不变 = 验收硬性回归线（M10 断言）。

## 切片计划（scrum-master v2）

| 切片 | 内容 | 验证命令 | DoD |
|---|---|---|---|
| S1 | `readOnlyGate.js` + `readOnlyGate.test.js`；`adapter/index.js`（双分支 + WeakSet + 返回包装）；`index.test.js` | `npx vitest run src/services/database/adapter/readOnlyGate.test.js src/services/database/adapter/index.test.js`；`npm run typecheck:js`；oxlint/oxfmt | 22 方法 no-op 全表；initAdapter sqlite 复用路径为 Proxy；幂等；withTransaction 内写拦截；collector 零侵入 |
| S2 | `NodeMode.cs` + `NodeModeTests.cs`；`SQLite.cs`（browse 只读串 + 跳过 PRAGMA + 缺文件检查）；`LogWatcher.cs`（browse 不启动）；`SQLiteBridgeTests.cs` | `dotnet test Dotnet/VRCX.Tests` | collector 连接串逐字符不变；browse 串含 Read Only=True 无 PRAGMA；缺文件 fail-fast；真库只读拒绝；C# 归一化单测 |
| S3 | `SQLiteAdapter.js`（M7 readonly 分支）；`configRepository.js`（M8 降级读）；M12 测试 | vitest 对应文件 | readonly 错误不误报 locked；configs 缺失 getString 返默认值 |
| S4 | `vrcx.js`（旁路+探测+日志三连）；`interopApi.js`（读 NodeMode 传参）；`vrcx.test.js`；N5 文档修正 | `npx vitest run src/stores/__tests__/vrcx.test.js`；typecheck | browse 启动零 DB 写；空库/低版本 warn 不崩溃；collector 回归；normalizeNodeMode 双端一致 |
| S5 | 验收 | `npm test`；`dotnet test`；人工清单 | SQLite 双实例 E2E 零写库；回滚验证 |

依赖：S1∥S2∥S3 → S4 → S5；评审门 G1（S1 后）/G2（S2 后）/G3（S4 后）/G4（合并前）。
