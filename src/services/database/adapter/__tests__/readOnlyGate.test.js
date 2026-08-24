/**
 * 浏览模式只读门禁（readOnlyGate.js）单元测试（§6.1 N3）。
 *
 * 覆盖（docs/architecture/BROWSE_MODE_M1_DESIGN.md §6.1）：
 *  1. no-op 契约全表：22 个写方法逐个断言守恒返回值（number → 0 / void →
 *     undefined）、底层方法零调用、once-warn 每方法名一次；
 *  2. 名单完整性（§4.1 MEDIUM-2 修订）：原型反射 + 写动词谓词，三引擎
 *     prototype own method names 命中集合 ⊆ WRITE_METHODS；
 *  3. MEDIUM-1：withTransaction 绑定——事务体内写被拦截、读正常、commit
 *     不抛错、_txStack 平衡、inner 内部 this._normalizeArgs 经 proxy 正常；
 *  4. 透传（§4.3）：读方法 / engineType / connectionString / onTableChange
 *     / _txStack 等原样透传；
 *  5. normalizeNodeMode（§2.5 MEDIUM-5）：trim+lower 契约同表用例。
 *
 * 注意：once-warn 状态在模块级（每进程每方法名一次），故"warn 总次数 = 21"
 * 的断言要求本文件第一个触写测试先于其他写调用执行——no-op 契约测试声明在
 * 最前；逐方法名"恰好一次"的断言则与顺序无关（once-warn 全局去重保证）。
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MemorySQLiteAdapter } from '../../migrations/__tests__/memoryAdapter.js';
import { SQLiteAdapter } from '../SQLiteAdapter.js';
import { PgSQLAdapter } from '../PgSQLAdapter.js';
import { MySQLAdapter } from '../MySQLAdapter.js';
import {
    WRITE_METHODS,
    createReadOnlyAdapter,
    normalizeNodeMode
} from '../readOnlyGate.js';

/** 守恒契约中返回 `undefined` 的写方法（对应 EngineAdapter.js JSDoc `Promise<void>`） */
const VOID_METHODS = new Set([
    'initUserSchema',
    'initGlobalSchema',
    'initValueColumnsLongText'
]);

const WARN_PREFIX = '[browse] 只读模式，写方法已跳过: ';

let db;

afterEach(() => {
    try {
        db?.close();
    } catch {
        /* ignore */
    }
    db = undefined;
    vi.restoreAllMocks();
});

describe('no-op 契约（§4.2）', () => {
    test('22 个写方法：守恒返回、底层零调用、once-warn（最先执行）', async () => {
        // 构造 vi.fn 包装的 inner：若 no-op 穿透，会被调用并返回 42
        const inner = {};
        for (const name of WRITE_METHODS) {
            inner[name] = vi.fn(async () => 42);
        }
        const proxy = createReadOnlyAdapter(inner);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        for (const name of WRITE_METHODS) {
            // 每个方法调用两次：验证守恒返回 + once-warn（第二次不再 warn）
            const result = await proxy[name]('table', { a: 1 }, 'extra');
            await proxy[name]('table', { a: 1 }, 'extra');
            // 返回值守恒：Promise<number> → 0；Promise<void> → undefined
            expect(result).toBe(VOID_METHODS.has(name) ? undefined : 0);
            // 底层方法未被调用（零 SQL 发出）
            expect(inner[name]).not.toHaveBeenCalled();
        }

        const warns = warn.mock.calls.filter(
            ([msg]) => typeof msg === 'string' && msg.startsWith(WARN_PREFIX)
        );
        // 22 个方法名恰好各 warn 一次（本文件首个触写测试）
        expect(warns).toHaveLength(22);
        for (const name of WRITE_METHODS) {
            expect(
                warns.filter(([msg]) => msg === WARN_PREFIX + name)
            ).toHaveLength(1);
        }
    });

    test('no-op 不抛错：异常参数/undefined this 均正常 resolve', async () => {
        const proxy = createReadOnlyAdapter({ insert: vi.fn() });
        await expect(proxy.insert()).resolves.toBe(0);
        await expect(proxy.insert(null, undefined, NaN)).resolves.toBe(0);
        await expect(proxy.initUserSchema()).resolves.toBeUndefined();
        await expect(proxy.dropUserSchema('prefix')).resolves.toBe(0);
    });
});

describe('名单完整性（§4.1 反射，MEDIUM-2）', () => {
    test('三引擎原型写方法 ⊆ WRITE_METHODS（且当前恰好 22 个、无例外）', () => {
        // 写动词谓词——引擎未来"只增"写方法时此处即失败，迫使名单同步；
        // 显式例外表当前为空（新增例外需随测试注释说明理由）。
        const writeVerb =
            /^(executeNonQuery|insert|bulkInsert|update|updateWhere|delete|deleteAll|deleteWhere|increment|upsertPartial|create[A-Z]|alter[A-Z]|drop[A-Z]|vacuum|optimize|init[A-Z])/;
        const hits = new Set();
        for (const AdapterClass of [
            SQLiteAdapter,
            PgSQLAdapter,
            MySQLAdapter
        ]) {
            for (const name of Object.getOwnPropertyNames(
                AdapterClass.prototype
            )) {
                if (writeVerb.test(name)) hits.add(name);
            }
        }
        for (const name of hits) {
            expect(WRITE_METHODS).toContain(name);
        }
        // 反向兜底：名单不得列出现有引擎都没有的写方法（防名单膨胀）
        expect([...hits].sort()).toEqual([...WRITE_METHODS].sort());
        expect(WRITE_METHODS).toHaveLength(22);
    });
});

describe('MEDIUM-1：withTransaction 绑定（§2.2 / §6.1）', () => {
    test('事务体内写被拦截、读正常、commit 不抛、_txStack 平衡', async () => {
        db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE test_t (id INTEGER PRIMARY KEY, val TEXT)');
        const inner = new MemorySQLiteAdapter(db);
        const proxy = createReadOnlyAdapter(inner);

        // 门禁外直写一行（对照基线：证明 inner 本身可写）
        await inner.insert('test_t', { id: 1, val: 'raw' });

        const execNonQuerySpy = vi.spyOn(inner, 'executeNonQuery');
        const insertSpy = vi.spyOn(inner, 'insert');

        await proxy.withTransaction(async () => {
            // 事务体内写被拦截：no-op 返回 0，不触达 inner（零 SQL）
            await expect(
                proxy.insert('test_t', { id: 2, val: 'gated' })
            ).resolves.toBe(0);
            expect(insertSpy).not.toHaveBeenCalled();
            expect(execNonQuerySpy).not.toHaveBeenCalled();
            // 读正常：inner 方法内部 this._normalizeArgs 经 proxy 透传
            const row = await proxy.selectOne('test_t', ['val'], { id: 1 });
            expect(row).toEqual(['raw']);
        });

        // commit 不抛错、栈平衡（beginTransaction push / commit pop）
        expect(proxy._txStack).toHaveLength(0);
        expect(inner._txStack).toHaveLength(0);
        expect(execNonQuerySpy).not.toHaveBeenCalled();

        // 门禁内 insert 被丢弃：表中仍只有门禁外直写的一行
        const rows = await proxy.select('test_t', ['id', 'val']);
        expect(rows).toEqual([[1, 'raw']]);
    });
});

describe('透传（§4.3）', () => {
    test('读方法 / engineType / connectionString / onTableChange / _txStack 原样透传', async () => {
        db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        const inner = new MemorySQLiteAdapter(db);
        await inner.insert('t', { id: 1, v: 'a' });
        const proxy = createReadOnlyAdapter(inner);

        // 读方法行为一致
        expect(await proxy.selectOne('t', ['v'], { id: 1 })).toEqual(['a']);
        expect(await proxy.countWhere('t')).toBe(1);
        const seen = [];
        await proxy.execute((row) => seen.push(row), 'SELECT v FROM t');
        expect(seen).toEqual([['a']]);
        expect(await proxy.select('t', ['v'])).toEqual([['a']]);

        // 属性/方法引用透传（未绑定函数，调用时 this = proxy）
        expect(proxy.engineType).toBe('sqlite');
        expect(proxy.connectionString).toBe(inner.connectionString);
        expect(proxy._txStack).toBe(inner._txStack);
        expect(proxy._normalizeArgs).toBe(inner._normalizeArgs);
        expect(proxy.withTransaction).toBe(inner.withTransaction);
        expect(proxy.onTableChange).toBe(inner.onTableChange);
        expect(proxy._onFunnelEvent).toBe(inner._onFunnelEvent);
        expect(proxy.listTables).toBe(inner.listTables);

        // 透传方法以 proxy 为 this 调用时内部链式访问仍正常
        const rows = await proxy.selectWhere('t', ['v'], 'id > @min', {
            min: 0
        });
        expect(rows).toEqual([['a']]);
    });
});

describe('normalizeNodeMode（§2.5 MEDIUM-5）', () => {
    test.each([
        ['browse', 'browse'],
        [' Browse ', 'browse'],
        // 大小写不敏感：trim+lower 契约下 'BROWSE' 同样生效为 browse
        ['BROWSE', 'browse'],
        ['auto', 'collector'],
        ['collector', 'collector'],
        ['', 'collector'],
        ['   ', 'collector'],
        [null, 'collector'],
        [undefined, 'collector'],
        ['invalid', 'collector'],
        [42, 'collector'],
        [0, 'collector'],
        [false, 'collector']
    ])('normalizeNodeMode(%p) === %s', (raw, expected) => {
        expect(normalizeNodeMode(raw)).toBe(expected);
    });
});
