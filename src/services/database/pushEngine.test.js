/**
 * pushEngine.js 单元测试 —— 分组事务包裹改造后的正确性验证。
 *
 * 测试策略:用 MemorySQLiteAdapter(node:sqlite 内存 DB)替代 srcAdapter
 * 和 dstAdapter。由于 push/pull 依赖 C# 全局实例(SQLite/PostgreSQL/MySQL
 * Proxy stub 在 vitest.setup.js 里返回 noopAsync),无法直接调用真实 C# 层,
 * 因此用 vi.mock 替换 `./adapter/index.js` 的 `adapter`(目标,写入)与
 * `createAdapter`(构建源 SQLite,读取)。
 *
 * 目标 adapter 的 engineType 必须 getter 返回非 'sqlite'/'unknown'(否则
 * push 的 guard 会拒绝),通过 Object.defineProperty 覆盖为 'mysql'。事务
 * 仍走 MemorySQLiteAdapter 的 BEGIN/COMMIT/ROLLBACK SQL,不依赖 C# 层,
 * 从而能验证 JS 层的分组事务包裹逻辑。
 *
 * 关键:源/目标的表结构必须一致。用 srcAdapter.initGlobalSchema() /
 * initUserSchema(prefix) 在源侧建出与目标侧一致的 schema(push 会调
 * adapter.initGlobalSchema/initUserSchema 在目标侧建同样的表),然后往源
 * 表里塞真实列名的数据。
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MemorySQLiteAdapter } from './migrations/__tests__/memoryAdapter.js';

// vi.hoisted 在 vi.mock 之前求值,holder 在 beforeEach 里赋值。
const { holders } = vi.hoisted(() => ({ holders: { dst: null, src: null } }));

vi.mock('./adapter/index.js', () => ({
    // 目标(写入)是 engineType 覆盖为 'mysql' 的 MemorySQLiteAdapter。
    get adapter() {
        return holders.dst;
    },
    // 源(读取)是普通 MemorySQLiteAdapter。
    createAdapter: async () => holders.src
}));

const { pushFromSqlite } = await import('./pushEngine.js');

let srcDb;
let dstDb;
let srcAdapter;
let dstAdapter;

beforeEach(() => {
    srcDb = new DatabaseSync(':memory:');
    dstDb = new DatabaseSync(':memory:');
    srcAdapter = new MemorySQLiteAdapter(srcDb);
    dstAdapter = new MemorySQLiteAdapter(dstDb);
    // 覆盖 engineType 让 push 的 guard 通过(必须非 sqlite/unknown)。
    Object.defineProperty(dstAdapter, 'engineType', {
        get: () => 'mysql',
        configurable: true
    });
    // isConnected() is async and probes the C# bridge; under the vitest
    // noopAsync stub it would resolve to false. Stub it to a healthy
    // backend so the pushFromSqlite fail-fast guard passes — these tests
    // exercise the JS-side transaction batching logic, not real DB reachability.
    vi.spyOn(dstAdapter, 'isConnected').mockResolvedValue(true);
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

/** 用真实 schema 在源侧建 global 表 + notes 表,并塞 N 行。 */
async function seedSrc() {
    // 源侧建出真实 global schema(push 会在目标侧也调 initGlobalSchema)。
    await srcAdapter.initGlobalSchema();
    // 源侧建出一个 prefix 的真实 user schema。
    await srcAdapter.initUserSchema('abc');

    // 往 cache_avatar(global)塞 N 行(列:id, added_at, author_id, ...)。
    for (let i = 1; i <= 2; i++) {
        await srcAdapter.insert('cache_avatar', {
            id: `avt_${i}`,
            added_at: '2024-01-01',
            author_id: `a${i}`,
            author_name: `author${i}`,
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
    // 往 abc_notes(user)塞 N 行(列:user_id, display_name, note, created_at)。
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

/** 往源 cache_avatar 塞 n 行(独立 helper,用于行数校验测试)。 */
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

/** 在源侧建一张非白名单表(mirror)并塞 n 行。 */
async function seedMirrorTable(name, n = 2) {
    await srcAdapter.createTable(name, [
        { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
        { name: 'val', type: 'TEXT' }
    ]);
    for (let i = 1; i <= n; i++) {
        await srcAdapter.insert(name, { id: i, val: `v${i}` });
    }
}

/** 往源塞 global 表 + user 表,各 n 行(用于原子性测试)。 */
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
    // 再塞一张 global 表(gamelog_location)用于多表回滚测试。
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

async function dstCount(table) {
    try {
        return await dstAdapter.countWhere(table);
    } catch {
        // 表不存在(createTable 在事务回滚时被 DDL 回滚)→ 视作 0 行。
        return 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 基本 push
// ─────────────────────────────────────────────────────────────────────────

describe('pushEngine — 基本 push', () => {
    test('src 有 1 张 global 表 + 1 个 prefix 的 1 张 user 表,push 后 dst 有相同数据', async () => {
        await seedSrc();

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        // globalTables 循环遍历全部 19 张 GLOBAL_TABLES 名(不存在的表
        // copyTable 返回 0 但仍 +1),所以这里是 19。
        expect(result.globalTables).toBe(19);
        // 只发现 abc_* 下的 notes 一个 user 表 → 1(但 initUserSchema 建 22 张,
        // abc_notes 外的 21 张表 copyTable 也会 +1,所以 userTables=22)。
        expect(result.userTables).toBe(22);
        expect(result.unknownTables).toBe(0);
        // rowsCopied = cache_avatar 2 行 + abc_notes 2 行 = 4。
        expect(result.rowsCopied).toBe(4);
        expect(result.errors).toEqual([]);

        expect(await dstCount('cache_avatar')).toBe(2);
        expect(await dstCount('abc_notes')).toBe(2);
    });

    test('源里 global 表数据被正确复制到目标(列内容)', async () => {
        await seedGlobalAvatar(2);
        await pushFromSqlite('sqlite:///fake/src.db');
        const rows = await dstAdapter.select('cache_avatar', ['id', 'name']);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual(['avt_1', 'Avatar1']);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 分组事务原子性
// ─────────────────────────────────────────────────────────────────────────

describe('pushEngine — 分组事务原子性', () => {
    test('global 组中途抛错 → 该组全回滚,其他组数据保留', async () => {
        await seedGlobalAndUser(2, 2); // cache_avatar 2 + gamelog_location 1 + abc_notes 2

        // 让 gamelog_location 的 bulkInsert 抛错 → global 组事务回滚。
        const origBulkInsert = dstAdapter.bulkInsert.bind(dstAdapter);
        vi.spyOn(dstAdapter, 'bulkInsert').mockImplementation(
            async (table, rows, conflict) => {
                if (table === 'gamelog_location') {
                    throw new Error('inject-fail');
                }
                return origBulkInsert(table, rows, conflict);
            }
        );

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        // global 组回滚 → globalTables 在 gamelog_location 中断,errors 收集。
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('global-group');
        // user 组独立事务,成功。
        expect(result.userTables).toBe(22);

        // 关键:global 组回滚 → cache_avatar(先成功复制)也被回滚。
        expect(await dstCount('cache_avatar')).toBe(0);
        expect(await dstCount('gamelog_location')).toBe(0);
        // 其他组(user)数据保留。
        expect(await dstCount('abc_notes')).toBe(2);
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

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        // global 组成功保留。
        expect(await dstCount('cache_avatar')).toBe(2);
        expect(result.globalTables).toBe(19);
        // user 组失败回滚:abc_notes 目标为空,errors 收集 user-group。
        // (userTables 计数器只反映事务回滚前已成功的表数,非实际写入数,
        //   故不断言具体值。)
        expect(await dstCount('abc_notes')).toBe(0);
        expect(result.errors).toHaveLength(1);
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

        const result = await pushFromSqlite('sqlite:///fake/src.db');

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

describe('pushEngine — mirror 表(数据完整性保底)', () => {
    test('src 有 1 张非白名单表,push 后 dst 有该表(mirror 组)', async () => {
        await seedMirrorTable('legacy_extra', 3);

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.unknownTables).toBe(1);
        expect(result.rowsCopied).toBe(3);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_extra')).toBe(3);
    });

    test('configs 表走 global 组,保留原表名复制', async () => {
        await srcAdapter.createTable('configs', [
            { name: 'key', type: 'TEXT', constraints: 'PRIMARY KEY' },
            { name: 'value', type: 'TEXT' }
        ]);
        await srcAdapter.insert('configs', {
            key: 'config:schema_version',
            value: '99'
        });
        await srcAdapter.insert('configs', { key: 'config:other', value: 'x' });

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.unknownTables).toBe(0);
        expect(await dstCount('configs')).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 空源
// ─────────────────────────────────────────────────────────────────────────

describe('pushEngine — 空源', () => {
    test('src 无表,push 返回 rowsCopied=0,errors=[]', async () => {
        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.globalTables).toBe(19);
        expect(result.userTables).toBe(0);
        expect(result.unknownTables).toBe(0);
        expect(result.rowsCopied).toBe(0);
        expect(result.errors).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 4b. OFFSET 兜底路径(复合 PK / 无 PK 表)
// ─────────────────────────────────────────────────────────────────────────
// copyTable 的游标分页(keyset pagination)仅对单列 PK 生效;复合 PK 或
// 无 PK 表退回 LIMIT/OFFSET 模式(O(N²) 但安全兜底)。以下测试覆盖
// OFFSET 路径的正确性,确保:
//   1. 复合 PK 表的行数校验通过(totalCopied === dstCount)。
//   2. 无 PK 表同样正确复制。
//   3. 复合 PK 表行数 > batchSize 时多页 OFFSET 累加正确。
//   4. 复合 PK 经 mirror 路径 buildMirroredColumns 重建后,目标表 PK
//      结构与源一致(复合 PK 被表级 PRIMARY KEY(...) 子句正确还原)。
// 参见 PR #13 review #8。

/**
 * 在源侧建一张复合 PK 表并塞 n 行。用 raw SQL 绕过 createTable 的
 * inline-constraints 限制(createTable 只支持单列 inline PRIMARY KEY)。
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
    await srcAdapter.createTable(name, [
        { name: 'val', type: 'TEXT' }
    ]);
    for (let i = 1; i <= n; i++) {
        await srcAdapter.insert(name, { val: `v${i}` });
    }
}

describe('pushEngine — OFFSET 兜底路径(复合 PK / 无 PK)', () => {
    test('复合 PK 表走 OFFSET 路径,行数校验通过', async () => {
        await seedCompositePkTable('legacy_composite', 3);

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.unknownTables).toBe(1);
        expect(result.rowsCopied).toBe(3);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_composite')).toBe(3);
    });

    test('复合 PK 表数据内容正确(每行 col_a/col_b/val 都对)', async () => {
        await seedCompositePkTable('legacy_composite', 2);

        await pushFromSqlite('sqlite:///fake/src.db');

        const rows = await dstAdapter.select('legacy_composite', [
            'col_a',
            'col_b',
            'val'
        ]);
        expect(rows).toHaveLength(2);
        // 排序后断言(OFFSET 路径不保证顺序,select 也无 ORDER BY)
        const sorted = rows.sort((r1, r2) => r1[0].localeCompare(r2[0]));
        expect(sorted[0]).toEqual(['a1', 'b1', 'v1']);
        expect(sorted[1]).toEqual(['a2', 'b2', 'v2']);
    });

    test('复合 PK 表行数 > batchSize,多页 OFFSET 累加正确', async () => {
        // 7 行,batchSize=3 → 3 页(3 + 3 + 1)
        await seedCompositePkTable('legacy_composite', 7);

        const result = await pushFromSqlite('sqlite:///fake/src.db', {
            batchSize: 3
        });

        expect(result.rowsCopied).toBe(7);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_composite')).toBe(7);
    });

    test('复合 PK 经 mirror 重建后,目标表 PK 结构与源一致', async () => {
        await seedCompositePkTable('legacy_composite', 1);

        await pushFromSqlite('sqlite:///fake/src.db');

        // 目标表的 PRAGMA table_info 应显示 col_a 和 col_b 都是 pk。
        // 直接用 dstDb(原始 DatabaseSync)查 PRAGMA(select 无法查 PRAGMA)。
        const pragma = dstDb.prepare('PRAGMA table_info(legacy_composite)').all();
        const pkCols = pragma
            .filter((c) => c.pk > 0)
            .map((c) => c.name)
            .sort();
        expect(pkCols).toEqual(['col_a', 'col_b']);
    });

    test('无 PK 表走 OFFSET 路径,行数校验通过', async () => {
        await seedNoPkTable('legacy_nopk', 3);

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.unknownTables).toBe(1);
        expect(result.rowsCopied).toBe(3);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_nopk')).toBe(3);
    });

    test('无 PK 表行数 > batchSize,多页 OFFSET 累加正确', async () => {
        await seedNoPkTable('legacy_nopk', 8);

        const result = await pushFromSqlite('sqlite:///fake/src.db', {
            batchSize: 3
        });

        expect(result.rowsCopied).toBe(8);
        expect(result.errors).toEqual([]);
        expect(await dstCount('legacy_nopk')).toBe(8);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 行数校验
// ─────────────────────────────────────────────────────────────────────────

describe('pushEngine — 行数校验', () => {
    test('copyTable 末尾的 countWhere 验证 src/dst 行数一致(分页路径)', async () => {
        // 大于 batchSize 的行数,验证分页 + 行数校验都通过。
        await srcAdapter.initGlobalSchema();
        for (let i = 1; i <= 12; i++) {
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

        const result = await pushFromSqlite('sqlite:///fake/src.db', {
            batchSize: 5
        });

        expect(result.rowsCopied).toBe(12);
        expect(result.errors).toEqual([]);
        expect(await dstCount('cache_avatar')).toBe(12);
    });

    test('行数校验在事务内正确(读得到未 commit 的写)', async () => {
        // copyTable 在 withTransaction 内调用 dstAdapter.countWhere,必须读到
        // 事务内未 commit 的 bulkInsert 写入,否则会抛 row count mismatch。
        await seedGlobalAvatar(7);

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.errors).toEqual([]);
        expect(await dstCount('cache_avatar')).toBe(7);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. guard
// ─────────────────────────────────────────────────────────────────────────

describe('pushEngine — engine guard', () => {
    test('目标 engineType 为 sqlite 时抛错', async () => {
        Object.defineProperty(dstAdapter, 'engineType', {
            get: () => 'sqlite',
            configurable: true
        });
        await expect(pushFromSqlite('sqlite:///fake/src.db')).rejects.toThrow(
            /destination adapter is the default SQLite engine/
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. copyTable 防御式处理(undefined 兜底 + quoteIdent 转义)
// ─────────────────────────────────────────────────────────────────────────
// Bug B: C# SQLite.Execute 未做 DBNull 归一化时,DBNull 经 CefSharp 封送为
// JS undefined,copyTable 行对象含 undefined 值 → bulkInsert 参数 undefined
// → CefSharp 跳过 undefined 属性 → MySqlConnector "Parameter '@x' must be
// defined"。修复:obj[col.name] = row[i] ?? null。
// Bug A: MySQL 源列名 key 需反引号转义,copyTable 防御式调用
// srcAdapter.quoteIdent?.(name) ?? name(push 方向源恒 SQLite → 裸名)。

describe('pushEngine — copyTable 防御式处理(undefined 兜底 + quoteIdent)', () => {
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

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.errors).toEqual([]);
        expect(result.rowsCopied).toBe(1);
        const rows = await dstAdapter.select('cookies', ['key', 'value']);
        expect(rows).toEqual([['k1', null]]);
    });

    test('srcAdapter 有 quoteIdent 时列名被反引号转义(MySQL 源场景)', async () => {
        await srcAdapter.initGlobalSchema();
        await srcAdapter.insert('cookies', { key: 'k1', value: 'v1' });

        // 模拟 MySQL 源(pull 方向的真实源);quote 回退逻辑应探测到它。
        srcAdapter.quoteIdent = (n) => `\`${n}\``;
        const captured = [];
        const origExecute = srcAdapter.execute.bind(srcAdapter);
        vi.spyOn(srcAdapter, 'execute').mockImplementation(
            async (cb, sql, params) => {
                if (sql.includes('FROM cookies')) captured.push(sql);
                return origExecute(cb, sql, params);
            }
        );

        const result = await pushFromSqlite('sqlite:///fake/src.db');

        expect(result.errors).toEqual([]);
        expect(captured[0]).toBe(
            'SELECT `key`, `value` FROM cookies ORDER BY `key` LIMIT @limit'
        );
        // 反引号标识符在 SQLite 上同样可执行,数据完整复制。
        expect(await dstCount('cookies')).toBe(1);
    });
});
