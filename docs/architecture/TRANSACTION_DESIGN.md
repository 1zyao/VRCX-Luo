# 栈式事务上下文 + 统一池化设计

> 状态：**已实现**（2026-08 随 database-refactor 并入 main，PR #17 后）。本文档为设计稿，实现与设计逐条对应；实现侧新增 `BeginTransactionOnConnection(connectionString)`（pullEngine dstAdapter 桥接）与池监控扩展（`getPoolStats` 6 字段 + `clearIdleConnections`，见 ADAPTER_API.md）。

## 背景（改造前问题，已修复）

VRCX-Luo 的 PostgreSQL C# 层(`Dotnet/PostgreSQL.cs`)之前每次 `ExecuteNonQuery` 都 `_dataSource.OpenConnection()` 借新连接 + `using` 还池,导致 `BEGIN` 在连接 A、`INSERT` 在连接 B、`COMMIT` 在连接 C——事务语义断裂(连接 A 的事务随还池被 Npgsql 自动 reset)。这是 C# 包装层的疏漏(照搬 Npgsql 现代池化示例,未补"持连接事务 API"),不是 PG/Npgsql 引擎限制。

SQLite.cs / MySQL.cs 的单连接 + lock 模式虽然事务能跑,但有隐患:长查询阻塞健康检查;事务期间的非事务查询隐式混入当前事务。

## 方案:统一池化 + 栈式事务上下文 + Sliding 超时

### C# 层(三引擎对称)

| 引擎 | 池实现 | pin 机制 |
|---|---|---|
| PostgreSQL | `NpgsqlDataSource` 池 | `_pinned` ConcurrentDictionary<long, TxHolder> |
| SQLite | ADO.NET `Pooling=True` 池(System.Data.SQLite) | `_pinned` ConcurrentDictionary<long, TxHolder> |
| MySQL | MySqlConnector 内置池(`Pooling=True`) | `_pinned` ConcurrentDictionary<long, TxHolder> |

三引擎都暴露:
- `BeginTransaction()`:借连接 + BEGIN + 标记 pin + 启动 sliding Timer,返回递增 connId
- `CommitTransaction(connId)`:COMMIT + 还池 + 清 Timer
- `RollbackTransaction(connId)`:ROLLBACK + 还池 + 清 Timer(已超时则 no-op) 事务已死/不在事务/桥异常
- `KeepAliveTransaction(connId)`:重置 sliding Timer,不执行 SQL(用于 withTransaction 体内 await 长时间非 DB 操作时续命);返回 `true` 表示已重置,`false` 表示 connId 已超时回滚(no-op)
- `Execute`/`ExecuteNonQuery`/`ExecuteJson` 加可选 `long? connId` 尾参:
  - connId 有值:PG 走 pinned 连接 + 重置 Timer;SQLite/MySQL 重置 Timer(单连接无需路由)
  - connId 无值:走默认池/单连接,行为与改造前一致(零回归)

### Sliding 超时(防泄漏安全网)

- `TX_IDLE_MS = 60000`(60 秒)
- Timer 在 BeginTransaction 时启动
- 每次 Execute/ExecuteNonQuery 调用前暂停 Timer(`Change(Timeout.Infinite, -1)`),执行完 finally 恢复(`Change(TX_IDLE_MS, -1)`)——防止慢查询(异地高延迟)执行中误触发超时
- 真卡死(JS await 悬挂、UI 阻塞事件循环)60 秒后回收;长事务持续有 SQL 续命,不误杀

#### Timer 排队竞态防御(InFlight + TimedOut)

`Timer.Change(Timeout.Infinite, -1)` 不会取消已排队、即将执行的
回调。如果 Timer 回调恰好在 `ExecutePinned` 暂停 Timer 的瞬间已被
线程池排队,回调仍可能在 SQL 执行期间获取 `_txLock` 并 Dispose
连接,导致 `ObjectDisposedException`。

防御机制(三引擎对称):
- `TxHolder` 新增 `InFlight`(int,引用计数)+ `TimedOut`(bool)字段
- `ExecutePinned`/`ExecuteNonQueryPinned` 执行 SQL 前
  `Interlocked.Increment(ref h.InFlight)`,finally 中
  `Interlocked.Decrement`
- `OnTxTimeout` 检测 `InFlight > 0` 时不立即回滚,设 `TimedOut = true`
  后返回,让 `ExecutePinned` 的 finally 检测到 `TimedOut` 后自行
  `TryRemove + Timer.Dispose + CleanupTx`(回滚 + 还池)
- 触发条件极苛刻(事务 idle 接近 60s + Timer 已排队 + 恰好此时
  发 SQL + SQL 执行跨过回调瞬间),但后果不可诊断,故加防御

⚠️ **最佳实践**:JS 侧应在事务内长时间非 DB await 前调
`keepAlive()` **提前续命**,而非"卡着 60s 的点回来打卡"——
临近超时才发 SQL 会进入 Timer 回调与 SQL 执行的竞态窗口
(虽有 InFlight 防御不会崩,但事务仍会被判定超时回滚)。

### JS 层(栈式事务上下文 + 并发串行队列)

```
EngineAdapter 基类:
  _txStack = []        // 实例属性,每实例独立
  _txTail  = resolved  // 事务串行队列尾(并发安全)
  _txInFn  = false     // 当前是否在事务 fn 的同步段内(嵌套检测)

  beginTransaction()  → 检查栈非空(嵌套拒绝)→ _doBegin() → push connId
  commit(connId)       → _doCommit(connId) → finally pop 栈
  rollback(connId)     → _doRollback(connId) → finally pop 栈
  keepAlive()          → 读栈顶 connId → _doKeepAlive(connId) → 重置 C# Timer → 返回 bool
  withTransaction(fn)  → 同步嵌套检查 → append _txTail → beginTransaction → fn → commit(抛错则 rollback)

  execute/executeNonQuery 实现(子类):
    const connId = this._txStack.at(-1)  // 读栈顶
    // 传给 C# 决定走 pinned 连接还是默认池
```

#### 并发安全(2026-08 补充,修复 #27)

**背景**:"JS 单线程:无并发打断,栈操作原子"假设在异步下不成立。
`withTransaction` 内部 `await fn()` 会把控制权交还事件循环,两个独立异步流
(WS feed 写入、用户对话框刷新、图表 store)可以在时间上交错——后到者看到
`_txStack` 非空即被误判为"嵌套"抛错;若放行则两个事务同时存在,SQL 全部
打到同一个 pinned 连接,引发 C# 侧连接损坏。

**方案**:`withTransaction` 增加串行队列(`_txTail` Promise 链):

- 并发调用按到达顺序排队,前一个事务 commit/rollback 后才执行下一个,
  同一 adapter 实例同时只有一个事务 → 原子性与并发安全兼得。
- 真正**调用栈嵌套**(在另一个 withTransaction 的 fn 同步段内再次调用)
  仍抛错:进入 fn 前置 `_txInFn = true`,fn 的同步前缀(异步函数执行到首个
  await 前)完成后立即复位。同步段内的再次调用会被 `_txInFn` 捕获;
  并发调用在 fn 挂起后才进入,此时 `_txInFn` 已复位 → 走串行队列而非抛错。
- `beginTransaction` 保留栈非空检查作防御(手动模式/测试)。
- 隔离保证不变:每个 adapter 实例独立 `_txStack`/`_txTail`,srcAdapter/
  dstAdapter 天然不交叉。

### keepAlive() — 事务心跳续命

`keepAlive()` 是逃生舱方法,用于 withTransaction 体内 await
长时间非 DB 操作(用户确认对话框、输入框等待)时重置 C# 侧
sliding idle timer,防止 60s 超时自动回滚。

- 返回 `Promise<boolean>`:`true` 表示续命成功(事务仍存活),
  `false` 表示事务已超时回滚或当前不在事务中
- 读栈顶 connId,委托 `_doKeepAlive(connId)` → C#
  `KeepAliveTransaction(connId)` 重置 Timer
- 事务外调用(栈空)返回 `false`
- 已超时回滚的 connId 返回 `false`(C# 侧 TryGetValue 失败,
  不抛错)
- C# 桥异常或 binding 缺失也返回 `false`(视为事务已死)
- 调用方可在 await 用户交互后检查返回值,提前干净退出事务体:
  ```
  if (!await adapter.keepAlive()) return; // 事务已死,提前退出
  ```

⚠️ keepAlive 是逃生舱,不是鼓励在事务内做长交互。事务应尽可能
短——长时间持有事务锁会阻塞其他操作。能拆到事务外确认的,优先
拆出去(乐观锁模式)。详见 withTransaction JSDoc 警告。

### API 可见性:@private 标注(2026-07-25 补充)

`beginTransaction`/`commit`/`rollback` 三个低级方法标为
`@private`,生产代码应使用 `withTransaction(fn)`。理由:

- 三个低级方法承载栈管理逻辑(push/pop/嵌套检查),不是简单的
  私有转发——它们是 `withTransaction` 所依赖的底层契约层。
- `@private` 触发 IDE 高亮(WebStorm "Private member accessed"),
  引导开发者用 `withTransaction(fn)`;同类内调用
  (`this.beginTransaction()`)不触发,`withTransaction` 内部正常。
- ESLint 不报错(`eslint-plugin-jsdoc` 未在 `eslint.config.mjs`
  启用 `check-access` 规则),仅靠 IDE inspection 引导。
- 生产代码 0 处直接调用;测试文件(transaction.test.js /
  migrationTransactionProtection.test.js / SQLiteAdapter.test.js)
  有意直接调用以验证栈契约,文件头/块前已加注释说明。

### 隔离保证

- **实例隔离**:每个 adapter 实例独立 `_txStack`,srcAdapter/dstAdapter 天然不交叉
- **try/finally 保证栈清洁**:commit/rollback 的 finally 必 pop,抛错也恢复
- **并发串行化**:`_txTail` 队列保证同一实例同时只有一个事务(见上文
  "并发安全");并发调用排队等待而非抛错
- **connId null/0 走默认池**:事务外调用零行为变化
- **调用栈嵌套显式拒绝**:在事务 fn 同步段内再次调用 withTransaction 抛错
  (与 SQLite 现有行为一致);仅并发交错不抛错

### 七类干扰路径验证(见 transaction.test.js)

1. 事务外调用:栈空,不影响行为 ✅
2. 调用栈嵌套 withTransaction:抛错 ✅
3. srcAdapter vs dstAdapter:实例属性隔离 ✅
4. 串行多个 withTransaction:栈深度恢复 0 ✅
5. withTransaction 抛错:rollback + 栈清洁 ✅
6. C# 超时回收:JS 栈残留死句柄,首次用即报错 + pop ✅
7. withPrefix 叠加:两属性独立,正交 ✅
8. 并发 withTransaction(时间交错):串行排队,不抛错,栈恢复 0 ✅
9. 并发 withTransaction 抛错不影响后续事务 ✅

## 改动范围

### C# 层
- `Dotnet/PostgreSQL.cs` — _pinned Map + 4 方法 + connId 参数
- `Dotnet/SQLite.cs` — _pinnedConnId 单槽 + 4 方法 + connId 参数
- `Dotnet/MySQL.cs` — 同 SQLite

### JS 基类(破例,注释已注明)
- `adapter/EngineAdapter.js` — _txStack + beginTransaction/commit/rollback + withTransaction + _doBegin/_doCommit/_doRollback;并发串行队列 `_txTail` + 嵌套检测 `_txInFn`(2026-08,修复 #27)

### JS 适配器子类
- `adapter/PgSQLAdapter.js` — _doBegin/Commit/Rollback 调 C# + execute/executeNonQuery 读栈顶传 connId
- `adapter/SQLiteAdapter.js` — 同上
- `adapter/MySQLAdapter.js` — 同上

### 消费者改造
- `mutualGraph.js` / `activityV2.js` / `migrations/index.js` / `database/index.js` — begin/try/commit/catch-rollback → withTransaction
- `mutualGraph.updateMutualsForFriend` / `avatarFavorites.clearAvatarHistory` — 顺手包事务(之前无事务)

### push/pull 引擎
- `pushEngine.js` / `pullEngine.js` — 分组事务(global 一组、per-prefix 一组、mirror 一组)

### 测试
- `adapter/__tests__/SQLiteAdapter.test.js` — begin/commit/rollback → 新签名 + withTransaction 6 例
- `migrations/__tests__/migrationTransactionProtection.test.js` — 新签名
- `test/contract/adapter-contract.js` — 新签名 + stub.beginTransaction async
- `adapter/__tests__/transaction.test.js`(新增)— 栈上下文 16 例
- `pushEngine.test.js`(新增)— 分组事务 11 例
- `pullEngine.test.js`(新增)— 分组事务 9 例

### 测试覆盖空白(2026-07-25 标注)

PG/MySQL 引擎级事务语义(pinned 连接生命周期、C# 桥往返、超时
Timer 回收后 rollback no-op)目前仅由 `transaction.test.js` 用
`MemorySQLiteAdapter` 做引擎无关的栈契约验证。PG/MySQL 特定行为
需真实后端 + C# 桥,无法在纯 JS unit test 中覆盖,已在
`PgSQLAdapter.unit.test.js` / `PgSQLAdapter.pgsql.test.js` /
`MySQLAdapter.mysql.test.js` 文件头加 TODO 标注,待 follow-up 补
集成测试。

### SQLite 池化并发写安全

池化改造后多个连接可能同时写同一 `.db` 文件。SQLite 只支持
一个并发写事务,竞争时其他连接阻塞等锁。通过 `DefaultOptions`
的三个 PRAGMA 缓解(拼入连接字符串,每个池化连接 `Open()` 时执行):

| PRAGMA | 值 | 作用 |
|---|---|---|
| `busy_timeout` | `5000` (ms) | 锁竞争时等 5s 而非立即抛 "database is locked",让短写事务(ms 级)有机会完成。5s 足够桌面场景;若仍超时说明有死锁/长事务,应快速失败而非让 UI 卡 60s。**不对称到 PG/MySQL 的 15/30s**——那些是网络层建连/SQL 执行超时(秒),SQLite 是本地文件锁等待(毫秒),概念层次不同。 |
| `journal_mode` | `WAL` | Write-Ahead Logging,读写并发,写写串行。读不被写阻塞,写事务持锁时间 = 单条 SQL 执行时间(几 ms)。 |
| `locking_mode` | `NORMAL` | 每条 SQL 执行完释放文件锁,不独占。与池化目标一致(让事务外读不被事务阻塞)。`EXCLUSIVE` 会独占文件到 `Exit()`,阻塞外部工具(DB Browser 等)和其他进程,不采用。 |

**风险评估**:VRCX 桌面单进程,写来源主要是 updateLoop + 日志 + L3 轮询,量级每秒几个写,远达不到锁竞争场景。5s busy_timeout 是兜底保险,正常操作几乎不会触发。

## 效果

- **原子性**:分组事务内中途崩溃全回滚,不再留半拷贝
- **性能**:fsync 次数从"每批 1 次"降到"每组 1 次"(5-10× 提速)
- **错误隔离**:per-group try/catch,组内失败回滚该组,其他组保留
- **非事务隔离**:事务期间的非事务调用走其他连接,不混入事务(SQLite/MySQL 之前有此隐患)
- **防泄漏**:sliding 60s 超时自动回滚,JS 忘 commit 不泄漏连接
