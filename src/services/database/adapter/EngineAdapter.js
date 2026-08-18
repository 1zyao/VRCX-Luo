/**
 * Abstract base class for database engine adapters.
 *
 * Defines the interface that every engine adapter must implement.
 * Subclasses must implement all `@abstract` methods;
 * `@optional` methods have default implementations and may be overridden.
 *
 * Tag conventions:
 *   @abstract         — subclass MUST implement; base throws 'abstract'
 *   @optional         — base provides a default; subclass MAY override
 *   @engine-specific  — produces engine-dependent SQL syntax (SQLite/PgSQL/MySQL differ)
 *
 * Interface frozen at 42 abstract + 3 optional methods (2026-07-16).
 *
 * 2026-07-25 破例:事务接口 begin()/commit()/rollback() 改名为
 * beginTransaction()/commit(connId)/rollback(connId),并新增
 * withTransaction(fn) 默认实现 + _txStack 实例字段。原因是
 * PostgreSQL.cs 的池化设计导致跨调用事务断裂,修复需要在 JS
 * 层维护事务上下文栈,以让 withTransaction 体内的所有
 * execute/executeNonQuery/bulkInsert 等自动走 pinned 连接。
 * 22 个数据方法签名不变(栈顶在 execute/executeNonQuery 内部读)。
 *
 * 2026-07-25 补充:beginTransaction/commit/rollback 三个低级方法
 * 标为 @private —— 生产代码应使用 withTransaction(fn),手动调用
 * 这三个方法只在测试中验证栈契约时出现。@private 触发 IDE 高亮
 * 但不触发 lint 失败(eslint-plugin-jsdoc 未在 eslint.config.mjs
 * 启用),WebStorm 仍会对外部调用显示警告,达到引导效果。
 * 详见 docs/architecture/TRANSACTION_DESIGN.md。
 *
 * onTableChange(变更通知订阅)是 @optional 默认实现——基类提供完整
 * 实现(订阅注册表 + 完备层计数器轮询 + 基线去重),实现方不覆写
 * 即退化为 no-op,行为与现状一致;引擎只需覆写 _readChangeCounter()
 * 启用计数器兜底。详见 docs/architecture/ADAPTER_API.md §9。
 *
 * The `engineType` getter below is metadata, not part of the 42+3
 * method interface — it carries no SQL semantics and exists solely so
 * the migration runner can detect the active engine without importing
 * adapter classes (added 2026-07-19 to align with the MySQL branch).
 */

class EngineAdapter {
    /** @type {string|null} */
    _prefixOverride = null;

    /**
     * 连接标识:默认单例为 null(对应 C# 侧 conn="default"),
     * createAdapter 实例为构建后的 connectionString。
     * 写漏斗事件按此值路由(见 docs/architecture/ADAPTER_API.md §9)。
     * @type {string|null}
     */
    connectionString = null;

    /**
     * 事务 connId 栈,withTransaction 自动 push/pop。
     * execute/executeNonQuery 实现里读 `this._txStack.at(-1)` 决定走
     * pinned 连接(事务中)还是默认池(事务外)。
     * 实例属性,每个 adapter 实例独立,srcAdapter/dstAdapter 天然隔离。
     * @type {number[]}
     * @protected
     */
    _txStack = [];

    /**
     * 事务串行队列尾(并发安全)。withTransaction 把本次执行 append 到链尾,
     * 让并发调用按到达顺序串行执行,而非"栈非空即抛错"。
     *
     * 背景:TRANSACTION_DESIGN.md 的"JS 单线程:无并发打断,栈操作原子"
     * 假设在异步下不成立——withTransaction 内部 `await fn()` 会把控制权交还
     * 事件循环,两个独立异步流(WS feed 写入、用户对话框刷新等)可以时间交错。
     * 若栈非空即抛错,后到者会被误判为"嵌套"而失败;若放行则两个事务同时
     * 存在,SQL 全部打到同一个 pinned 连接导致 C# 侧连接损坏。
     * 串行队列让同一 adapter 实例同时只有一个事务,兼顾原子性与并发安全。
     *
     * @type {Promise<void>}
     * @protected
     */
    _txTail = Promise.resolve();

    /**
     * 当前是否正在执行某个事务 fn 的同步前缀。
     * 用于快速识别"同步调用栈嵌套"(withTransaction 在另一个 withTransaction
     * 的 fn 同步段内被调用 → 立即抛错)。
     *
     * 注意:该标记只覆盖 fn 的同步前缀(异步函数执行到首个 await 前)。
     * `await` 之后的嵌套调用无法由此检测,交给 `_txTail` 队列的超时兜底
     * (见 withTransaction:等待队列超时抛错,防止死锁)。
     * @type {boolean}
     * @protected
     */
    _txInFn = false;

    /**
     * withTransaction 等待前序事务的最大时长(ms)。
     *
     * 正常并发排队:前序事务完成后 `prev` resolve,等待时长 = 前序事务实际
     * 执行时间(毫秒级),远小于此超时,不会误触发。
     * 嵌套死锁:外层事务 fn 内 await 后再次调用 withTransaction → 内层入队
     * 等待,而外层要等内层返回才释放队列 → `prev` 永不 resolve → 超时抛错,
     * 防止永久挂起(旧实现直接抛"不支持嵌套事务",业务可 catch 降级)。
     * @type {number}
     * @protected
     */
    _txWaitTimeoutMs = 30000;

    constructor() {
        if (new.target === EngineAdapter) {
            throw new TypeError(
                'EngineAdapter is abstract — instantiate a subclass'
            );
        }
    }

    // ── Optional overrides ──────────────────────────────────────────

    /**
     * Engine type identifier for runtime engine detection.
     *
     * Subclasses override this to return their engine name
     * (e.g. 'sqlite', 'mysql', 'postgresql'). Used by the migration
     * runner's `getDatabaseEngine()` without importing adapter classes —
     * the migration runner reads `adapter.engineType` off the singleton
     * instead of re-reading `VRCXStorage`, so engine detection stays in
     * sync with whichever adapter `initAdapter(mode)` actually
     * constructed.
     *
     * Default `'unknown'` ensures that a base-class-only instance (which
     * cannot exist in production — `EngineAdapter` is abstract) or an
     * adapter that forgot the override surfaces loudly in migration
     * compatibility checks rather than silently masquerading as sqlite.
     *
     * @type {string}
     */
    get engineType() {
        return 'unknown';
    }

    /**
     * Normalize parameter objects for the dialect's binding style.
     *
     * SQLite uses named `@param` keys; PG uses positional `$N`; MySQL uses `?`.
     * Override in subclasses to transform `{ key: val }` into the dialect's
     * required form. Default identity pass-through.
     *
     * @optional
     * @param {object|Array|null} _args - raw parameter object from caller
     * @returns {object|Array|null} dialect-adjusted parameter object
     * @protected
     */
    _normalizeArgs(_args) {
        return _args;
    }

    /**
     * Execute an async function with a temporary prefix override
     * for userTable(). Nested calls are supported.
     *
     * @optional
     * @param {string} _prefix - user table prefix to apply within fn
     * @param {() => Promise<T>} _fn - async callback to run under the override
     * @returns {Promise<T>}
     * @template T
     */
    async withPrefix(_prefix, _fn) {
        const prev = this._prefixOverride;
        this._prefixOverride = _prefix;
        try {
            return await _fn();
        } finally {
            this._prefixOverride = prev;
        }
    }

    // ── Raw execution ────────────────────────────────────────────────

    /**
     * Execute raw SQL with a per-row callback.
     *
     * @abstract
     * @param {(row: Array) => void} _callback - called once per result row (positional array)
     * @param {string} _sql - SQL statement (SELECT / PRAGMA)
     * @param {object|Array|null} [_args] - named or positional parameters
     * @returns {Promise<void>}
     */
    execute(_callback, _sql, _args) {
        throw new Error('abstract');
    }

    /**
     * Execute raw SQL without row callback (INSERT/UPDATE/DELETE/DDL).
     *
     * @abstract
     * @param {string} _sql - SQL statement
     * @param {object|Array|null} [_args] - named or positional parameters
     * @returns {Promise<number>} rows affected
     */
    executeNonQuery(_sql, _args) {
        throw new Error('abstract');
    }

    // ── CRUD ─────────────────────────────────────────────────────────

    /**
     * Single-row INSERT with optional conflict handling.
     *
     * @abstract
     * @engine-specific — SQLite: `INSERT OR IGNORE`/`INSERT OR REPLACE`; PostgreSQL: `ON CONFLICT DO NOTHING`/`ON CONFLICT DO UPDATE`; MySQL: `INSERT IGNORE`/`REPLACE INTO`
     * @param {string} _table - target table name (with prefix if applicable)
     * @param {object} _data - column:value mapping
     * @param {string} [_conflict] - 'ignore' → INSERT OR IGNORE, 'replace' → INSERT OR REPLACE
     * @returns {Promise<number>} rows affected
     */
    insert(_table, _data, _conflict) {
        throw new Error('abstract');
    }

    /**
     * Bulk multi-row INSERT with optional conflict handling.
     *
     * @abstract
     * @engine-specific — SQLite: `INSERT OR IGNORE`/`INSERT OR REPLACE`; PostgreSQL: `ON CONFLICT DO NOTHING`/`ON CONFLICT DO UPDATE`; MySQL: `INSERT IGNORE`/`REPLACE INTO`
     * @param {string} _table - target table name
     * @param {object[]} _rows - array of column:value objects (all must share the same keys)
     * @param {string} [_conflict] - 'ignore' | 'replace'
     * @returns {Promise<number>} rows affected
     */
    bulkInsert(_table, _rows, _conflict) {
        throw new Error('abstract');
    }

    /**
     * UPDATE with equality conditions.
     *
     * @abstract
     * @param {string} _table - target table name
     * @param {object} _data - columns to SET (key:value)
     * @param {object} _where - equality conditions (key:value → col = @key)
     * @returns {Promise<number>} rows affected
     */
    update(_table, _data, _where) {
        throw new Error('abstract');
    }

    /**
     * UPDATE with raw WHERE clause (non-equality conditions).
     *
     * @abstract
     * @param {string} _table - target table name
     * @param {object} _data - columns to SET (key:value)
     * @param {string} _whereClause - raw WHERE content (without the WHERE keyword)
     * @param {object} [_params] - named parameters for the WHERE clause
     * @returns {Promise<number>} rows affected
     */
    updateWhere(_table, _data, _whereClause, _params) {
        throw new Error('abstract');
    }

    /**
     * DELETE with equality conditions.
     *
     * @abstract
     * @param {string} _table - target table name
     * @param {object} _where - equality conditions (key:value)
     * @returns {Promise<number>} rows affected
     */
    delete(_table, _where) {
        throw new Error('abstract');
    }

    /**
     * DELETE all rows from a table.
     *
     * @abstract
     * @param {string} _table - target table name
     * @returns {Promise<number>} rows affected
     */
    deleteAll(_table) {
        throw new Error('abstract');
    }

    /**
     * DELETE with raw WHERE clause (non-equality conditions).
     *
     * @abstract
     * @param {string} _table - target table name
     * @param {string} _whereClause - raw WHERE content (without the WHERE keyword)
     * @param {object} [_params] - named parameters for the WHERE clause
     * @returns {Promise<number>} rows affected
     */
    deleteWhere(_table, _whereClause, _params) {
        throw new Error('abstract');
    }

    /**
     * Increment a numeric column by a given amount with equality conditions.
     *
     * @abstract
     * @param {string} _table - target table name
     * @param {string} _column - column to increment
     * @param {number} _amount - increment amount
     * @param {object} _where - equality conditions (key:value)
     * @returns {Promise<number>} rows affected
     */
    increment(_table, _column, _amount, _where) {
        throw new Error('abstract');
    }

    /**
     * UPSERT: insert if not exists, update on conflict.
     *
     * @abstract
     * @engine-specific — SQLite/PostgreSQL: `ON CONFLICT(col) DO UPDATE SET ...`; MySQL: `ON DUPLICATE KEY UPDATE ...`
     * @param {string} _table - target table name
     * @param {object} _insertData - columns to insert (key:value)
     * @param {object} _updateData - columns to update on conflict (key:value)
     * @param {string} _conflictColumn - column name that triggers conflict
     * @returns {Promise<number>} rows affected
     */
    upsertPartial(_table, _insertData, _updateData, _conflictColumn) {
        throw new Error('abstract');
    }

    // ── SELECT ───────────────────────────────────────────────────────

    /**
     * SELECT a single row with equality conditions.
     *
     * @abstract
     * @param {string} _table - source table name
     * @param {string[]} _columns - column names to select
     * @param {object} _where - equality conditions (key:value)
     * @returns {Promise<Array|null>} single row as positional array, or null
     */
    selectOne(_table, _columns, _where) {
        throw new Error('abstract');
    }

    /**
     * SELECT rows with equality conditions. Omit `where` to select all rows.
     *
     * @abstract
     * @param {string} _table - source table name
     * @param {string[]} _columns - column names to select
     * @param {object} [_where] - equality conditions (key:value); omit for all rows
     * @param {object} [_options] - { order?, limit?, distinct? }
     * @returns {Promise<Array<Array>>} rows as positional arrays
     */
    select(_table, _columns, _where, _options) {
        throw new Error('abstract');
    }

    /**
     * SELECT rows with raw WHERE clause (non-equality conditions).
     *
     * @abstract
     * @param {string} _table - source table name
     * @param {string[]} _columns - column names to select
     * @param {string} [_whereClause] - raw WHERE content (without the WHERE keyword); omit/null to skip WHERE
     * @param {object} [_params] - named parameters for the WHERE clause
     * @param {object} [_options] - { order?, limit?, distinct? }
     * @returns {Promise<Array<Array>>} rows as positional arrays
     */
    selectWhere(_table, _columns, _whereClause, _params, _options) {
        throw new Error('abstract');
    }

    /**
     * SELECT with JOIN(s), raw WHERE, ORDER BY, LIMIT.
     *
     * @abstract
     * @param {object} _spec - { from, alias?, joins?, columns, where?, params?, order?, limit? }
     *   joins: [{ type, table, alias?, on }]
     * @returns {Promise<Array<Array>>} rows as positional arrays
     */
    selectJoin(_spec) {
        throw new Error('abstract');
    }

    /**
     * SELECT rows WHERE column IN (values), with optional extra conditions.
     *
     * @abstract
     * @param {string} _table - source table name
     * @param {string[]} _columns - column names to select
     * @param {string} _inColumn - column name for IN clause
     * @param {Array} _inValues - values for IN clause
     * @param {string} [_extraWhere] - additional raw WHERE content (AND'd with IN)
     * @param {object} [_extraParams] - named parameters for extra WHERE
     * @param {object} [_options] - { order?, limit? }
     * @returns {Promise<Array<Array>>} rows as positional arrays
     */
    selectWhereIn(
        _table,
        _columns,
        _inColumn,
        _inValues,
        _extraWhere,
        _extraParams,
        _options
    ) {
        throw new Error('abstract');
    }

    /**
     * UNION ALL across multiple sources with optional outer ORDER BY + LIMIT.
     *
     * @abstract
     * @param {object[]} _sources - each: { table, columns?, nulls?, where?, params?, order?, limit? }
     * @param {object} [_options] - { schema?, order?, limit? }
     * @returns {Promise<Array<Array>>} rows as positional arrays
     */
    selectUnion(_sources, _options) {
        throw new Error('abstract');
    }

    /**
     * SELECT with GROUP BY and aggregate expressions.
     *
     * @abstract
     * @param {string} _table - source table name
     * @param {object} _spec - { columns?, aggregates?, groupBy?, where?, params?, order?, limit?, having? }
     *   aggregates: [{ expr: 'COUNT(*)', alias: 'cnt' }]
     * @returns {Promise<Array<Array>>} rows as positional arrays
     */
    selectGroupBy(_table, _spec) {
        throw new Error('abstract');
    }

    // ── COUNT ────────────────────────────────────────────────────────

    /**
     * COUNT rows with equality conditions.
     *
     * @abstract
     * @param {string} _table - source table name
     * @param {object} _where - equality conditions (key:value)
     * @returns {Promise<number>} row count
     */
    count(_table, _where) {
        throw new Error('abstract');
    }

    /**
     * COUNT rows with raw WHERE clause.
     *
     * @abstract
     * @param {string} _table - source table name
     * @param {string} [_whereClause] - raw WHERE content (without the WHERE keyword); omit/null to COUNT all rows
     * @param {object} [_params] - named parameters for the WHERE clause
     * @returns {Promise<number>} row count
     */
    countWhere(_table, _whereClause, _params) {
        throw new Error('abstract');
    }

    // ── DDL ──────────────────────────────────────────────────────────

    /**
     * CREATE TABLE IF NOT EXISTS.
     *
     * @abstract
     * @param {string} _tableName - table name to create
     * @param {object[]} _columns - [{ name, type, constraints? }] or raw string for simple defs
     * @returns {Promise<number>} rows affected (0 for DDL)
     */
    createTable(_tableName, _columns) {
        throw new Error('abstract');
    }

    /**
     * CREATE INDEX IF NOT EXISTS.
     *
     * @abstract
     * @param {string} _indexName - index name
     * @param {string} _table - target table name
     * @param {string[]|string} _columns - column(s) to index
     * @param {boolean} [_unique] - create UNIQUE index
     * @returns {Promise<number>} rows affected (0 for DDL)
     */
    createIndex(_indexName, _table, _columns, _unique) {
        throw new Error('abstract');
    }

    /**
     * ALTER TABLE ADD COLUMN.
     *
     * @abstract
     * @param {string} _table - target table name
     * @param {string} _columnDef - full column definition (e.g. 'name TEXT NOT NULL DEFAULT ""')
     * @returns {Promise<number>} rows affected (0 for DDL)
     */
    alterTableAddColumn(_table, _columnDef) {
        throw new Error('abstract');
    }

    /**
     * ALTER TABLE DROP COLUMN.
     *
     * @abstract
     * @param {string} _table - target table name
     * @param {string} _column - column name to drop
     * @returns {Promise<number>} rows affected (0 for DDL)
     */
    alterTableDropColumn(_table, _column) {
        throw new Error('abstract');
    }

    /**
     * ALTER TABLE RENAME TO.
     *
     * @abstract
     * @param {string} _table - current table name
     * @param {string} _newName - new table name
     * @returns {Promise<number>} rows affected (0 for DDL)
     */
    alterTableRename(_table, _newName) {
        throw new Error('abstract');
    }

    /**
     * DROP TABLE IF EXISTS.
     *
     * @abstract
     * @param {string} _table - table name to drop
     * @returns {Promise<number>} rows affected (0 for DDL)
     */
    dropTable(_table) {
        throw new Error('abstract');
    }

    // ── Transaction ──────────────────────────────────────────────────

    /**
     * 引擎级事务开启钩子。子类实现:
     * - PgSQLAdapter:调 C# `PostgreSQL.BeginTransaction()` 返回真实 connId
     * - SQLiteAdapter/MySQLAdapter:发 `BEGIN` SQL,返回 0(单连接无需 pin)
     *
     * @abstract
     * @returns {Promise<number>} connId(0 表示单连接引擎无需 pin)
     * @protected
     */
    _doBegin() {
        throw new Error('abstract');
    }

    /**
     * 引擎级事务提交钩子。子类实现:
     * - PgSQLAdapter:调 C# `PostgreSQL.CommitTransaction(connId)`
     * - SQLiteAdapter/MySQLAdapter:发 `COMMIT` SQL(connId 忽略)
     *
     * @abstract
     * @param {number} _connId
     * @returns {Promise<void>}
     * @protected
     */
    _doCommit(_connId) {
        throw new Error('abstract');
    }

    /**
     * 引擎级事务回滚钩子。子类实现:
     * - PgSQLAdapter:调 C# `PostgreSQL.RollbackTransaction(connId)`
     * - SQLiteAdapter/MySQLAdapter:发 `ROLLBACK` SQL(connId 忽略)
     *
     * @abstract
     * @param {number} _connId
     * @returns {Promise<void>}
     * @protected
     */
    _doRollback(_connId) {
        throw new Error('abstract');
    }

    /**
     * 引擎级事务心跳钩子。子类实现:
     * - PgSQLAdapter:调 C# `PostgreSQL.KeepAliveTransaction(connId)`
     * - SQLiteAdapter/MySQLAdapter:同上,调对应 C# 方法
     * - MemorySQLiteAdapter:返回 true(无 C# Timer,事务永不过期)
     *
     * 返回 `true` 表示 timer 已重置(续命成功);`false` 表示 connId
     * 已超时回滚(C# 侧 TryGetValue 失败)。调用方可在 await 用户
     * 交互后通过返回值判断事务是否仍然存活,决定是否提前退出。
     *
     * @abstract
     * @param {number} _connId
     * @returns {Promise<boolean>} true=续命成功,false=已超时回滚
     * @protected
     */
    _doKeepAlive(_connId) {
        throw new Error('abstract');
    }

    /**
     * 开启一个事务,返回 connId 并 push 到 `_txStack`。
     * execute/executeNonQuery 读栈顶决定走 pinned 连接还是默认池。
     * 必须配对调用 commit(connId) 或 rollback(connId) 以 pop 栈。
     *
     * 不支持嵌套:栈非空时抛错(与 SQLite 现有 nested begin throws 一致)。
     * 生产代码请使用 withTransaction(fn) 自动管理栈,而非手动调用
     * 本方法——手动调用仅在测试中用于验证栈契约。
     *
     * @private
     * @returns {Promise<number>} connId
     */
    async beginTransaction() {
        if (this._txStack.length > 0) {
            throw new Error('beginTransaction: 不支持嵌套事务(当前已在事务中)');
        }
        const connId = await this._doBegin();
        this._txStack.push(connId);
        return connId;
    }

    /**
     * 提交当前事务并 pop `_txStack`。
     *
     * 仅由 withTransaction(fn) 内部调用;手动调用仅在测试中用于验证
     * 栈契约。生产代码请使用 withTransaction(fn)。
     *
     * @private
     * @param {number} connId - beginTransaction 返回的 connId
     * @returns {Promise<void>}
     */
    async commit(connId) {
        try {
            await this._doCommit(connId);
        } finally {
            this._txStack.pop();
        }
    }

    /**
     * 回滚当前事务并 pop `_txStack`。已超时/不存在的 connId 静默
     * no-op,不抛错(withTransaction 的 catch 可无条件调用)。
     *
     * 仅由 withTransaction(fn) 内部调用;手动调用仅在测试中用于验证
     * 栈契约。生产代码请使用 withTransaction(fn)。
     *
     * @private
     * @param {number} connId - beginTransaction 返回的 connId
     * @returns {Promise<void>}
     */
    async rollback(connId) {
        try {
            await this._doRollback(connId);
        } finally {
            this._txStack.pop();
        }
    }

    /**
     * 重置当前事务的 sliding idle timer,不执行任何 SQL。
     *
     * 用于 withTransaction 体内 await 长时间非 DB 操作(如用户确认
     * 对话框、输入框等待)时,防止 60s idle 超时自动回滚。调用后
     * Timer 重新从 TX_IDLE_MS 开始计时。
     *
     * @returns {Promise<boolean>} `true` 表示续命成功(事务仍存活,
     *   timer 已重置);`false` 表示事务已超时回滚或当前不在事务中
     *   (调用方应提前退出事务体,避免后续 SQL 抛 "connId 已超时
     *   回滚" 的延迟错误)。注意:即使返回 `false`,withTransaction
     *   的 catch 仍会在后续 SQL 调用失败时 rollback + 重新抛出,
     *   keepAlive 返回 `false` 只是让调用方有机会提前干净退出。
     *
     * 推荐用法 — 在每段可能超过 60s 的非 DB await 前调用,
     * 并检查返回值:
     * ```
     * await adapter.withTransaction(async () => {
     *     await adapter.insert(...);
     *     if (!await adapter.keepAlive()) return; // 事务已死,提前退出
     *     const ok = await dialog.confirm(...);    // 用户慢慢想
     *     if (!ok) throw new Error('用户取消');
     *     if (!await adapter.keepAlive()) return; // 事务已死,提前退出
     *     await adapter.update(...);
     * });
     * ```
     *
     * ⚠️ 注意:keepAlive 是逃生舱,不是鼓励在事务内做长交互。
     * 事务应尽可能短——长时间持有事务锁会阻塞其他操作。能拆到
     * 事务外确认的,优先拆出去(乐观锁模式)。
     */
    async keepAlive() {
        const connId = this._txStack.at(-1);
        if (connId === undefined) return false;
        try {
            return await this._doKeepAlive(connId);
        } catch {
            // C# 桥异常或 binding 缺失,视为事务已死
            return false;
        }
    }

    /**
     * 在事务中执行 `fn`。自动管理 connId 的获取/提交/回滚 + `_txStack`
     * 的 push/pop。业务代码在 `fn` 内部调用的 execute/insert/bulkInsert
     * 等方法会自动走 pinned 连接(读栈顶 connId),无需显式传 connId。
     *
     * - 成功:commit + pop 栈
     * - 抛错:rollback + pop 栈 + 重新抛出
     * - 真正的调用栈嵌套(在另一个 withTransaction 的 fn 同步段内再次
     *   调用)→ 抛错(不支持嵌套事务)
     * - 并发调用(不同异步流在时间上交错)→ 串行排队等待,不抛错
     *
     * ⚠️ 事务内禁止 await 用户交互(对话框、输入框等)。C# 侧有
     * 60 秒 idle 超时自动回滚,用户不在电脑前会导致事务被静默
     * 回滚,后续 SQL 抛 "connId 已超时回滚" 错误。如必须在事务
     * 内等待用户,需在每段可能超时的 await 前调用 `keepAlive()`
     * 续命;但更推荐将用户交互拆到事务外(乐观锁模式):
     * ```
     * // ✅ 推荐:事务外确认
     * const data = await adapter.select(...);
     * const ok = await dialog.confirm(data);
     * if (!ok) return;
     * await adapter.withTransaction(async () => {
     *     await adapter.update(...);
     * });
     * ```
     *
     * @optional
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withTransaction(fn) {
        // 快速失败:同步调用栈嵌套(在另一个事务 fn 的同步段内再次调用)。
        // 并发异步流的交错不会经过这里——它们在 `_txInFn` 复位后进入。
        if (this._txInFn) {
            throw new Error('withTransaction: 不支持嵌套事务(当前已在事务中)');
        }
        // 串行化:append 到队列尾,前面的 withTransaction 完成后再执行。
        // 并发场景(独立异步流交错):B 在此排队等待 A 提交后释放,然后安全执行。
        const prev = this._txTail;
        let release;
        this._txTail = new Promise((resolve) => {
            release = resolve;
        });
        // 整个等待 + 事务执行包进 try/finally,保证 release() 在任意路径
        // (正常提交、事务抛错、等待超时)都被调用,推进队列尾。
        try {
            // await 前序事务,带超时兜底防死锁:
            // - 正常并发:prev 在 A 提交后 resolve,不等超时
            // - await 后嵌套:外层要等内层返回才 release → prev 永不 resolve
            //   → 超时抛错,避免永久挂起(旧实现在此抛"不支持嵌套事务")
            await Promise.race([
                prev,
                new Promise((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'withTransaction: 等待前序事务超时(疑似嵌套事务死锁)'
                                )
                            ),
                        this._txWaitTimeoutMs
                    )
                )
            ]);
            const connId = await this.beginTransaction();
            try {
                // 只在 fn 的同步前缀期间标记嵌套:异步函数 `fn()` 会同步执行
                // 到首个 await 后立即返回 Promise。同步调用栈嵌套(在另一个
                // withTransaction 的 fn 同步段内再次调用)发生在该前缀内 →
                // 被入口处 `_txInFn` 检查立即捕获。fn 挂起后 `_txInFn` 复位,
                // 并发调用在此时进入不会误判;await 后的嵌套交给 `await prev`
                // 的超时兜底(见上),既防死锁又不错杀并发。
                let resultPromise;
                this._txInFn = true;
                try {
                    resultPromise = fn();
                } finally {
                    this._txInFn = false;
                }
                const result = await resultPromise;
                await this.commit(connId);
                return result;
            } catch (err) {
                try {
                    await this.rollback(connId);
                } catch (rollbackErr) {
                    // 不掩盖原始业务错误,但记录 rollback 失败供诊断
                    // (连接断、SQLite 损坏等,否则完全无日志)
                    console.error(
                        '[adapter] withTransaction rollback 失败:',
                        rollbackErr
                    );
                }
                throw err;
            }
        } finally {
            release();
        }
    }

    // ── Maintenance ──────────────────────────────────────────────────

    /**
     * VACUUM — reclaim storage.
     *
     * @abstract
     * @engine-specific — SQLite: VACUUM; PostgreSQL: VACUUM ANALYZE; MySQL: OPTIMIZE TABLE
     * @returns {Promise<number>} rows affected (0 for maintenance)
     */
    vacuum() {
        throw new Error('abstract');
    }

    /**
     * PRAGMA optimize / ANALYZE — maintenance hint.
     *
     * @abstract
     * @engine-specific — SQLite: PRAGMA optimize; PostgreSQL: ANALYZE; MySQL: ANALYZE TABLE
     * @returns {Promise<number>} rows affected (0 for maintenance)
     */
    optimize() {
        throw new Error('abstract');
    }

    // ── Schema ───────────────────────────────────────────────────────

    /**
     * Initialize user-prefixed schema (tables for a specific account).
     *
     * @abstract
     * @param {string} _prefix - user table prefix (account hash)
     * @returns {Promise<void>}
     */
    initUserSchema(_prefix) {
        throw new Error('abstract');
    }

    /**
     * Initialize global schema (shared tables across all accounts).
     *
     * @abstract
     * @returns {Promise<void>}
     */
    initGlobalSchema() {
        throw new Error('abstract');
    }

    // ── Metadata ─────────────────────────────────────────────────────

    /**
     * List user tables matching a LIKE pattern.
     *
     * @abstract
     * @engine-specific — SQLite: sqlite_schema; MySQL: SHOW TABLES LIKE; PostgreSQL: pg_catalog.pg_tables
     * @param {string} _likePattern - SQL LIKE pattern for filtering table names
     * @returns {Promise<Array<string>>} table names
     */
    listTables(_likePattern) {
        throw new Error('abstract');
    }

    /**
     * Get column metadata for a table.
     *
     * @abstract
     * @engine-specific — SQLite: PRAGMA table_xinfo; MySQL: SHOW COLUMNS FROM; PostgreSQL: information_schema.columns
     * @param {string} _table - table name
     * @returns {Promise<Array<Array>>} rows as positional arrays (dialect-specific column metadata)
     */
    getTableColumns(_table) {
        throw new Error('abstract');
    }

    /**
     * Enumerate all user tables with their column metadata.
     *
     * Combines table enumeration with per-table column metadata.
     * Returns structured objects instead of positional arrays.
     *
     * @abstract
     * @returns {Promise<Array<{tableName: string, columns: Array<{name: string, type: string, notNull: boolean, defaultValue: *, isPK: boolean, isHidden: boolean}>}>>}
     */
    listTablesTypes() {
        throw new Error('abstract');
    }

    // ── Naming ───────────────────────────────────────────────────────

    /**
     * Resolve a user table name with prefix applied.
     *
     * @abstract
     * @engine-specific — SQLite/MySQL: `{prefix}_{name}`; PostgreSQL: `account_{prefix}.{name}` (schema isolation)
     * @param {string} _prefix - user table prefix (account hash)
     * @param {string} _name - base table name
     * @returns {string} fully-qualified table name
     */
    userTable(_prefix, _name) {
        throw new Error('abstract');
    }

    // ── SQL fragments (engine-specific syntax) ───────────────────────

    /**
     * SQL expression: convert ISO datetime column to Unix milliseconds.
     *
     * @abstract
     * @engine-specific — SQLite: `strftime('%s', col) * 1000`; PostgreSQL: `EXTRACT(EPOCH FROM col) * 1000`; MySQL: `UNIX_TIMESTAMP(col) * 1000`
     * @param {string} _column - column name containing ISO datetime
     * @returns {string} SQL expression
     */
    sqlToUnixMs(_column) {
        throw new Error('abstract');
    }

    /**
     * SQL expression: extract world ID from a location string (e.g. "wrld_xxx:12345" → "wrld_xxx").
     *
     * @abstract
     * @engine-specific — SQLite: `SUBSTR(col, 1, INSTR(col, ':') - 1)`; PostgreSQL: `SUBSTRING(col FROM 1 FOR POSITION(':' IN col) - 1)`; MySQL: `SUBSTRING_INDEX(col, ':', 1)`
     * @param {string} _column - column name containing full location string
     * @returns {string} SQL expression
     */
    sqlExtractWorldId(_column) {
        throw new Error('abstract');
    }

    /**
     * SQL expression: check if a location string has an instance ID (contains ':').
     *
     * @abstract
     * @engine-specific — SQLite: `INSTR(col, ':') > 0`; PostgreSQL: `POSITION(':' IN col) > 0`; MySQL: `LOCATE(':', col) > 0`
     * @param {string} _column - column name containing location
     * @returns {string} SQL expression (boolean)
     */
    sqlHasInstanceId(_column) {
        throw new Error('abstract');
    }

    /**
     * SQL expression: extract date part from an ISO datetime column.
     *
     * @abstract
     * @engine-specific — SQLite: `date(col)`; PostgreSQL: `col::date`; MySQL: `DATE(col)`
     * @param {string} _column - column name containing ISO datetime
     * @returns {string} SQL expression
     */
    sqlDate(_column) {
        throw new Error('abstract');
    }

    /**
     * SQL expression: compute the "enter time" from a leave event record.
     *
     * gamelog_join_leave records only leave events (created_at = leave time, time = duration).
     * Enter time = leave time - duration. This fragment produces a SQL expression
     * that computes the enter timestamp for BETWEEN comparisons.
     *
     * @abstract
     * @engine-specific — SQLite: `strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '-' || (time * 1.0 / 1000) || ' seconds')`; PostgreSQL: `created_at - (time / 1000) * INTERVAL '1 second'`; MySQL: `created_at - INTERVAL (time / 1000) SECOND`
     * @param {string} _tsColumn - timestamp column name (e.g. 'created_at')
     * @param {string} _msColumn - duration-in-milliseconds column name (e.g. 'time')
     * @returns {string} SQL expression producing an ISO timestamp
     */
    sqlEnterTime(_tsColumn, _msColumn) {
        throw new Error('abstract');
    }

    // ── JS utilities ─────────────────────────────────────────────────

    /**
     * Connection pool three-state metrics snapshot.
     *
     * Calls the C# bridge's `GetPoolStats()` (SQLite / PostgreSQL / MySQL)
     * and returns the parsed JSON:
     * `{ active, pinnedIdle, availableCapacity, max, totalOpen, idleInPool }`.
     * Pure in-memory counter read on the C# side, no network call. Sampled
     * once per second by the StatusBar database monitor (Issue #14).
     *
     * 基础字段(所有引擎对称,UI 主用):
     *   - `active`: connections currently executing SQL (pinned + non-pinned).
     *   - `pinnedIdle`: connections held by an open transaction but not
     *     currently executing SQL (`_pinned.Count - _pinnedActive`).
     *   - `availableCapacity`: `_maxPoolSize - _totalBorrowed` — the number
     *     of connections that can still be borrowed without growing the pool.
     *     This is the closest available proxy for "pool health" since the
     *     driver public APIs do not expose the real idle-in-pool count; it
     *     conflates idle connections sitting in the pool with unused quota.
     *     A high value = healthy/cool; a low value = pressure.
     *   - `max`: pool size cap (`_maxPoolSize`).
     *
     * 扩展字段(冗余校验,驱动版本变化可能失效,UI 不强依赖):
     *   - `totalOpen`: total live physical connections in the pool
     *     (PG: reflected `PoolingDataSource.Statistics.Total` 真值;
     *      MySQL: reflected `ConnectionPool.m_sessions` + `m_sessionSemaphore` 真值;
     *      SQLite: peak-borrowed 近似 = 并发借出历史峰值)
     *   - `idleInPool`: live-but-idle physical connections in the pool
     *     (PG: reflected `Statistics.Idle` 真值;
     *      MySQL: reflected `m_sessions.Count` 真值;
     *      SQLite: `peak - 当前借出` 近似)
     *
     * 上层 JS 主用基础字段自算 idleInPool = totalOpen - active - pinnedIdle,
     * 扩展字段仅供诊断/校验。驱动公开 API 不暴露物理连接生命周期事件:
     * PG/MySQL 用反射读驱动内部计数(真值),SQLite 无池统计 API 且池中
     * 空闲连接弱引用保存(GC 回收不可见),故用 peak-borrowed 上界近似。
     * 反射失败/字段改名时 PG/MySQL 静默回退旧估算(下界、偏高)。
     *
     * @abstract
     * @returns {Promise<{ active: number, pinnedIdle: number, availableCapacity: number, max: number, totalOpen: number, idleInPool: number }>}
     */
    async getPoolStats() {
        throw new Error('abstract');
    }

    /**
     * Clear idle connections from the pool. Calls the C# bridge's
     * `ClearIdleConnections()` (SQLite / PostgreSQL / MySQL). Only
     * affects pool-idle connections; active and pinned connections
     * continue to work normally.
     *
     * @abstract
     * @returns {Promise<void>}
     */
    async clearIdleConnections() {
        throw new Error('abstract');
    }

    /**
     * Async liveness probe. Resolves true when the C# backend is
     * initialised and the server is reachable (Ping succeeds). On
     * CefSharp the bridge is synchronous; on Electron the bridge returns
     * a Promise — see the dual-runtime note below. Declared `async` so
     * `await` works uniformly across both runtimes; calling sites MUST
     * `await` the result (awaiting a plain boolean returns it
     * immediately on CefSharp).
     *
     * @abstract
     * @returns {Promise<boolean>}
     */
    async isConnected() {
        throw new Error('abstract');
    }

    /**
     * Async health probe. Returns a JSON snapshot from the C# bridge:
     * `{ connected, latencyMs, lastHealthCheck }`.
     *
     * @abstract
     * @returns {Promise<{ connected: boolean, latencyMs?: number, lastHealthCheck?: string|null }>}
     */
    async getHealth() {
        throw new Error('abstract');
    }

    // ── Health / pool probes ────────────────────────────────────────
    //
    // The following methods (isConnected / getHealth / getPoolStats) call
    // C# bridge methods that are synchronous on the C# side but are
    // declared async here because of the dual-runtime bridge:
    //
    //   - CefSharp (Windows): binds C# methods directly → returns plain
    //     synchronous values (string / boolean).
    //   - Electron (Linux): wraps ALL C# calls in a Promise via the
    //     InteropApi Proxy (src/ipc-electron/interopApi.js:16), which does
    //     `async (...args) => await target.callMethod(...)`.
    //
    // `await` works uniformly across both runtimes: awaiting a plain
    // value returns it immediately; awaiting a Promise waits for
    // resolution.  All callers MUST `await` these methods — calling them
    // synchronously would get a Promise on Electron but a raw value on
    // CefSharp, producing platform-dependent bugs.  `isConnected` is
    // async for the same reason: `Boolean(Ping())` would be
    // `Boolean(Promise)` (always true) on Electron.
    //
    // globals.d.ts types these as `Promise<>` to match the widest
    // runtime (Electron IPC).  See also:
    //   - src/ipc-electron/interopApi.js (Electron bridge Proxy)
    //   - src/types/globals.d.ts (type declarations)

    /**
     * Compute ISO date string for N days ago.
     *
     * @optional
     * @param {number} _days - number of days ago
     * @returns {string} ISO 8601 datetime string
     */
    daysAgoISO(_days) {
        return new Date(Date.now() - _days * 86400000).toISOString();
    }

    // ── Change notification: onTableChange ───────────────────────────
    //
    // 数据库变更通知(详见 docs/architecture/ADAPTER_API.md §9):
    //   - 实时层:C# 写漏斗事件,负载携带发射时的计数器快照(dv),
    //     经 _syncChangeBaseline() 推进基线;
    //   - 完备层:引擎原生计数器轮询(_readChangeCounter),
    //     仅在"版本前进且无对应漏斗事件"时触发全部订阅表失效重查——
    //     自写被基线同步吸收,完备层精确等价"外部写者检测器"。
    // 订阅按实例作用域(实例 = 连接):默认单例与 connectionString 实例
    // 天然隔离,多账号订阅互不串扰。轮询为订阅驱动:无订阅者 → 零轮询。

    /** 完备层轮询间隔(ms)。兜底只服务完整性、不服务响应性——间隔越慢,分层职责越清晰。 */
    static CHANGE_POLL_MS = 5000;

    /** @type {Map<string, Set<(evt: object) => void>>} 物理表名 → 订阅回调集合(订阅方以 userTable(prefix, name) 计算) */
    _changeSubs = new Map();

    /** @type {ReturnType<typeof setInterval> | null} 共享轮询定时器(有订阅才运行) */
    _changeTimer = null;

    /** @type {number | null} 计数器基线:最近一次漏斗事件快照(dv)或轮询观察值 */
    _changeBaseline = null;

    /**
     * 订阅某张物理表的变更。
     *
     * 检测层 = C# 漏斗事件(实时)+ 计数器轮询兜底(完备),对消费方透明。
     * table 用物理表名(订阅方以 userTable(prefix, name) 计算,如 'abc_feed_gps');前缀随账号,同实例多账号订阅天然隔离。
     * 返回 unsubscribe,store 卸载时调用,与 Vue watch 停用同构。
     *
     * @optional
     * @param {string} table - 物理表名(以 userTable(prefix, name) 计算)
     * @param {(evt: { table: string, count: number, ts: number }) => void} cb -
     *        变更回调;count=-1 表示完备层兜底触发的全量失效提示
     * @returns {() => void} unsubscribe
     */
    onTableChange(table, cb) {
        if (typeof table !== 'string' || table.length === 0) {
            throw new TypeError(
                'onTableChange: table must be a non-empty string'
            );
        }
        if (typeof cb !== 'function') {
            throw new TypeError('onTableChange: cb must be a function');
        }
        let set = this._changeSubs.get(table);
        if (!set) {
            set = new Set();
            this._changeSubs.set(table, set);
            // 新表项(实例×表)首个订阅 → 全局计数 +1,0→1 时开启 C# 门控
            _changeSubscriberCount += 1;
            if (_changeSubscriberCount === 1) {
                _changeGateHook?.(true);
            }
        }
        set.add(cb);
        if (!this._changeTimer) {
            this._startChangeTimer();
        }
        return () => {
            // 重复退订幂等退出 — 同一 cb 引用被订阅两次时返回两个闭包,
            // 第二个闭包 Set 已无此 cb,直接返回避免重复递减全局计数。
            if (!set.has(cb)) return;
            set.delete(cb);
            if (set.size === 0) {
                this._changeSubs.delete(table);
                // 表项(实例×表)全部退订 → 全局计数 -1,归零时关闭 C# 门控
                _changeSubscriberCount -= 1;
                if (_changeSubscriberCount === 0) {
                    _changeGateHook?.(false);
                }
            }
            if (this._changeSubs.size === 0) {
                this._stopChangeTimer();
            }
        };
    }

    /** @private 启动完备层轮询(首个订阅者出现时;无订阅者 → 零轮询) */
    _startChangeTimer() {
        this._changeTimer = setInterval(() => {
            this._pollChangeCounter().catch((err) => {
                // 兜底轮询失败静默:完备层只是保险,失败等价于"本轮无外部写"。
                console.error('[onTableChange] fallback poll failed', err);
            });
        }, EngineAdapter.CHANGE_POLL_MS);
    }

    /** @private 停止轮询(最后一个订阅者退订时),并重置基线供下次重建 */
    _stopChangeTimer() {
        if (this._changeTimer) {
            clearInterval(this._changeTimer);
            this._changeTimer = null;
        }
        this._changeBaseline = null;
    }

    /**
     * 完备层轮询一拍:读引擎原生计数器;版本前进且无对应漏斗事件时
     * 触发全部订阅表失效重查(粒度缺陷:全局计数器不分表)。
     * 首轮只建立基线、不触发——订阅方通常自会做初始拉取。
     * @protected
     */
    async _pollChangeCounter() {
        const version = await this._readChangeCounter();
        if (version === null) return; // 引擎未实现计数器 → 完备层不运行
        if (this._changeBaseline === null) {
            this._changeBaseline = version;
            return;
        }
        if (version !== this._changeBaseline) {
            this._changeBaseline = version;
            this._fireAllTables();
        }
    }

    /**
     * 同步基线(漏斗事件调用):自写已被事件覆盖,版本前进无需
     * 兜底触发。version = 事件发射时的计数器快照(dv)。
     * @param {number | null} version
     * @protected
     */
    _syncChangeBaseline(version) {
        if (version !== null && version !== undefined) {
            this._changeBaseline = version;
        }
    }

    /**
     * 接收本实例的写漏斗事件(由 adapter 路由层按 conn 分发后调用)。
     *
     * - dv 存在 → 推进基线:自写已被事件覆盖,完备层不再兜底触发;
     * - table 命中订阅 → 实时触发该表回调(毫秒级,表级粒度);
     * - table 未知/无订阅 → 仅同步基线:非 watched 表写不打扰订阅方。
     *
     * 注意:table 为物理表名(订阅方以 userTable(prefix, name) 计算),
     * 前缀随账号,同实例多账号订阅天然隔离。
     *
     * 半公开接口:adapter 路由层(index.js wireFunnelEvents)按 conn
     * 分发后调用,消费方不应直接调用。
     *
     * @param {{ table?: string | null, count?: number, ts?: number, dv?: number | null }} evt
     */
    _onFunnelEvent(evt) {
        if (evt && evt.dv != null) {
            this._syncChangeBaseline(Number(evt.dv));
        }
        const table = evt?.table;
        const set =
            typeof table === 'string' ? this._changeSubs.get(table) : undefined;
        if (!set || set.size === 0) return;
        const payload = {
            table,
            count: typeof evt?.count === 'number' ? evt.count : -1,
            ts: typeof evt?.ts === 'number' ? evt.ts : Date.now()
        };
        for (const cb of [...set]) {
            try {
                cb(payload);
            } catch (err) {
                console.error(
                    `[onTableChange] subscriber error for ${table}`,
                    err
                );
            }
        }
    }

    /** @private 触发全部订阅表的回调(完备层兜底:全量失效提示,count=-1) */
    _fireAllTables() {
        const ts = Date.now();
        for (const [table, set] of this._changeSubs) {
            for (const cb of [...set]) {
                try {
                    cb({ table, count: -1, ts });
                } catch (err) {
                    // 订阅方异常不阻断其他订阅者与轮询循环
                    console.error(
                        `[onTableChange] subscriber error for ${table}`,
                        err
                    );
                }
            }
        }
    }

    /**
     * 读引擎原生计数器(完备层信号)。
     * 默认 null = 该引擎不启用计数器兜底(onTableChange 退化为纯 no-op)。
     * SQLite: PRAGMA data_version;PG: xact_commit;MySQL: performance_schema 聚合。
     * @protected
     * @returns {Promise<number | null>}
     */
    async _readChangeCounter() {
        return null;
    }
}

// ── 变更通知门控(C# SetChangeEnabled)────────────────────────────
// 跨实例订阅计数:任何实例的首个订阅开启 C# 写漏斗,最后一个退订关闭。
// 无消费者时 C# EmitChange 首行早退,写路径零成本。钩子由
// adapter/index.js 注入(按桥对象三引擎扇出);未注入(纯单测)静默跳过。
/** @type {number} */
let _changeSubscriberCount = 0;
/** @type {((enabled: boolean) => void) | null} */
let _changeGateHook = null;

/**
 * 注入/卸载 C# 门控钩子(index.js 模块加载时注入一次;注入即重置计数,
 * 保证测试可重复安装后计数从 0 开始)。
 * @param {((enabled: boolean) => void) | null} hook
 */
export function setChangeGateHook(hook) {
    _changeGateHook = hook;
    _changeSubscriberCount = 0;
}

export { EngineAdapter };
