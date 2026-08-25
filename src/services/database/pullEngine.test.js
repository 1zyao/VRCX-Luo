/**
 * pullEngine.js 单元测试 —— 分组事务包裹改造后的正确性验证。
 *
 * 测试策略:与 pushEngine 对称。pull 的源是单例 `adapter`(读),目标是
 * `createAdapter` 返回的新 SQLite(写)。mock `./adapter/index.js`:
 *   - `adapter` = engineType 覆盖为 'mysql' 的 MemorySQLiteAdapter(源,读)
 *   - `createAdapter` = 普通 MemorySQLiteAdapter(目标 SQLite,写)
 *
 * pull 的 guard 要求源 adapter 的 engineType 非 sqlite/unknown,故覆盖为
 * 'mysql'。事务仍走 MemorySQLiteAdapter 的 BEGIN/COMMIT/ROLLBACK SQL。
 *
 * 关键:pull 走 MySQL 分支(listTablesTypes 枚举全部表按白名单分桶)。
 * 源/目标表结构必须一致。用 srcAdapter.initGlobalSchema()/initUserSchema()
 * 在源侧建真实 schema(pull 会在目标侧调 dstAdapter.initGlobalSchema()
 * + initUserSchema(prefix) 自动建表),
 * 然后往源表塞真实列名数据。
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MemorySQLiteAdapter } from './migrations/__tests__/memoryAdapter.js';

const { holders } = vi.hoisted(() => ({ holders: { dst: null, src: null } }));

vi.mock('./adapter/index.js', () => ({
    // 源(读)是 engineType 覆盖为 'mysql' 的 MemorySQLiteAdapter。
    get adapter() {
        return holders.src;
    },
    // 目标(写)是普通 MemorySQLiteAdapter(pull 目标是 SQLite)。
    createAdapter: async () => holders.dst
}));

const { pullToSqlite } = await import('./pullEngine.js');

let srcDb;
let dstDb;
let srcAdapter;
let dstAdapter;

beforeEach(() => {
    srcDb = new DatabaseSync(':memory:');
    dstDb = new DatabaseSync(':memory:');
    srcAdapter = new MemorySQLiteAdapter(srcDb);
    dstAdapter = new MemorySQLiteAdapter(dstDb);
    Object.defineProperty(srcAdapter, 'engineType', {
        get: () => 'mysql',
        configurable: true
    });
    // isConnected() is async and probes the C# bridge; under the vitest
    // noopAsync stub it would resolve to false. Stub it to a healthy
    // backend so the pullToSqlite fail-fast guard passes — these tests
    // exercise the JS-side transaction batching logic, not real DB reachability.
    vi.spyOn(srcAdapter, 'isConnected').mockResolvedValue(true);
    holders.src = srcAdapter;
    holders.dst = dstAdapter;
});

afterEach(() => {
    vi.restoreAllMocks();
    try {
        srcDb?.close();
    } catch {
        /* ignore */
    }
    try {
        dstDb?.close();
    } catch {
        /* ignore */
    }
    srcDb = undefined;
    dstDb = undefined;
    srcAdapter = undefined;
    dstAdapter = undefined;
    holders.src = null;
    holders.dst = null;
});

// ── helpers ──────────────────────────────────────────────────────────────

/** 用真实 schema 在源侧建 global + user(notes)表,并塞数据。 */
async function seedSrc() {
    await srcAdapter.initGlobalSchema();
    await srcAdapter.initUserSchema('abc');
    for (let i = 1; i <= 2; i++) {
        await srcAdapter.insert('cache_avatar', {
            id: `avt_${i}`,
            added_at: '2024-01-01',
            author_id: 'a',
            author_name: 'a',
            created_at: '2024-01-01',
            description: 'd',
            image_url: 'u',
            name: `Avatar${i}`,
            release_status: 'public',
            thumbnail_image_url: 'tu',
            updated_at: '2024-01-01',
            version: 1
        });
    }
    await srcAdapter.insert('abc_notes', {
        user_id: 'u1',
        display_name: 'Alice',
        note: 'hello',
        created_at: '2024-01-01'
    });
    await srcAdapter.insert('abc_notes', {
        user_id: 'u2',
        display_name: 'Bob',
        note: 'world',
        created_at: '2024-01-01'
    });
}

/** 往源塞 global + user 表(含多张 global)用于原子性测试。 */
async function seedGlobalAndUser(globalN = 2, userN = 2) {
    await srcAdapter.initGlobalSchema();
    await srcAdapter.initUserSchema('abc');
    for (let i = 1; i <= globalN; i++) {
        await srcAdapter.insert('cache_avatar', {
            id: `avt_${i}`,
            added_at: '2024-01-01',
            author_id: 'a',
            author_name: 'a',
            created_at: '2024-01-01',
            description: 'd',
            image_url: 'u',
            name: `Avatar${i}`,
            release_status: 'public',
            thumbnail_image_url: 'tu',
            updated_at: '2024-01-01',
            version: 1
        });
    }
    await srcAdapter.insert('gamelog_location', {
        id: 1,
        created_at: '2024-01-01',
        location: 'wrld_x:1',
        world_id: 'wrld_x',
        world_name: 'World',
        time: 100,
        group_name: ''
    });
    for (let i = 1; i <= userN; i++) {
        await srcAdapter.insert('abc_notes', {
            user_id: `u${i}`,
            display_name: `Name${i}`,
            note: `n${i}`,
            created_at: '2024-01-01'
        });
    }
}

async function seedMirrorTable(name, n = 2) {
    await srcAdapter.createTable(name, [
        { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
        { name: 'val', type: 'TEXT' }
    ]);
    for (let i = 1; i <= n; i++) {
        await srcAdapter.insert(name, { id: i, val: `v${i}` });
    }
}

async function seedGlobalAvatar(n) {
    await srcAdapter.initGlobalSchema();
    for (let i = 1; i <= n; i++) {
        await srcAdapter.insert('cache_avatar', {
            id: `avt_${i}`,
            added_at: '2024-01-01',
            author_id: 'a',
            author_name: 'a',
            created_at: '2024-01-01',
            description: 'd',
            image_url: 'u',
            name: `Avatar${i}`,
            release_status: 'public',
            thumbnail_image_url: 'tu',
            updated_at: '2024-01-01',
            version: 1
        });
    }
}

async function dstCount(table) {
    try {
        return await dstAdapter.countWhere(table);
    } catch {
        // 表不存在(createTable 在事务回滚时被 DDL 回滚)→ 视作 0 行。
        return 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 基本 pull
// ─────────────────────────────────────────────────────────────────────────

describe('pullEngine — 基本 pull', () => {
    test('src 有 1 张 global 表 + 1 张 user 表,pull 后 dst 有相同数据', async () => {
        await seedSrc();

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        // MySQL 分支:globalSchema 含源里全部 global 表(initGlobalSchema 建 19 张)。
        expect(result.globalTables).toBe(19);
        // userTasksByPrefix 含 abc 的全部 22 张表,但只有 abc_notes 有数据。
        // copyTable 对空表也 +1,所以 userTables=22。
        expect(result.userTables).toBe(22);
        expect(result.unknownTables).toBe(0);
        expect(result.rowsCopied).toBe(4); // 2 + 2
        expect(result.errors).toEqual([]);

        expect(await dstCount('cache_avatar')).toBe(2);
        expect(await dstCount('abc_notes')).toBe(2);
    });

    test('数据内容被正确复制到目标(列内容)', async () => {
        await seedSrc();
        await pullToSqlite('sqlite:///fake/dst.db');
        const rows = await dstAdapter.select('cache_avatar', ['id', 'name']);
        expect(rows[0]).toEqual(['avt_1', 'Avatar1']);
    });

    test('node_registry 运行期心跳不被复制(bot#23)', async () => {
        // node_registry 表由 src initGlobalSchema 创建;塞入心跳行(活跃 collector)。
        await srcAdapter.initGlobalSchema();
        await srcAdapter.insert('node_registry', {
            node_id: 'node-test',
            mode: 'collector',
            prefixes: 'usr_a',
            heartbeat_at: new Date().toISOString()
        });
        const result = await pullToSqlite('sqlite:///fake/dst.db');

        // 分类计数不受影响(global 19 张)。
        expect(result.globalTables).toBe(19);
        expect(result.errors).toEqual([]);
        // 目标 node_registry 表存在(dst initGlobalSchema 自建)但无心跳行。
        expect(await dstCount('node_registry')).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 分组事务
// ─────────────────────────────────────────────────────────────────────────

describe('pullEngine — 分组事务原子性', () => {
    test('global 组中途抛错 → 该组全回滚,user 组保留', async () => {
        await seedGlobalAndUser(2, 2); // cache_avatar 2 + gamelog_location 1 + abc_notes 2

        const origBulkInsert = dstAdapter.bulkInsert.bind(dstAdapter);
        vi.spyOn(dstAdapter, 'bulkInsert').mockImplementation(
            async (table, rows, conflict) => {
                if (table === 'gamelog_location') {
                    throw new Error('inject-fail');
                }
                return origBulkInsert(table, rows, conflict);
            }
        );

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        // global 组回滚 → cache_avatar 也回滚。
        expect(await dstCount('cache_avatar')).toBe(0);
        expect(await dstCount('gamelog_location')).toBe(0);
        // user 组独立事务,保留。
        expect(await dstCount('abc_notes')).toBe(2);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('global-group');
    });

    test('user 组中途抛错 → 该 prefix 组回滚,global 组保留', async () => {
        await seedGlobalAndUser(2, 2);

        const origBulkInsert = dstAdapter.bulkInsert.bind(dstAdapter);
        vi.spyOn(dstAdapter, 'bulkInsert').mockImplementation(
            async (table, rows, conflict) => {
                if (table === 'abc_notes') {
                    throw new Error('inject-user-fail');
                }
                return origBulkInsert(table, rows, conflict);
            }
        );

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(await dstCount('cache_avatar')).toBe(2);
        expect(await dstCount('abc_notes')).toBe(0);
        // DDL 与数据同事务:回滚后目标端连表都不存在(不留空表)。
        expect(await dstAdapter.listTables('%abc_notes')).toHaveLength(0);
        expect(result.globalTables).toBe(19);
        expect(result.errors).toHaveLength(1);
        // 错误消息带 prefix(与 pushEngine 格式对称)。
        expect(result.errors[0]).toContain('user-group:abc');
    });

    test('mirror 组中途抛错 → mirror 组回滚,global/user 组保留', async () => {
        await seedGlobalAndUser(1, 1);
        await seedMirrorTable('legacy_table', 2);

        const origBulkInsert = dstAdapter.bulkInsert.bind(dstAdapter);
        vi.spyOn(dstAdapter, 'bulkInsert').mockImplementation(
            async (table, rows, conflict) => {
                if (table === 'legacy_table') {
                    throw new Error('inject-mirror-fail');
                }
                return origBulkInsert(table, rows, conflict);
            }
        );

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(await dstCount('cache_avatar')).toBe(1);
        expect(await dstCount('abc_notes')).toBe(1);
        expect(await dstCount('legacy_table')).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('mirror-group');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. mirror 表
// ─────────────────────────────────────────────────────────────────────────

describe('pullEngine — mirror 表', () => {
    test('src 有 1 张非白名单表,pull 后 dst 有该表(mirror 组)', async () => {
        await seedMirrorTable('legacy_extra', 3);

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(result.unknownTables).toBe(1);
        expect(result.rowsCopied).toBe(3);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_extra')).toBe(3);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 3b. OFFSET 兜底路径(复合 PK / 无 PK 表)
// ─────────────────────────────────────────────────────────────────────────
// copyTable 的游标分页仅对单列 PK 生效;复合 PK 或无 PK 表退回
// LIMIT/OFFSET 模式。以下测试覆盖 OFFSET 路径的正确性,与 pushEngine
// 对称。参见 PR #13 review #8。

/**
 * 在源侧建一张复合 PK 表并塞 n 行。用 raw SQL 绕过 createTable 的
 * inline-constraints 限制。
 * @param {string} name - 表名(非白名单,走 mirror 桶)
 * @param {number} n - 行数
 */
async function seedCompositePkTable(name, n = 3) {
    await srcAdapter.executeNonQuery(
        `CREATE TABLE IF NOT EXISTS ${name} (col_a TEXT NOT NULL, col_b TEXT NOT NULL, val TEXT, PRIMARY KEY (col_a, col_b))`
    );
    for (let i = 1; i <= n; i++) {
        await srcAdapter.insert(name, {
            col_a: `a${i}`,
            col_b: `b${i}`,
            val: `v${i}`
        });
    }
}

/**
 * 在源侧建一张无 PK 表并塞 n 行。
 * @param {string} name - 表名(非白名单,走 mirror 桶)
 * @param {number} n - 行数
 */
async function seedNoPkTable(name, n = 3) {
    await srcAdapter.createTable(name, [{ name: 'val', type: 'TEXT' }]);
    for (let i = 1; i <= n; i++) {
        await srcAdapter.insert(name, { val: `v${i}` });
    }
}

describe('pullEngine — OFFSET 兜底路径(复合 PK / 无 PK)', () => {
    test('复合 PK 表走 OFFSET 路径,行数校验通过', async () => {
        await seedCompositePkTable('legacy_composite', 3);

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(result.unknownTables).toBe(1);
        expect(result.rowsCopied).toBe(3);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_composite')).toBe(3);
    });

    test('复合 PK 表数据内容正确(每行 col_a/col_b/val 都对)', async () => {
        await seedCompositePkTable('legacy_composite', 2);

        await pullToSqlite('sqlite:///fake/dst.db');

        const rows = await dstAdapter.select('legacy_composite', [
            'col_a',
            'col_b',
            'val'
        ]);
        expect(rows).toHaveLength(2);
        const sorted = rows.sort((r1, r2) => r1[0].localeCompare(r2[0]));
        expect(sorted[0]).toEqual(['a1', 'b1', 'v1']);
        expect(sorted[1]).toEqual(['a2', 'b2', 'v2']);
    });

    test('复合 PK 表行数 > batchSize,多页 OFFSET 累加正确', async () => {
        await seedCompositePkTable('legacy_composite', 7);

        const result = await pullToSqlite('sqlite:///fake/dst.db', {
            batchSize: 3
        });

        expect(result.rowsCopied).toBe(7);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_composite')).toBe(7);
    });

    test('复合 PK 经 mirror 重建后,目标表 PK 结构与源一致', async () => {
        await seedCompositePkTable('legacy_composite', 1);

        await pullToSqlite('sqlite:///fake/dst.db');

        // 直接用 dstDb(原始 DatabaseSync)查 PRAGMA。
        const pragma = dstDb
            .prepare('PRAGMA table_info(legacy_composite)')
            .all();
        const pkCols = pragma
            .filter((c) => c.pk > 0)
            .map((c) => c.name)
            .sort();
        expect(pkCols).toEqual(['col_a', 'col_b']);
    });

    test('无 PK 表走 OFFSET 路径,行数校验通过', async () => {
        await seedNoPkTable('legacy_nopk', 3);

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(result.unknownTables).toBe(1);
        expect(result.rowsCopied).toBe(3);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_nopk')).toBe(3);
    });

    test('无 PK 表行数 > batchSize,多页 OFFSET 累加正确', async () => {
        await seedNoPkTable('legacy_nopk', 8);

        const result = await pullToSqlite('sqlite:///fake/dst.db', {
            batchSize: 3
        });

        expect(result.rowsCopied).toBe(8);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_nopk')).toBe(8);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. guard + 行数校验
// ─────────────────────────────────────────────────────────────────────────

describe('pullEngine — guard + 行数校验', () => {
    test('源 engineType 为 sqlite 时抛错', async () => {
        Object.defineProperty(srcAdapter, 'engineType', {
            get: () => 'sqlite',
            configurable: true
        });
        await expect(pullToSqlite('sqlite:///fake/dst.db')).rejects.toThrow(
            /source adapter is the default SQLite engine/
        );
    });

    test('行数校验在事务内正确(读得到未 commit 的写)', async () => {
        await seedGlobalAvatar(7);
        const result = await pullToSqlite('sqlite:///fake/dst.db');
        expect(result.errors).toEqual([]);
        expect(await dstCount('cache_avatar')).toBe(7);
    });

    test('行数校验分页路径(batchSize=5,12 行)', async () => {
        await seedGlobalAvatar(12);
        const result = await pullToSqlite('sqlite:///fake/dst.db', {
            batchSize: 5
        });
        expect(result.errors).toEqual([]);
        expect(await dstCount('cache_avatar')).toBe(12);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. PG 分支(push/pull 对称性修复 A2/A6)
// ─────────────────────────────────────────────────────────────────────────
// PG 分支:listGlobalTablesTypes 枚举 public schema 的全部表(白名单 + 非
// 白名单),pull 引擎须按白名单过滤——已知 global 表进 global 组,其余进
// §5 mirror 桶(按 schema 限定名 `public.{name}` 键控 srcSchemaMap,
// mirror 的 dstTable 用 stripSchemaPrefix 还原裸名)。SQLite 内存库无法
// 建 `public.X` 表,故 mock `execute` 把限定名翻译回裸名后再交给真实
// MemorySQLiteAdapter 执行。

describe('pullEngine — PG 分支(白名单过滤 + mirror 兜底)', () => {
    /** @param {string} sql */
    const translateSql = (sql) =>
        sql
            .replace(/public\.([a-z0-9_]+)/gi, '$1')
            .replace(/account_([a-z0-9]+)\.([a-z0-9_]+)/gi, '$1_$2');

    function usePgEngine() {
        Object.defineProperty(srcAdapter, 'engineType', {
            get: () => 'postgresql',
            configurable: true
        });
    }

    /**
     * 安装 PG 源 mock:listGlobalTablesTypes / listTablesTypes 直接返回
     * 给定条目,execute 用 translateSql 包装(先 bind 真实实现再 spy)。
     * listGlobalTablesTypes 不在 SQLiteAdapter 原型上(仅 PgSQLAdapter
     * 有),故用直接赋值而非 vi.spyOn。
     * @param {{globalTables?: Array, userTables?: Array}} [mocks]
     */
    function mockPgSource({ globalTables = [], userTables = [] } = {}) {
        const origExecute = srcAdapter.execute.bind(srcAdapter);
        vi.spyOn(srcAdapter, 'execute').mockImplementation((callback, sql, args) =>
            origExecute(callback, translateSql(sql), args)
        );
        srcAdapter.listGlobalTablesTypes = vi
            .fn()
            .mockResolvedValue(globalTables);
        srcAdapter.listTablesTypes = vi.fn().mockResolvedValue(userTables);
    }

    test('PG 源:public 含白名单表 + 1 张非白名单表 → 非白名单进 mirror 桶(A2/A6)', async () => {
        usePgEngine();
        await srcAdapter.initGlobalSchema();
        await srcAdapter.createTable('custom_extra', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'val', type: 'TEXT' }
        ]);
        for (let i = 1; i <= 2; i++) {
            await srcAdapter.insert('cache_avatar', {
                id: `avt_${i}`,
                added_at: '2024-01-01',
                author_id: 'a',
                author_name: 'a',
                created_at: '2024-01-01',
                description: 'd',
                image_url: 'u',
                name: `Avatar${i}`,
                release_status: 'public',
                thumbnail_image_url: 'tu',
                updated_at: '2024-01-01',
                version: 1
            });
            await srcAdapter.insert('custom_extra', { id: i, val: `v${i}` });
        }

        // 用真实列元数据(listTablesTypes)构造 mock 条目,避免手工拼错形状。
        const allTables = await srcAdapter.listTablesTypes();
        const cacheAvatar = allTables.find((t) => t.tableName === 'cache_avatar');
        const customExtra = allTables.find((t) => t.tableName === 'custom_extra');
        mockPgSource({
            globalTables: [
                { tableName: 'public.cache_avatar', columns: cacheAvatar.columns },
                { tableName: 'public.custom_extra', columns: customExtra.columns }
            ],
            userTables: []
        });

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        // global 组只有白名单内的 cache_avatar(1 张),custom_extra 落 mirror。
        expect(result.globalTables).toBe(1);
        expect(result.unknownTables).toBe(1);
        expect(result.userTables).toBe(0);
        expect(result.rowsCopied).toBe(4); // 2 + 2
        expect(result.errors).toEqual([]);
        expect(await dstCount('cache_avatar')).toBe(2);
        expect(await dstCount('custom_extra')).toBe(2);
    });

    test('PG 源:account_* 用户表走 per-prefix 事务', async () => {
        usePgEngine();
        await srcAdapter.initGlobalSchema();
        await srcAdapter.initUserSchema('abc');
        await srcAdapter.insert('abc_notes', {
            user_id: 'u1',
            display_name: 'Alice',
            note: 'hello',
            created_at: '2024-01-01'
        });

        const allTables = await srcAdapter.listTablesTypes();
        const notes = allTables.find((t) => t.tableName === 'abc_notes');
        mockPgSource({
            globalTables: [],
            userTables: [{ tableName: 'account_abc.notes', columns: notes.columns }]
        });

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(result.globalTables).toBe(0);
        expect(result.userTables).toBe(1);
        expect(result.unknownTables).toBe(0);
        expect(result.rowsCopied).toBe(1);
        expect(result.errors).toEqual([]);
        expect(await dstCount('abc_notes')).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. copyTable 防御式处理(undefined 兜底 + quoteIdent 转义)
// ─────────────────────────────────────────────────────────────────────────
// 与 pushEngine 对称,但这里是生产真实路径:pull 方向源是 MySQLAdapter,
// cookies/configs 的 key 列必须反引号转义(Bug A),DBNull 封送的
// undefined 必须兜底为 null(Bug B)。

describe('pullEngine — copyTable 防御式处理(undefined 兜底 + quoteIdent)', () => {
    test('源行含 undefined(DBNull 封送)→ 目标写入 null,无错误', async () => {
        await srcAdapter.initGlobalSchema();

        // 注入含 undefined 的行,模拟 DBNull 经 CefSharp 封送为 undefined。
        const origExecute = srcAdapter.execute.bind(srcAdapter);
        vi.spyOn(srcAdapter, 'execute').mockImplementation(
            async (cb, sql, params) => {
                if (sql.includes('FROM cookies')) {
                    cb(['k1', undefined]);
                    return;
                }
                return origExecute(cb, sql, params);
            }
        );

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(result.errors).toEqual([]);
        const rows = await dstAdapter.select('cookies', ['key', 'value']);
        expect(rows).toEqual([['k1', null]]);
    });

    test('srcAdapter 有 quoteIdent 时列名被反引号转义(MySQL 源真实场景)', async () => {
        await srcAdapter.initGlobalSchema();
        await srcAdapter.insert('cookies', { key: 'k1', value: 'v1' });

        // pull 方向的真实源是 MySQLAdapter(有 quoteIdent)。
        srcAdapter.quoteIdent = (n) => `\`${n}\``;
        const captured = [];
        const origExecute = srcAdapter.execute.bind(srcAdapter);
        vi.spyOn(srcAdapter, 'execute').mockImplementation(
            async (cb, sql, params) => {
                if (sql.includes('FROM cookies')) captured.push(sql);
                return origExecute(cb, sql, params);
            }
        );

        const result = await pullToSqlite('sqlite:///fake/dst.db');

        expect(result.errors).toEqual([]);
        expect(captured[0]).toBe(
            'SELECT `key`, `value` FROM cookies ORDER BY `key` LIMIT @limit'
        );
        expect(await dstCount('cookies')).toBe(1);
    });
});

