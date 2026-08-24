import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MySQLAdapter } from './MySQLAdapter.js';

/**
 * MySQLAdapter pure unit tests (no MySQL container required).
 *
 * Mirrors `PgSQLAdapter.unit.test.js` for the subset of behaviour that
 * has no external dependency. Runs in the default vitest environment
 * (jsdom + `vitest.setup.js` noopAsync stubs).
 *
 * What's tested here (no MySQL backend required):
 *   - `_buildConnectionString` URI parsing (mysql://user:pass@host:port/db)
 *   - `engineType` getter
 *   - `isConnected` defensive stub behaviour + absent-binding guard
 *
 * What's NOT tested here (needs a real MySQL backend):
 *   - `execute` / `executeNonQuery` actually hitting MySqlConnector
 *   - `initUserSchema` / `initGlobalSchema` DDL round-trips
 *   - `isConnected` real `SELECT 1` round-trip (covered by
 *     `MySQLAdapter.mysql.test.js` when `MYSQL_TEST_HOST` is set)
 *
 * TODO: 事务单元测试覆盖空白。`beginTransaction`/`commit`/`rollback`
 *   (现已标 @private) 及 `withTransaction` 的 MySQL 引擎级语义
 *   (pooled 连接 + `BEGIN/COMMIT/ROLLBACK` SQL 往返、事务内读未
 *   commit 写)目前仅由 `transaction.test.js` 用 MemorySQLiteAdapter
 *   做引擎无关的栈契约验证。MySQL 特定的事务行为需真实 MySQL
 *   后端 + C# 桥,无法在纯 JS unit test 中覆盖,待 follow-up 补
 *   集成测试。
 */
describe('MySQLAdapter unit (no container)', () => {
    describe('engineType', () => {
        it('returns "mysql"', () => {
            const adapter = new MySQLAdapter();
            expect(adapter.engineType).toBe('mysql');
        });
    });

    describe('_buildConnectionString', () => {
        it('parses a full mysql:// URI with credentials', () => {
            const adapter = new MySQLAdapter({
                connection: 'mysql://root:pass@127.0.0.1:3306/vrcx_test'
            });
            expect(adapter.connectionString).toContain('Server=127.0.0.1');
            expect(adapter.connectionString).toContain('Port=3306');
            expect(adapter.connectionString).toContain('Database=vrcx_test');
            expect(adapter.connectionString).toContain('User ID=root');
            expect(adapter.connectionString).toContain('Password=pass');
        });

        it('parses a mysql:// URI without explicit port (defaults to 3306)', () => {
            const adapter = new MySQLAdapter({
                connection: 'mysql://root:pass@127.0.0.1/vrcx_test'
            });
            expect(adapter.connectionString).toContain('Server=127.0.0.1');
            expect(adapter.connectionString).toContain('Port=3306');
            expect(adapter.connectionString).toContain('Database=vrcx_test');
        });

        it('returns null connectionString when no connection arg provided', () => {
            const adapter = new MySQLAdapter();
            expect(adapter.connectionString).toBeNull();
        });
    });

    describe('isConnected', () => {
        it('resolves to a boolean and does not throw under the vitest noopAsync stub', async () => {
            // Under vitest.setup.js, MySQL is a Proxy returning noopAsync
            // for any property access, so MySQL.Ping is noopAsync
            // → returns Promise.resolve(''). `await` it → '' → Boolean('') === false.
            // The real C# binding returns a synchronous bool (CefSharp) or a
            // Promise<boolean> (Electron); either way `await` yields a boolean.
            const adapter = new MySQLAdapter();
            const result = await adapter.isConnected();
            expect(typeof result).toBe('boolean');
            await expect(adapter.isConnected()).resolves.toBeDefined();
        });

        it('resolves false when the MySQL binding is absent', async () => {
            const adapter = new MySQLAdapter();
            const saved = globalThis.MySQL;
            // @ts-expect-error — deliberately delete the global for this test
            delete globalThis.MySQL;
            try {
                await expect(adapter.isConnected()).resolves.toBe(false);
            } finally {
                globalThis.MySQL = saved;
            }
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug A: MySQL 保留字列名(key)转义
// MySQL 是唯一把 `KEY` 当保留字的引擎。DDL 已用反引号,但 SQL 构建器
// 此前裸拼列名 → `INSERT IGNORE INTO cookies (key, value)` 语法错误。
// 以下用例验证 11 个 SQL 构建器方法对 Object.keys 派生的列名做
// `quoteIdent` 转义,且 params 键保持裸名(永不转义)。
// ─────────────────────────────────────────────────────────────────────────

describe('SQL 构建器标识符转义', () => {
    /** @type {MySQLAdapter} */
    let adapter;

    beforeEach(() => {
        adapter = new MySQLAdapter();
        adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
        adapter.execute = vi.fn().mockImplementation(async (cb) => cb(['v']));
    });

    describe('quoteIdent', () => {
        it('包裹反引号', () => {
            expect(adapter.quoteIdent('key')).toBe('`key`');
        });

        it('内部反引号按 MySQL 规则转义为双反引号', () => {
            expect(adapter.quoteIdent('a`b')).toBe('`a``b`');
        });

        it('非字符串输入经 String() 转换', () => {
            expect(adapter.quoteIdent(42)).toBe('`42`');
        });
    });

    describe('insert', () => {
        it('列名转义为反引号,params 键保持裸名', async () => {
            await adapter.insert('cookies', { key: 'k', value: 'v' }, 'ignore');
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'INSERT IGNORE INTO cookies (`key`, `value`) VALUES (@key, @value)'
            );
            expect(adapter.executeNonQuery.mock.calls[0][1]).toEqual({
                key: 'k',
                value: 'v'
            });
        });
    });

    describe('bulkInsert', () => {
        it('列名转义,行参数键保持裸名(带行号后缀)', async () => {
            await adapter.bulkInsert(
                'cookies',
                [
                    { key: 'k1', value: 'v1' },
                    { key: 'k2', value: null }
                ],
                'ignore'
            );
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'INSERT IGNORE INTO cookies (`key`, `value`) VALUES (@key_0, @value_0), (@key_1, @value_1)'
            );
            expect(adapter.executeNonQuery.mock.calls[0][1]).toEqual({
                key_0: 'k1',
                value_0: 'v1',
                key_1: 'k2',
                value_1: null
            });
        });
    });

    describe('update / updateWhere / delete', () => {
        it('update: SET 与 WHERE 的列名都转义,params 键带前缀且裸名', async () => {
            await adapter.update('configs', { value: 'v' }, { key: 'k' });
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'UPDATE configs SET `value` = @set_value WHERE `key` = @where_key'
            );
            expect(adapter.executeNonQuery.mock.calls[0][1]).toEqual({
                set_value: 'v',
                where_key: 'k'
            });
        });

        it('updateWhere: SET 列名转义,whereClause 裸片段契约原样', async () => {
            await adapter.updateWhere('configs', { value: 'v' }, '`key` = @k', {
                k: 'k'
            });
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'UPDATE configs SET `value` = @set_value WHERE `key` = @k'
            );
            expect(adapter.executeNonQuery.mock.calls[0][1]).toEqual({
                k: 'k',
                set_value: 'v'
            });
        });

        it('delete: WHERE 列名转义,params 键裸名', async () => {
            await adapter.delete('configs', { key: 'k' });
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'DELETE FROM configs WHERE `key` = @key'
            );
            expect(adapter.executeNonQuery.mock.calls[0][1]).toEqual({
                key: 'k'
            });
        });
    });

    describe('selectOne / select', () => {
        it('selectOne: WHERE 与数组列名转义', async () => {
            await adapter.selectOne('cookies', ['key', 'value'], { key: 'k' });
            expect(adapter.execute.mock.calls[0][1]).toBe(
                'SELECT `key`, `value` FROM cookies WHERE `key` = @key LIMIT 1'
            );
            expect(adapter.execute.mock.calls[0][2]).toEqual({ key: 'k' });
        });

        it('select: WHERE 转义,数组列名转义', async () => {
            await adapter.select('cookies', ['key', 'value'], { key: 'k' });
            expect(adapter.execute.mock.calls[0][1]).toBe(
                'SELECT `key`, `value` FROM cookies WHERE `key` = @key'
            );
        });

        it('select: 字符串 colStr 分支原样保留(调用方自行构造)', async () => {
            await adapter.select('cookies', 'key, value', { key: 'k' });
            expect(adapter.execute.mock.calls[0][1]).toBe(
                'SELECT key, value FROM cookies WHERE `key` = @key'
            );
        });

        it('select: 无 where 时不加 WHERE 子句', async () => {
            await adapter.select('cookies', ['key']);
            expect(adapter.execute.mock.calls[0][1]).toBe(
                'SELECT `key` FROM cookies'
            );
        });
    });

    describe('count', () => {
        it('WHERE 列名转义', async () => {
            await adapter.count('cookies', { key: 'k' });
            expect(adapter.execute.mock.calls[0][1]).toBe(
                'SELECT COUNT(*) FROM cookies WHERE `key` = @key'
            );
            expect(adapter.execute.mock.calls[0][2]).toEqual({ key: 'k' });
        });
    });

    describe('increment', () => {
        it('SET 目标列与 WHERE 列名都转义', async () => {
            await adapter.increment('configs', 'value', 1, { key: 'k' });
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'UPDATE configs SET `value` = `value` + @amount WHERE `key` = @where_key'
            );
            expect(adapter.executeNonQuery.mock.calls[0][1]).toEqual({
                amount: 1,
                where_key: 'k'
            });
        });
    });

    describe('upsertPartial', () => {
        it('INSERT 列与 ON DUPLICATE KEY UPDATE 列名都转义', async () => {
            await adapter.upsertPartial(
                'configs',
                { key: 'k', value: 'v' },
                { value: 'v2' }
            );
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'INSERT INTO configs (`key`, `value`) VALUES (@key, @value) ' +
                    'ON DUPLICATE KEY UPDATE `value` = @up_value'
            );
            expect(adapter.executeNonQuery.mock.calls[0][1]).toEqual({
                key: 'k',
                value: 'v',
                up_value: 'v2'
            });
        });
    });

    describe('createTable', () => {
        it('结构化列定义转义(含 key 保留字)', async () => {
            await adapter.createTable('configs', [
                { name: 'key', type: 'TEXT', constraints: 'PRIMARY KEY' },
                { name: 'value', type: 'TEXT' }
            ]);
            // TEXT PK → VARCHAR(255)(MySQL 不允许 TEXT 作 PK)。
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'CREATE TABLE IF NOT EXISTS configs (`key` VARCHAR(255) PRIMARY KEY, `value` TEXT)'
            );
        });

        it('raw-string 列定义分支原样保留(裸片段契约)', async () => {
            await adapter.createTable('t', ['a INTEGER PRIMARY KEY', 'v TEXT']);
            expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
                'CREATE TABLE IF NOT EXISTS t (a INTEGER PRIMARY KEY, v TEXT)'
            );
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug: MySQL 旧库 configs/cookies 的 value 列过小
// 旧 schema 的 value 列可能是 TEXT(64KB 上限)/VARCHAR,CREATE TABLE IF NOT
// EXISTS 不升级既有列 → VRC 设置数据备份工具写入大 JSON(整个 Registry 备份
// 列表)或写入序列化 Cookie 时报 "Data too long for column 'value'"。
// _ensureLongTextColumn 探测 INFORMATION_SCHEMA 后仅在非 longtext 时
// ALTER MODIFY,幂等且零多余写。
// ─────────────────────────────────────────────────────────────────────────

describe('_ensureLongTextColumn(旧库 value 列升级)', () => {
    /** @type {MySQLAdapter} */
    let adapter;

    beforeEach(() => {
        adapter = new MySQLAdapter();
        adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
        adapter.execute = vi
            .fn()
            .mockImplementation(async (cb) => cb(['text']));
    });

    it('列已是 longtext → 跳过 ALTER(零写)', async () => {
        adapter.execute = vi
            .fn()
            .mockImplementation(async (cb) => cb(['longtext']));
        await adapter._ensureLongTextColumn('configs', 'value');
        expect(adapter.execute).toHaveBeenCalledTimes(1);
        expect(adapter.executeNonQuery).not.toHaveBeenCalled();
    });

    it('DATA_TYPE 大小写不敏感(LONGTEXT 亦跳过)', async () => {
        adapter.execute = vi
            .fn()
            .mockImplementation(async (cb) => cb(['LONGTEXT']));
        await adapter._ensureLongTextColumn('cookies', 'value');
        expect(adapter.executeNonQuery).not.toHaveBeenCalled();
    });

    it('列是 TEXT(旧 schema)→ ALTER MODIFY LONGTEXT + 反引号转义', async () => {
        await adapter._ensureLongTextColumn('configs', 'value');
        expect(adapter.executeNonQuery).toHaveBeenCalledTimes(1);
        expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
            'ALTER TABLE `configs` MODIFY `value` LONGTEXT'
        );
        // 探测用 INFORMATION_SCHEMA + 命名参数
        expect(adapter.execute.mock.calls[0][1]).toContain(
            'INFORMATION_SCHEMA.COLUMNS'
        );
        expect(adapter.execute.mock.calls[0][2]).toEqual({
            table: 'configs',
            column: 'value'
        });
    });

    it('列不存在 → 跳过(零 SQL 写)', async () => {
        adapter.execute = vi.fn().mockImplementation(async () => {});
        await adapter._ensureLongTextColumn('configs', 'value');
        expect(adapter.executeNonQuery).not.toHaveBeenCalled();
    });

    it('initValueColumnsLongText 依次升级 cookies 与 configs 的 value', async () => {
        adapter._ensureLongTextColumn = vi.fn().mockResolvedValue();
        await adapter.initValueColumnsLongText();
        expect(adapter._ensureLongTextColumn).toHaveBeenCalledTimes(2);
        expect(adapter._ensureLongTextColumn).toHaveBeenNthCalledWith(
            1,
            'cookies',
            'value'
        );
        expect(adapter._ensureLongTextColumn).toHaveBeenNthCalledWith(
            2,
            'configs',
            'value'
        );
    });

    it('ALTER 失败仅 warn、不抛出(启动期维护操作不拖垮启动)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        adapter.executeNonQuery = vi
            .fn()
            .mockRejectedValue(new Error('ALTER denied'));
        await expect(
            adapter._ensureLongTextColumn('configs', 'value')
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('LONGTEXT 失败');
        warn.mockRestore();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug: MySQL 原生模式二次启动 `Duplicate key name` 冒泡(Uncaught in promise)
// 旧实现靠 catch `e.message.includes('Duplicate key name')` 幂等,但 C# 桥
// reject 形态可能是纯字符串(`e.message` 为 undefined)→ catch 失效冒泡。
// 新实现双层幂等:先预检查 information_schema.statistics,已存在则跳过;
// catch 兜底 TOCTOU 竞态 + `String(e)` 兼容纯字符串 reject。
// ─────────────────────────────────────────────────────────────────────────

describe('createIndex 幂等(预检查 + 兜底)', () => {
    /** @type {MySQLAdapter} */
    let adapter;
    beforeEach(() => {
        adapter = new MySQLAdapter();
        adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
        adapter.execute = vi.fn().mockImplementation(async (cb) => cb(['0']));
    });

    test('索引已存在(预检查 count>0)→ 跳过,不调 executeNonQuery', async () => {
        adapter.execute = vi.fn().mockImplementation(async (cb) => cb(['1']));
        const result = await adapter.createIndex('idx_x', 't', ['c']);
        expect(result).toBe(0);
        expect(adapter.executeNonQuery).not.toHaveBeenCalled();
    });

    test('索引不存在 → CREATE INDEX 执行且 SQL 正确', async () => {
        await adapter.createIndex('idx_x', 't', ['a', 'b']);
        expect(adapter.executeNonQuery).toHaveBeenCalledTimes(1);
        expect(adapter.executeNonQuery.mock.calls[0][0]).toBe(
            'CREATE INDEX idx_x ON t (a, b)'
        );
        // unique 变体
        await adapter.createIndex('idx_u', 't', ['c'], true);
        expect(adapter.executeNonQuery.mock.calls[1][0]).toBe(
            'CREATE UNIQUE INDEX idx_u ON t (c)'
        );
    });

    test('预检查参数为命名参数(table/index)', async () => {
        await adapter.createIndex('idx_x', 't', ['c']);
        expect(adapter.execute.mock.calls[0][1]).toContain('@table');
        expect(adapter.execute.mock.calls[0][2]).toEqual({
            table: 't',
            index: 'idx_x'
        });
    });

    test('纯字符串 reject 含 Duplicate key name → 吞掉返回 0', async () => {
        adapter.executeNonQuery = vi
            .fn()
            .mockRejectedValue(
                "MySqlConnector.MySqlException (0x80004005): Duplicate key name 'idx_x'"
            );
        const result = await adapter.createIndex('idx_x', 't', ['c']);
        expect(result).toBe(0);
    });

    test('Error 对象 reject 含 Duplicate key name(完整 CefSharp 链)→ 吞掉', async () => {
        adapter.executeNonQuery = vi
            .fn()
            .mockRejectedValue(
                new Error(
                    'System.InvalidOperationException: Could not execute method: ... \n' +
                        " ---> MySqlConnector.MySqlException (0x80004005): Duplicate key name 'idx_x'"
                )
            );
        const result = await adapter.createIndex('idx_x', 't', ['c']);
        expect(result).toBe(0);
    });

    test('无关错误 → 重新抛出', async () => {
        adapter.executeNonQuery = vi
            .fn()
            .mockRejectedValue(new Error('some other error'));
        await expect(adapter.createIndex('idx_x', 't', ['c'])).rejects.toThrow(
            'some other error'
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────
// CAST 方言映射:MySQL 的 CAST 不支持 TEXT / BIGINT 类型(仅 CHAR / SIGNED),
// SQLite/PG 支持。feed.js / gameLog.js 的 UNION 查询用
// `CAST(NULL AS TEXT)` / `CAST(NULL AS BIGINT)` 填充空列,模块加载时生成
// 无法感知运行时 adapter —— 差异统一包裹在 MySQLAdapter 的 SQL 入口
// (execute / executeNonQuery),业务模块零改动。
// ─────────────────────────────────────────────────────────────────────────

describe('CAST 方言映射(_mapMySqlDialect)', () => {
    /** @type {MySQLAdapter} */
    let adapter;
    /** @type {any} */
    let savedMySQL;

    beforeEach(() => {
        adapter = new MySQLAdapter();
        // 保留真实 execute / executeNonQuery 方法体 —— 生产路径里在 SQL
        // 传给 C# 前调用 _mapMySqlDialect —— 只 stub 驱动边界
        // (globalThis.MySQL)。若像其它 describe 那样整体 mock adapter
        // 方法,真实方法体内的映射不会执行,断言将永远拿到原始 SQL。
        savedMySQL = globalThis.MySQL;
        globalThis.MySQL = {
            // 非 connectionString 路径的 C# 绑定直接返回行数组(JSON 字符串
            // 只用于 ExecuteJson* 变体),故 stub 用数组 [] 而非 '[]'。
            Execute: vi.fn().mockResolvedValue([]),
            ExecuteNonQuery: vi.fn().mockResolvedValue(0)
        };
    });

    afterEach(() => {
        globalThis.MySQL = savedMySQL;
    });

    test('execute 收到替换后的 SQL(TEXT→CHAR, BIGINT→SIGNED)', async () => {
        const sql =
            'SELECT CAST(NULL AS TEXT) AS status, CAST(NULL AS BIGINT) AS time FROM t';
        await adapter.execute(() => {}, sql, {});
        expect(globalThis.MySQL.Execute.mock.calls[0][0]).toBe(
            'SELECT CONVERT(CAST(NULL AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS status, CAST(NULL AS SIGNED) AS time FROM t'
        );
    });

    test('executeNonQuery 收到替换后的 SQL', async () => {
        const sql = 'INSERT INTO t (a) VALUES (CAST(NULL AS TEXT))';
        await adapter.executeNonQuery(sql, {});
        expect(globalThis.MySQL.ExecuteNonQuery.mock.calls[0][0]).toBe(
            'INSERT INTO t (a) VALUES (CONVERT(CAST(NULL AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci)'
        );
    });

    test('不含 CAST 的 SQL 原样透传', async () => {
        const sql = 'SELECT id, created_at FROM t WHERE id = @id';
        await adapter.execute(() => {}, sql, { id: 1 });
        expect(globalThis.MySQL.Execute.mock.calls[0][0]).toBe(sql);
    });

    test('_mapMySqlDialect 幂等(重复调用无副作用)', () => {
        const once = adapter._mapMySqlDialect('CAST(NULL AS TEXT)');
        const twice = adapter._mapMySqlDialect(once);
        expect(twice).toBe(
            'CONVERT(CAST(NULL AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci'
        );
    });
});

// ── _readChangeCounter(完备层计数器钩子,Phase 1) ───────────────────

describe('_readChangeCounter', () => {
    it('聚合 performance_schema 行级 DML 计数,返回 row[0] 数值', async () => {
        vi.stubGlobal('MySQL', {
            ExecuteJsonOnConnection: vi.fn().mockResolvedValue('[[42]]')
        });
        try {
            const adapter = new MySQLAdapter({
                connection: 'mysql://root:pass@127.0.0.1:3306/vrcx_test'
            });
            const version = await adapter._readChangeCounter();
            expect(version).toBe(42);
            const sql =
                globalThis.MySQL.ExecuteJsonOnConnection.mock.calls[0][1];
            expect(sql).toContain('performance_schema');
            expect(sql).toContain('table_io_waits_summary_by_table');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('查询无返回行时返回 null(完备层不运行)', async () => {
        vi.stubGlobal('MySQL', {
            ExecuteJsonOnConnection: vi.fn().mockResolvedValue('[]')
        });
        try {
            const adapter = new MySQLAdapter({
                connection: 'mysql://root:pass@127.0.0.1:3306/vrcx_test'
            });
            await expect(adapter._readChangeCounter()).resolves.toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('无 performance_schema 权限时返回 null', async () => {
        vi.stubGlobal('MySQL', {
            ExecuteJsonOnConnection: vi
                .fn()
                .mockRejectedValue(new Error('SELECT command denied'))
        });
        try {
            const adapter = new MySQLAdapter({
                connection: 'mysql://root:pass@127.0.0.1:3306/vrcx_test'
            });
            await expect(adapter._readChangeCounter()).resolves.toBeNull();
            await expect(adapter._readChangeCounter()).resolves.toBeNull();
            expect(
                globalThis.MySQL.ExecuteJsonOnConnection
            ).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
