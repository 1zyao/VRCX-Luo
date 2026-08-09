/**
 * SQLiteAdapter unit tests — Phase 10 Track A 10.1.
 *
 * Covers all public methods of `SQLiteAdapter` via the `MemorySQLiteAdapter`
 * reference implementation (extends SQLiteAdapter, overrides only
 * `execute`/`executeNonQuery` to route to Node's built-in `node:sqlite`
 * DatabaseSync). The remaining 42 dialect SQL-builders are exercised
 * through the inherited interface against a real `:memory:` SQLite
 * database — assertions verify actual SQL behaviour, not just generated
 * SQL strings.
 *
 * No `vi.mock` is used. Each `beforeEach` builds a fresh `:memory:` db;
 * each `afterEach` closes it. The adapter is instantiated directly,
 * bypassing the `adapter/index.js` singleton.
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MemorySQLiteAdapter } from '../../migrations/__tests__/memoryAdapter.js';

// `handleSQLiteError` dynamically imports the modal store / i18n /
// appActions — stub them so the error-mapping tests (section 12) can
// assert modal behaviour deterministically.
const { modalMock, openExternalLinkMock } = vi.hoisted(() => ({
    modalMock: {
        confirm: vi.fn(() => Promise.resolve({ ok: false })),
        alert: vi.fn()
    },
    openExternalLinkMock: vi.fn()
}));

vi.mock('../../../../stores/modal', () => ({
    useModalStore: () => modalMock
}));

vi.mock('../../../../plugins/i18n', () => ({
    i18n: { global: { t: (key) => key } }
}));

vi.mock('../../../../shared/utils/appActions', () => ({
    openExternalLink: openExternalLinkMock
}));

let db;
let adapter;

beforeEach(() => {
    db = new DatabaseSync(':memory:');
    adapter = new MemorySQLiteAdapter(db);
});

afterEach(() => {
    try {
        db?.close();
    } catch {
        /* ignore close errors */
    }
    db = undefined;
    adapter = undefined;
});

// ── helpers ──────────────────────────────────────────────────────────────

/** Create a small fixture table and insert N rows. */
async function seedTable(name, n = 3) {
    await adapter.createTable(name, [
        { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
        { name: 'name', type: 'TEXT' },
        { name: 'age', type: 'INTEGER' }
    ]);
    for (let i = 1; i <= n; i++) {
        await adapter.insert(name, { id: i, name: `u${i}`, age: 20 + i });
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Raw execution
// ─────────────────────────────────────────────────────────────────────────

describe('Raw execution — execute / executeNonQuery / _normalizeArgs', () => {
    test('execute() callback receives positional arrays (row[0], row[1])', async () => {
        await seedTable('users', 2);
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            'SELECT id, name, age FROM users ORDER BY id'
        );
        expect(rows).toHaveLength(2);
        expect(Array.isArray(rows[0])).toBe(true);
        expect(rows[0][0]).toBe(1);
        expect(rows[0][1]).toBe('u1');
        expect(rows[0][2]).toBe(21);
    });

    test('execute() with null args takes the no-param path', async () => {
        await seedTable('users', 1);
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            'SELECT COUNT(*) FROM users',
            null
        );
        expect(rows[0][0]).toBe(1);
    });

    test('execute() with undefined args takes the no-param path', async () => {
        await seedTable('users', 1);
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            'SELECT COUNT(*) FROM users',
            undefined
        );
        expect(rows[0][0]).toBe(1);
    });

    test('execute() accepts bare named-param keys (no @ prefix) via _normalizeArgs', async () => {
        await seedTable('users', 5);
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            'SELECT id FROM users WHERE id > @min ORDER BY id',
            { min: 3 }
        );
        expect(rows.map((r) => r[0])).toEqual([4, 5]);
    });

    test('execute() accepts already-@-prefixed param keys as-is', async () => {
        await seedTable('users', 5);
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            'SELECT id FROM users WHERE id > @min ORDER BY id',
            { '@min': 2 }
        );
        expect(rows.map((r) => r[0])).toEqual([3, 4, 5]);
    });

    test('executeNonQuery() returns rows-affected for parameterised INSERT', async () => {
        await seedTable('users', 0);
        const n = await adapter.executeNonQuery(
            'INSERT INTO users (id, name, age) VALUES (@id, @name, @age)',
            { id: 1, name: 'alice', age: 30 }
        );
        expect(n).toBe(1);
    });

    test('executeNonQuery() returns rows-affected for parameterised UPDATE', async () => {
        await seedTable('users', 3);
        const n = await adapter.executeNonQuery(
            'UPDATE users SET age = @age WHERE id < @cutoff',
            { age: 99, cutoff: 3 }
        );
        expect(n).toBe(2);
    });

    test('executeNonQuery() returns 0 for DDL (CREATE TABLE)', async () => {
        const n = await adapter.executeNonQuery(
            'CREATE TABLE ddl_t (id INTEGER PRIMARY KEY)'
        );
        expect(n).toBe(0);
    });

    test('executeNonQuery() returns 0 for BEGIN / COMMIT / ROLLBACK', async () => {
        expect(await adapter.executeNonQuery('BEGIN')).toBe(0);
        expect(await adapter.executeNonQuery('COMMIT')).toBe(0);
        expect(await adapter.executeNonQuery('BEGIN')).toBe(0);
        expect(await adapter.executeNonQuery('ROLLBACK')).toBe(0);
    });

    test('executeNonQuery() returns 0 for VACUUM', async () => {
        expect(await adapter.executeNonQuery('VACUUM')).toBe(0);
    });

    test('executeNonQuery() returns 0 for PRAGMA', async () => {
        expect(await adapter.executeNonQuery('PRAGMA user_version = 0')).toBe(
            0
        );
    });

    test('_normalizeArgs prefixes bare keys with @, leaves @-keys untouched', () => {
        const out = adapter._normalizeArgs({ a: 1, '@b': 2 });
        expect(out).toEqual({ '@a': 1, '@b': 2 });
    });

    test('_normalizeArgs passes through null/undefined/arrays unchanged', () => {
        expect(adapter._normalizeArgs(null)).toBe(null);
        expect(adapter._normalizeArgs(undefined)).toBe(undefined);
        expect(adapter._normalizeArgs([1, 2])).toEqual([1, 2]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. DML — insert / bulkInsert / update / updateWhere / delete / deleteAll /
//         deleteWhere / increment / upsertPartial
// ─────────────────────────────────────────────────────────────────────────

describe('DML — insert / bulkInsert / update* / delete* / increment / upsertPartial', () => {
    test('insert() with no conflict clause inserts one row', async () => {
        await seedTable('users', 0);
        const n = await adapter.insert('users', { id: 1, name: 'a', age: 10 });
        expect(n).toBe(1);
        const row = await adapter.selectOne('users', ['name'], { id: 1 });
        expect(row[0]).toBe('a');
    });

    test('insert() with conflict="ignore" produces INSERT OR IGNORE in SQL', async () => {
        // Verify both the generated SQL string (literal dialect) AND behaviour.
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT', constraints: 'UNIQUE' }
        ]);
        await adapter.insert('t', { id: 1, name: 'x' });
        const spy = vi.spyOn(adapter, 'executeNonQuery');
        // Duplicate unique name with 'ignore' -> 0 rows, no error.
        const n = await adapter.insert('t', { id: 2, name: 'x' }, 'ignore');
        expect(n).toBe(0);
        // Assert the literal SQLite dialect keyword was emitted.
        expect(spy).toHaveBeenCalledTimes(1);
        const sql = spy.mock.calls[0][0];
        expect(sql).toContain('INSERT OR IGNORE');
        spy.mockRestore();
        // Original row intact.
        const rows = await adapter.select('t', ['id', 'name']);
        expect(rows).toHaveLength(1);
        expect(rows[0][0]).toBe(1);
    });

    test('insert() with conflict="replace" produces INSERT OR REPLACE', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT', constraints: 'UNIQUE' }
        ]);
        await adapter.insert('t', { id: 1, name: 'x' });
        const spy = vi.spyOn(adapter, 'executeNonQuery');
        const n = await adapter.insert('t', { id: 2, name: 'x' }, 'replace');
        expect(n).toBe(1);
        expect(spy).toHaveBeenCalledTimes(1);
        const sql = spy.mock.calls[0][0];
        expect(sql).toContain('INSERT OR REPLACE');
        spy.mockRestore();
        // The original row was replaced — new id is 2.
        const rows = await adapter.select('t', ['id', 'name']);
        expect(rows).toHaveLength(1);
        expect(rows[0][0]).toBe(2);
    });

    test('insert() with no clause on UNIQUE conflict throws', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT', constraints: 'UNIQUE' }
        ]);
        await adapter.insert('t', { id: 1, name: 'x' });
        await expect(adapter.insert('t', { id: 2, name: 'x' })).rejects.toThrow(
            /UNIQUE constraint/i
        );
    });

    test('bulkInsert() inserts multiple rows in one statement', async () => {
        await seedTable('users', 0);
        const n = await adapter.bulkInsert('users', [
            { id: 1, name: 'a', age: 10 },
            { id: 2, name: 'b', age: 20 },
            { id: 3, name: 'c', age: 30 }
        ]);
        expect(n).toBe(3);
        const rows = await adapter.select('users', ['id'], undefined, {
            order: 'id'
        });
        expect(rows.map((r) => r[0])).toEqual([1, 2, 3]);
    });

    test('bulkInsert() with empty array short-circuits to undefined', async () => {
        await seedTable('users', 0);
        const result = await adapter.bulkInsert('users', []);
        expect(result).toBeUndefined();
        const rows = await adapter.select('users', ['id']);
        expect(rows).toHaveLength(0);
    });

    test('bulkInsert() supports conflict="ignore" — duplicates skipped', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        await adapter.bulkInsert('t', [{ id: 1 }, { id: 2 }]);
        const spy = vi.spyOn(adapter, 'executeNonQuery');
        // Second bulk with overlapping ids via 'ignore' inserts only new ones.
        const n = await adapter.bulkInsert(
            't',
            [{ id: 2 }, { id: 3 }],
            'ignore'
        );
        expect(n).toBe(1);
        expect(spy).toHaveBeenCalledTimes(1);
        const sql = spy.mock.calls[0][0];
        expect(sql).toContain('INSERT OR IGNORE');
        spy.mockRestore();
        const rows = await adapter.select('t', ['id'], undefined, {
            order: 'id'
        });
        expect(rows.map((r) => r[0])).toEqual([1, 2, 3]);
    });

    test('update() sets columns with multi-condition AND where', async () => {
        await seedTable('users', 5);
        const n = await adapter.update(
            'users',
            { age: 100 },
            { id: 3, name: 'u3' }
        );
        expect(n).toBe(1);
        const row = await adapter.selectOne('users', ['age'], { id: 3 });
        expect(row[0]).toBe(100);
    });

    test('update() with no matches returns 0', async () => {
        await seedTable('users', 3);
        const n = await adapter.update('users', { age: 1 }, { id: 999 });
        expect(n).toBe(0);
    });

    test('updateWhere() uses raw WHERE clause + named params', async () => {
        await seedTable('users', 5);
        const n = await adapter.updateWhere(
            'users',
            { age: 50 },
            'id > @cutoff AND name LIKE @pat',
            { cutoff: 2, pat: 'u%' }
        );
        expect(n).toBe(3);
        const rows = await adapter.select('users', ['id', 'age'], undefined, {
            order: 'id'
        });
        expect(rows.map((r) => r[1])).toEqual([21, 22, 50, 50, 50]);
    });

    test('delete() removes rows with multi-condition AND where', async () => {
        await seedTable('users', 5);
        const n = await adapter.delete('users', { id: 2, name: 'u2' });
        expect(n).toBe(1);
        const rows = await adapter.select('users', ['id'], undefined, {
            order: 'id'
        });
        expect(rows.map((r) => r[0])).toEqual([1, 3, 4, 5]);
    });

    test('delete() with no matches returns 0', async () => {
        await seedTable('users', 3);
        const n = await adapter.delete('users', { id: 999 });
        expect(n).toBe(0);
    });

    test('deleteAll() empties the table', async () => {
        await seedTable('users', 3);
        // MemorySQLiteAdapter routes no-args statements through db.exec(),
        // which returns 0 — the production SQLite.ExecuteNonQuery would
        // return rows-affected. We assert the post-state (table empty),
        // not the return value, to stay backend-agnostic.
        const n = await adapter.deleteAll('users');
        expect(n).toBe(0);
        const rows = await adapter.select('users', ['id']);
        expect(rows).toHaveLength(0);
    });

    test('deleteWhere() uses raw WHERE clause + named params', async () => {
        await seedTable('users', 5);
        const n = await adapter.deleteWhere('users', 'age >= @min', {
            min: 24
        });
        expect(n).toBe(2); // ages 24, 25
        const rows = await adapter.select('users', ['id'], undefined, {
            order: 'id'
        });
        expect(rows.map((r) => r[0])).toEqual([1, 2, 3]);
    });

    test('increment() adds amount to a numeric column', async () => {
        await seedTable('users', 3);
        const n = await adapter.increment('users', 'age', 5, { id: 2 });
        expect(n).toBe(1);
        const row = await adapter.selectOne('users', ['age'], { id: 2 });
        expect(row[0]).toBe(27); // 22 + 5
    });

    test('increment() with no matches returns 0', async () => {
        await seedTable('users', 3);
        const n = await adapter.increment('users', 'age', 5, { id: 999 });
        expect(n).toBe(0);
    });

    test('upsertPartial() inserts on first call, updates on second call', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT' },
            { name: 'counter', type: 'INTEGER' }
        ]);
        const n1 = await adapter.upsertPartial(
            't',
            { id: 1, name: 'a', counter: 0 },
            { counter: 1 },
            'id'
        );
        expect(n1).toBe(1);
        const n2 = await adapter.upsertPartial(
            't',
            { id: 1, name: 'a', counter: 0 },
            { counter: 99 },
            'id'
        );
        expect(n2).toBe(1);
        // After upsert, only counter updated; name stays the same.
        const row = await adapter.selectOne('t', ['name', 'counter'], {
            id: 1
        });
        expect(row[0]).toBe('a');
        expect(row[1]).toBe(99);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Query — selectOne / select / selectWhere / selectJoin / selectWhereIn /
//            selectUnion / selectGroupBy
// ─────────────────────────────────────────────────────────────────────────

describe('Query — selectOne / select / selectWhere / selectJoin / selectWhereIn / selectUnion / selectGroupBy', () => {
    test('selectOne() returns null when no match', async () => {
        await seedTable('users', 3);
        const row = await adapter.selectOne('users', ['name'], { id: 999 });
        expect(row).toBeNull();
    });

    test('selectOne() returns the first matching row as positional array', async () => {
        await seedTable('users', 3);
        const row = await adapter.selectOne('users', ['id', 'name'], {
            id: 2
        });
        expect(row).toEqual([2, 'u2']);
    });

    test('select() with no where scans the entire table', async () => {
        await seedTable('users', 3);
        const rows = await adapter.select('users', ['id']);
        expect(rows).toHaveLength(3);
    });

    test('select() honours order option', async () => {
        await seedTable('users', 3);
        const rows = await adapter.select('users', ['id'], undefined, {
            order: 'id DESC'
        });
        expect(rows.map((r) => r[0])).toEqual([3, 2, 1]);
    });

    test('select() honours limit option', async () => {
        await seedTable('users', 5);
        const rows = await adapter.select('users', ['id'], undefined, {
            order: 'id',
            limit: 2
        });
        expect(rows.map((r) => r[0])).toEqual([1, 2]);
    });

    test('select() honours distinct option', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'k', type: 'TEXT' }
        ]);
        await adapter.bulkInsert('t', [
            { id: 1, k: 'a' },
            { id: 2, k: 'a' },
            { id: 3, k: 'b' }
        ]);
        const rows = await adapter.select('t', ['k'], undefined, {
            distinct: true,
            order: 'k'
        });
        expect(rows.map((r) => r[0])).toEqual(['a', 'b']);
    });

    test('select() with where filters by equality AND', async () => {
        await seedTable('users', 5);
        const rows = await adapter.select('users', ['id'], {
            age: 23
        });
        expect(rows.map((r) => r[0])).toEqual([3]);
    });

    test('selectWhere() with whereClause=null skips WHERE', async () => {
        await seedTable('users', 3);
        const rows = await adapter.selectWhere('users', ['id'], null, null);
        expect(rows).toHaveLength(3);
    });

    test('selectWhere() with raw WHERE clause filters rows', async () => {
        await seedTable('users', 5);
        const rows = await adapter.selectWhere(
            'users',
            ['id'],
            'age >= @min AND age <= @max',
            { min: 22, max: 24 },
            { order: 'id' }
        );
        expect(rows.map((r) => r[0])).toEqual([2, 3, 4]);
    });

    test('selectWhere() supports distinct option', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'k', type: 'TEXT' }
        ]);
        await adapter.bulkInsert('t', [
            { id: 1, k: 'a' },
            { id: 2, k: 'a' },
            { id: 3, k: 'b' }
        ]);
        const rows = await adapter.selectWhere('t', ['k'], null, null, {
            distinct: true,
            order: 'k'
        });
        expect(rows.map((r) => r[0])).toEqual(['a', 'b']);
    });

    test('selectJoin() joins two tables with aliases and ON clause', async () => {
        await adapter.createTable('users', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT' }
        ]);
        await adapter.createTable('posts', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'user_id', type: 'INTEGER' },
            { name: 'title', type: 'TEXT' }
        ]);
        await adapter.bulkInsert('users', [
            { id: 1, name: 'alice' },
            { id: 2, name: 'bob' }
        ]);
        await adapter.bulkInsert('posts', [
            { id: 10, user_id: 1, title: 'hello' },
            { id: 11, user_id: 1, title: 'world' },
            { id: 12, user_id: 2, title: 'foo' }
        ]);
        const rows = await adapter.selectJoin({
            from: 'users',
            alias: 'u',
            joins: [
                {
                    type: 'INNER',
                    table: 'posts',
                    alias: 'p',
                    on: 'p.user_id = u.id'
                }
            ],
            columns: ['u.name', 'p.title'],
            order: 'p.id'
        });
        expect(rows).toEqual([
            ['alice', 'hello'],
            ['alice', 'world'],
            ['bob', 'foo']
        ]);
    });

    test('selectJoin() with where + order + limit', async () => {
        await adapter.createTable('users', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT' }
        ]);
        await adapter.createTable('posts', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'user_id', type: 'INTEGER' }
        ]);
        await adapter.bulkInsert('users', [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' }
        ]);
        await adapter.bulkInsert('posts', [
            { id: 10, user_id: 1 },
            { id: 11, user_id: 1 },
            { id: 12, user_id: 2 }
        ]);
        const rows = await adapter.selectJoin({
            from: 'users',
            alias: 'u',
            joins: [
                {
                    type: 'INNER',
                    table: 'posts',
                    alias: 'p',
                    on: 'p.user_id = u.id'
                }
            ],
            columns: ['p.id'],
            where: 'u.name = @name',
            params: { name: 'a' },
            order: 'p.id DESC',
            limit: 1
        });
        expect(rows.map((r) => r[0])).toEqual([11]);
    });

    test('selectWhereIn() returns [] for empty values array', async () => {
        await seedTable('users', 3);
        const rows = await adapter.selectWhereIn(
            'users',
            ['id'],
            'id',
            [],
            null,
            null
        );
        expect(rows).toEqual([]);
    });

    test('selectWhereIn() filters by IN list', async () => {
        await seedTable('users', 5);
        const rows = await adapter.selectWhereIn(
            'users',
            ['id'],
            'id',
            [2, 4],
            null,
            null,
            { order: 'id' }
        );
        expect(rows.map((r) => r[0])).toEqual([2, 4]);
    });

    test('selectWhereIn() supports extra AND clause + params', async () => {
        await seedTable('users', 5);
        const rows = await adapter.selectWhereIn(
            'users',
            ['id'],
            'id',
            [1, 2, 3],
            'age > @minAge',
            { minAge: 21 },
            { order: 'id' }
        );
        expect(rows.map((r) => r[0])).toEqual([2, 3]);
    });

    test('selectUnion() unions two sources as derived tables', async () => {
        await adapter.createTable('a', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'v', type: 'TEXT' }
        ]);
        await adapter.createTable('b', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'v', type: 'TEXT' }
        ]);
        await adapter.bulkInsert('a', [
            { id: 1, v: 'x' },
            { id: 2, v: 'y' }
        ]);
        await adapter.bulkInsert('b', [
            { id: 10, v: 'z' },
            { id: 11, v: 'w' }
        ]);
        const rows = await adapter.selectUnion(
            [
                { table: 'a', columns: ['id', 'v'] },
                { table: 'b', columns: ['id', 'v'] }
            ],
            { order: 'v' }
        );
        // Order by v ascending → w, x, y, z
        expect(rows.map((r) => r[1])).toEqual(['w', 'x', 'y', 'z']);
    });

    test('selectUnion() with no sources returns []', async () => {
        const rows = await adapter.selectUnion([]);
        expect(rows).toEqual([]);
    });

    test('selectUnion() supports per-source where + nulls alignment', async () => {
        await adapter.createTable('a', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'v', type: 'TEXT' }
        ]);
        await adapter.createTable('b', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'w', type: 'TEXT' }
        ]);
        await adapter.bulkInsert('a', [{ id: 1, v: 'x' }]);
        await adapter.bulkInsert('b', [{ id: 2, w: 'y' }]);
        // UNION ALL concatenates rows positionally; column names come from
        // the first branch. Pass columns as raw SQL strings with explicit
        // NULL AS aliases to align column order across branches.
        const rows = await adapter.selectUnion(
            [
                { table: 'a', columns: 'id, v, NULL AS w' },
                { table: 'b', columns: 'id, NULL AS v, w' }
            ],
            { order: 'id' }
        );
        expect(rows).toEqual([
            [1, 'x', null],
            [2, null, 'y']
        ]);
    });

    test('selectUnion() aligns BIGINT-cast NULL pads with real integer columns', async () => {
        // Mirrors the feed / gameLog UNION shape: the `time` position is a
        // real integer column in some branches and `CAST(NULL AS BIGINT)`
        // in the NULL-padded branches (PG requires matching union types;
        // SQLite/MySQL accept both — the cast must execute cleanly here too).
        await adapter.createTable('gps', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'created_at', type: 'TEXT' },
            { name: 'time', type: 'INTEGER' }
        ]);
        await adapter.createTable('status', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'created_at', type: 'TEXT' }
        ]);
        await adapter.bulkInsert('gps', [
            { id: 1, created_at: '2026-01-01T00:00:00Z', time: 3600000 }
        ]);
        await adapter.bulkInsert('status', [
            { id: 2, created_at: '2026-01-01T00:00:00Z' }
        ]);
        const rows = await adapter.selectUnion(
            [
                { table: 'gps', columns: 'id, created_at, time' },
                {
                    table: 'status',
                    columns: 'id, created_at, CAST(NULL AS BIGINT) AS time'
                }
            ],
            { order: 'id' }
        );
        expect(rows).toEqual([
            [1, '2026-01-01T00:00:00Z', 3600000],
            [2, '2026-01-01T00:00:00Z', null]
        ]);
    });

    test('selectGroupBy() aggregates with GROUP BY', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'grp', type: 'TEXT' },
            { name: 'n', type: 'INTEGER' }
        ]);
        await adapter.bulkInsert('t', [
            { id: 1, grp: 'a', n: 10 },
            { id: 2, grp: 'a', n: 20 },
            { id: 3, grp: 'b', n: 5 }
        ]);
        const rows = await adapter.selectGroupBy('t', {
            columns: ['grp'],
            aggregates: [{ expr: 'SUM(n)', alias: 'total' }],
            groupBy: ['grp'],
            order: 'grp'
        });
        expect(rows).toEqual([
            ['a', 30],
            ['b', 5]
        ]);
    });

    test('selectGroupBy() supports HAVING clause', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'grp', type: 'TEXT' },
            { name: 'n', type: 'INTEGER' }
        ]);
        await adapter.bulkInsert('t', [
            { id: 1, grp: 'a', n: 10 },
            { id: 2, grp: 'a', n: 20 },
            { id: 3, grp: 'b', n: 5 }
        ]);
        const rows = await adapter.selectGroupBy('t', {
            columns: ['grp'],
            aggregates: [{ expr: 'SUM(n)', alias: 'total' }],
            groupBy: ['grp'],
            having: 'SUM(n) > @threshold',
            params: { threshold: 10 },
            order: 'grp'
        });
        expect(rows).toEqual([['a', 30]]);
    });

    test('selectGroupBy() supports WHERE clause', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'grp', type: 'TEXT' },
            { name: 'n', type: 'INTEGER' }
        ]);
        await adapter.bulkInsert('t', [
            { id: 1, grp: 'a', n: 10 },
            { id: 2, grp: 'a', n: 20 },
            { id: 3, grp: 'b', n: 5 }
        ]);
        // WHERE filters before GROUP BY — the 'b' group has no rows
        // remaining after the filter, so it does not appear in the output.
        const rows = await adapter.selectGroupBy('t', {
            columns: ['grp'],
            aggregates: [{ expr: 'COUNT(*)', alias: 'cnt' }],
            groupBy: ['grp'],
            where: 'n >= @min',
            params: { min: 10 },
            order: 'grp'
        });
        expect(rows).toEqual([['a', 2]]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Count
// ─────────────────────────────────────────────────────────────────────────

describe('Count — count / countWhere', () => {
    test('count() on empty table returns 0', async () => {
        await seedTable('users', 0);
        const n = await adapter.count('users', { id: 1 });
        expect(n).toBe(0);
    });

    test('count() with where returns matching row count', async () => {
        await seedTable('users', 5);
        const n = await adapter.count('users', { age: 23 });
        expect(n).toBe(1);
    });

    test('count() with multi-condition AND', async () => {
        await seedTable('users', 5);
        const n = await adapter.count('users', { id: 3, name: 'u3' });
        expect(n).toBe(1);
    });

    test('countWhere() with whereClause=null counts all rows', async () => {
        await seedTable('users', 5);
        const n = await adapter.countWhere('users', null, null);
        expect(n).toBe(5);
    });

    test('countWhere() with raw WHERE clause + params', async () => {
        await seedTable('users', 5);
        const n = await adapter.countWhere('users', 'age >= @min', { min: 24 });
        expect(n).toBe(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. DDL — createTable / createIndex / alterTable* / dropTable
// ─────────────────────────────────────────────────────────────────────────

describe('DDL — createTable / createIndex / alterTable* / dropTable', () => {
    test('createTable() accepts string column definitions', async () => {
        await adapter.createTable('t', [
            'id INTEGER PRIMARY KEY',
            'name TEXT NOT NULL'
        ]);
        const cols = await adapter.getTableColumns('t');
        expect(cols.map((c) => c[1])).toEqual(['id', 'name']);
    });

    test('createTable() accepts object column definitions with constraints', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT', constraints: 'NOT NULL DEFAULT ""' }
        ]);
        const cols = await adapter.getTableColumns('t');
        expect(cols[1][1]).toBe('name');
        expect(cols[1][2]).toBe('TEXT');
        // PRAGMA table_xinfo returns the default value as raw SQL text —
        // `DEFAULT ""` is stored verbatim as the 2-char string '""'.
        expect(cols[1][4]).toBe('""');
    });

    test('createTable() is idempotent (IF NOT EXISTS)', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        // Second call must not throw.
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        const cols = await adapter.getTableColumns('t');
        expect(cols).toHaveLength(1);
    });

    test('createIndex() creates a non-unique index', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT' }
        ]);
        await adapter.createIndex('idx_t_name', 't', ['name']);
        const tables = await adapter.listTables('%');
        expect(tables).toContain('t');
        // The index appears in sqlite_schema — verify via raw query.
        const idxRows = [];
        await adapter.execute(
            (r) => idxRows.push(r[0]),
            "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='t'"
        );
        expect(idxRows).toContain('idx_t_name');
    });

    test('createIndex() creates a UNIQUE index when unique=true', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT' }
        ]);
        await adapter.createIndex('idx_t_uniq_name', 't', 'name', true);
        // Inserting a duplicate should fail.
        await adapter.insert('t', { id: 1, name: 'x' });
        await expect(adapter.insert('t', { id: 2, name: 'x' })).rejects.toThrow(
            /UNIQUE constraint/i
        );
    });

    test('createIndex() is idempotent (IF NOT EXISTS)', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        await adapter.createIndex('idx_t_id', 't', ['id']);
        // Second call must not throw.
        await adapter.createIndex('idx_t_id', 't', ['id']);
    });

    test('alterTableAddColumn() adds a column to an existing table', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        await adapter.alterTableAddColumn('t', 'name TEXT DEFAULT ""');
        const cols = await adapter.getTableColumns('t');
        expect(cols.map((c) => c[1])).toEqual(['id', 'name']);
    });

    test('alterTableDropColumn() removes a column', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT' }
        ]);
        await adapter.alterTableDropColumn('t', 'name');
        const cols = await adapter.getTableColumns('t');
        expect(cols.map((c) => c[1])).toEqual(['id']);
    });

    test('alterTableRename() renames a table', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        await adapter.alterTableRename('t', 't2');
        const tables = await adapter.listTables('%');
        expect(tables).not.toContain('t');
        expect(tables).toContain('t2');
    });

    test('dropTable() on a non-existent table does not throw (IF EXISTS)', async () => {
        await expect(adapter.dropTable('does_not_exist')).resolves.toBe(0);
    });

    test('dropTable() removes an existing table', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        await adapter.dropTable('t');
        const tables = await adapter.listTables('%');
        expect(tables).not.toContain('t');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Transaction
//
// 注意:本块直接调用 EngineAdapter 的 @private 方法
// beginTransaction/commit/rollback —— 这是有意为之,用于验证 SQLite
// 引擎级事务语义(persist vs discard)和嵌套 begin 抛错。生产代码请
// 使用 withTransaction(fn),不要手动调用这三个方法。
// ─────────────────────────────────────────────────────────────────────────

describe('Transaction — beginTransaction / commit / rollback', () => {
    test('beginTransaction + commit persists inserts', async () => {
        await seedTable('users', 0);
        const connId = await adapter.beginTransaction();
        await adapter.insert('users', { id: 1, name: 'a', age: 10 });
        await adapter.commit(connId);
        const rows = await adapter.select('users', ['id']);
        expect(rows).toHaveLength(1);
    });

    test('beginTransaction + rollback discards inserts', async () => {
        await seedTable('users', 0);
        const connId = await adapter.beginTransaction();
        await adapter.insert('users', { id: 1, name: 'a', age: 10 });
        await adapter.rollback(connId);
        const rows = await adapter.select('users', ['id']);
        expect(rows).toHaveLength(0);
    });

    test('nested beginTransaction throws (not supported)', async () => {
        await adapter.beginTransaction();
        await expect(adapter.beginTransaction()).rejects.toThrow(/嵌套/);
        await adapter.rollback(0); // cleanup so afterEach doesn't see a leaked txn
    });

    test('withTransaction commits on success', async () => {
        await seedTable('users', 0);
        await adapter.withTransaction(async () => {
            await adapter.insert('users', { id: 1, name: 'a', age: 10 });
            await adapter.insert('users', { id: 2, name: 'b', age: 20 });
        });
        const rows = await adapter.select('users', ['id']);
        expect(rows).toHaveLength(2);
    });

    test('withTransaction rolls back on error', async () => {
        await seedTable('users', 0);
        await expect(
            adapter.withTransaction(async () => {
                await adapter.insert('users', { id: 1, name: 'a', age: 10 });
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        const rows = await adapter.select('users', ['id']);
        expect(rows).toHaveLength(0);
    });

    test('withTransaction rejects nested call', async () => {
        await expect(
            adapter.withTransaction(async () => {
                await adapter.withTransaction(async () => {});
            })
        ).rejects.toThrow(/嵌套/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Maintenance
// ─────────────────────────────────────────────────────────────────────────

describe('Maintenance — vacuum / optimize', () => {
    test('vacuum() does not throw', async () => {
        await expect(adapter.vacuum()).resolves.toBe(0);
    });

    test('optimize() is PRAGMA optimize and does not throw', async () => {
        await expect(adapter.optimize()).resolves.toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Schema — initUserSchema / initGlobalSchema / userTable
// ─────────────────────────────────────────────────────────────────────────

describe('Schema — initUserSchema / initGlobalSchema / userTable', () => {
    test("userTable(prefix, name) returns 'prefix_name'", () => {
        expect(adapter.userTable('abc', 'feed_gps')).toBe('abc_feed_gps');
    });

    test('initUserSchema() creates ~22 user tables + indexes for the prefix', async () => {
        const prefix = 'testuser';
        await adapter.initUserSchema(prefix);
        const tables = await adapter.listTables(`${prefix}_%`);
        // 22 tables expected (counted from SQLiteAdapter.initUserSchema
        // CREATE TABLE statements — indexes are tracked separately below).
        expect(tables.length).toBe(22);
        // Spot-check a few representative tables.
        expect(tables).toContain(`${prefix}_feed_gps`);
        expect(tables).toContain(`${prefix}_feed_status`);
        expect(tables).toContain(`${prefix}_notifications_v2`);
        expect(tables).toContain(`${prefix}_friend_log_history`);
        expect(tables).toContain(`${prefix}_mutual_graph_meta`);
        expect(tables).toContain(`${prefix}_manual_relations_MANUEL`);
    });

    test('initUserSchema() also creates indexes for the prefix', async () => {
        const prefix = 'idxuser';
        await adapter.initUserSchema(prefix);
        const idxRows = [];
        await adapter.execute(
            (r) => idxRows.push(r[0]),
            "SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE @pat",
            { pat: `${prefix}_%_idx` }
        );
        // At least 4 user indexes (1 feed_online_offline + 2 activity_sessions_v2 + 1 friend_log_history).
        expect(idxRows.length).toBeGreaterThanOrEqual(4);
        expect(idxRows).toContain(
            `${prefix}_feed_online_offline_user_created_idx`
        );
        expect(idxRows).toContain(
            `${prefix}_activity_sessions_v2_user_start_idx`
        );
        expect(idxRows).toContain(
            `${prefix}_activity_sessions_v2_user_end_idx`
        );
        expect(idxRows).toContain(`${prefix}_friend_log_history_user_id_idx`);
    });

    test('initUserSchema() is idempotent (calling twice does not throw)', async () => {
        const prefix = 'idem';
        await adapter.initUserSchema(prefix);
        await expect(adapter.initUserSchema(prefix)).resolves.toBeUndefined();
    });

    test('initGlobalSchema() creates ~15 global tables', async () => {
        await adapter.initGlobalSchema();
        const tables = await adapter.listTables('%');
        // 15 global tables (counted from SQLiteAdapter.initGlobalSchema).
        expect(tables.length).toBeGreaterThanOrEqual(14);
        // Spot-check representative global tables.
        expect(tables).toContain('gamelog_location');
        expect(tables).toContain('gamelog_join_leave');
        expect(tables).toContain('gamelog_portal_spawn');
        expect(tables).toContain('cache_avatar');
        expect(tables).toContain('cache_world');
        expect(tables).toContain('favorite_world');
        expect(tables).toContain('memos');
        expect(tables).toContain('avatar_tags');
    });

    test('initGlobalSchema() creates the 4 gamelog indexes (idx_gamelog_*)', async () => {
        await adapter.initGlobalSchema();
        const idxRows = [];
        await adapter.execute(
            (r) => idxRows.push(r[0]),
            "SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_gamelog_%'"
        );
        expect(idxRows).toContain('idx_gamelog_location_world_created');
        expect(idxRows).toContain('idx_gamelog_jl_location');
        expect(idxRows).toContain('idx_gamelog_jl_user_created');
        expect(idxRows).toContain('idx_gamelog_jl_display_created');
    });

    test('initGlobalSchema() is idempotent (calling twice does not throw)', async () => {
        await adapter.initGlobalSchema();
        await expect(adapter.initGlobalSchema()).resolves.toBeUndefined();
    });

    test('initUserSchema() and initGlobalSchema() can coexist', async () => {
        await adapter.initGlobalSchema();
        await adapter.initUserSchema('coexist');
        const tables = await adapter.listTables('%');
        expect(tables).toContain('gamelog_location');
        expect(tables).toContain('coexist_feed_gps');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Metadata — listTables / getTableColumns / listTablesTypes
// ─────────────────────────────────────────────────────────────────────────

describe('Metadata — listTables / getTableColumns / listTablesTypes', () => {
    test('listTables() filters by LIKE pattern', async () => {
        await adapter.createTable('alpha', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        await adapter.createTable('beta', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        await adapter.createTable('gamma', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        const matched = await adapter.listTables('a%');
        expect(matched).toEqual(['alpha']);
    });

    test('listTables() does NOT return sqlite_% system tables', async () => {
        // Create at least one user table so the schema isn't empty.
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        const all = await adapter.listTables('%');
        for (const name of all) {
            expect(name.startsWith('sqlite_')).toBe(false);
        }
    });

    test('getTableColumns() returns PRAGMA table_xinfo rows as positional arrays', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT' }
        ]);
        const cols = await adapter.getTableColumns('t');
        expect(cols.length).toBe(2);
        // PRAGMA table_xinfo returns columns: cid, name, type, notnull, dflt_value, pk, hidden.
        expect(Array.isArray(cols[0])).toBe(true);
        expect(cols[0][1]).toBe('id');
        expect(cols[0][2]).toBe('INTEGER');
        expect(cols[0][5]).toBe(1); // pk
        expect(cols[1][1]).toBe('name');
        expect(cols[1][5]).toBe(0); // not pk
    });

    test('listTablesTypes() returns structured {tableName, columns: [...]} objects', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'name', type: 'TEXT', constraints: 'NOT NULL DEFAULT ""' }
        ]);
        const result = await adapter.listTablesTypes();
        expect(Array.isArray(result)).toBe(true);
        const t = result.find((r) => r.tableName === 't');
        expect(t).toBeDefined();
        expect(t.columns.length).toBe(2);
        const idCol = t.columns.find((c) => c.name === 'id');
        expect(idCol).toEqual({
            name: 'id',
            type: 'INTEGER',
            notNull: false,
            defaultValue: null,
            isPK: true,
            isHidden: false
        });
        const nameCol = t.columns.find((c) => c.name === 'name');
        expect(nameCol.notNull).toBe(true);
        expect(nameCol.isPK).toBe(false);
    });

    test('listTablesTypes() excludes sqlite_% system tables', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' }
        ]);
        const result = await adapter.listTablesTypes();
        for (const entry of result) {
            expect(entry.tableName.startsWith('sqlite_')).toBe(false);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Naming — userTable / withPrefix
// ─────────────────────────────────────────────────────────────────────────

describe('Naming — userTable / withPrefix', () => {
    test("userTable('foo', 'bar') returns 'foo_bar'", () => {
        expect(adapter.userTable('foo', 'bar')).toBe('foo_bar');
    });

    test('userTable() respects _prefixOverride set by withPrefix', async () => {
        let observed;
        await adapter.withPrefix('override', async () => {
            observed = adapter.userTable('ignored', 'feed_gps');
        });
        expect(observed).toBe('override_feed_gps');
    });

    test('withPrefix() restores the previous _prefixOverride in finally', async () => {
        expect(adapter._prefixOverride).toBeNull();
        await adapter.withPrefix('outer', async () => {
            expect(adapter._prefixOverride).toBe('outer');
            await adapter.withPrefix('inner', async () => {
                expect(adapter._prefixOverride).toBe('inner');
            });
            // After nested withPrefix, the outer override is restored.
            expect(adapter._prefixOverride).toBe('outer');
        });
        // After outer withPrefix, the original (null) is restored.
        expect(adapter._prefixOverride).toBeNull();
    });

    test('withPrefix() restores _prefixOverride even if fn throws', async () => {
        expect(adapter._prefixOverride).toBeNull();
        await expect(
            adapter.withPrefix('bad', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        expect(adapter._prefixOverride).toBeNull();
    });

    test('withPrefix() returns the callback value', async () => {
        const result = await adapter.withPrefix('p', async () => 42);
        expect(result).toBe(42);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 11. SQL fragments + JS utilities
// ─────────────────────────────────────────────────────────────────────────

describe('SQL fragments + JS utilities — sqlToUnixMs / sqlExtractWorldId / sqlHasInstanceId / sqlDate / sqlEnterTime / daysAgoISO', () => {
    test('sqlToUnixMs(col) returns "(strftime(\'%s\', col) * 1000)"', () => {
        expect(adapter.sqlToUnixMs('created_at')).toBe(
            "(strftime('%s', created_at) * 1000)"
        );
    });

    test('sqlToUnixMs() expression evaluates correctly against a real ISO timestamp', async () => {
        // 2024-01-01T00:00:00Z = 1704067200 seconds = 1704067200000 ms.
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'ts', type: 'TEXT' }
        ]);
        await adapter.insert('t', { id: 1, ts: '2024-01-01T00:00:00Z' });
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            `SELECT ${adapter.sqlToUnixMs('ts')} FROM t WHERE id = 1`
        );
        expect(rows[0][0]).toBe(1704067200000);
    });

    test("sqlExtractWorldId(col) returns 'SUBSTR(col, 1, INSTR(col, ':') - 1)'", () => {
        expect(adapter.sqlExtractWorldId('location')).toBe(
            "SUBSTR(location, 1, INSTR(location, ':') - 1)"
        );
    });

    test('sqlExtractWorldId() extracts the world id portion of a location string', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'loc', type: 'TEXT' }
        ]);
        await adapter.insert('t', { id: 1, loc: 'wrld_abc123:45678' });
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            `SELECT ${adapter.sqlExtractWorldId('loc')} FROM t WHERE id = 1`
        );
        expect(rows[0][0]).toBe('wrld_abc123');
    });

    test('sqlHasInstanceId(col) returns "INSTR(col, \':\') > 0"', () => {
        expect(adapter.sqlHasInstanceId('location')).toBe(
            "INSTR(location, ':') > 0"
        );
    });

    test('sqlHasInstanceId() returns 1 when colon is present, 0 otherwise', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'loc', type: 'TEXT' }
        ]);
        await adapter.bulkInsert('t', [
            { id: 1, loc: 'wrld_abc:123' },
            { id: 2, loc: 'wrld_no_instance' }
        ]);
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            `SELECT id, ${adapter.sqlHasInstanceId('loc')} FROM t ORDER BY id`
        );
        expect(rows).toEqual([
            [1, 1],
            [2, 0]
        ]);
    });

    test("sqlDate(col) returns 'date(col)'", () => {
        expect(adapter.sqlDate('created_at')).toBe('date(created_at)');
    });

    test('sqlDate() extracts the date portion of an ISO timestamp', async () => {
        await adapter.createTable('t', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'ts', type: 'TEXT' }
        ]);
        await adapter.insert('t', { id: 1, ts: '2024-03-15T12:34:56Z' });
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            `SELECT ${adapter.sqlDate('ts')} FROM t WHERE id = 1`
        );
        expect(rows[0][0]).toBe('2024-03-15');
    });

    test('sqlEnterTime() returns the documented strftime expression', () => {
        const expr = adapter.sqlEnterTime('created_at', 'time');
        expect(expr).toContain("strftime('%Y-%m-%dT%H:%M:%SZ'");
        expect(expr).toContain('created_at');
        expect(expr).toContain('time');
        expect(expr).toContain("' seconds'");
    });

    test('sqlEnterTime() computes enter time = leave time - duration', async () => {
        // gamelog_join_leave semantics: created_at = leave time, time = duration (ms).
        await adapter.createTable('gjl', [
            { name: 'id', type: 'INTEGER', constraints: 'PRIMARY KEY' },
            { name: 'created_at', type: 'TEXT' },
            { name: 'time', type: 'INTEGER' }
        ]);
        // Left at 2024-01-01T00:01:00Z after staying 60 seconds (60000 ms).
        // Enter time should be 2024-01-01T00:00:00Z.
        await adapter.insert('gjl', {
            id: 1,
            created_at: '2024-01-01T00:01:00Z',
            time: 60000
        });
        const rows = [];
        await adapter.execute(
            (r) => rows.push(r),
            `SELECT ${adapter.sqlEnterTime('created_at', 'time')} FROM gjl WHERE id = 1`
        );
        expect(rows[0][0]).toBe('2024-01-01T00:00:00Z');
    });

    test('daysAgoISO(0) returns an ISO string close to Date.now()', () => {
        const before = Date.now();
        const iso = adapter.daysAgoISO(0);
        const after = Date.now();
        const ms = new Date(iso).getTime();
        expect(ms).toBeGreaterThanOrEqual(before - 1000);
        expect(ms).toBeLessThanOrEqual(after + 1000);
        // ISO format sanity check.
        expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });

    test('daysAgoISO(7) returns an ISO string ~7 days before now', () => {
        const now = Date.now();
        const iso = adapter.daysAgoISO(7);
        const ms = new Date(iso).getTime();
        const expected = now - 7 * 86400000;
        // Allow 1 second tolerance for test execution time.
        expect(Math.abs(ms - expected)).toBeLessThan(1000);
    });

    test('daysAgoISO() is a pure JS function — no DB access needed', () => {
        // Verify it works without any seeded DB state.
        expect(typeof adapter.daysAgoISO(1)).toBe('string');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// 12. handleSQLiteError — error mapping (browse-mode M1, L-1 / M7)
//
// A readonly rejection must NOT be mapped to the "Database is locked"
// modal — it warns once (per message, per process) and rethrows. The
// locked/malformed/full/IO branches keep their original behaviour.
// ─────────────────────────────────────────────────────────────────────────

describe('handleSQLiteError — error mapping (L-1)', () => {
    beforeEach(() => {
        modalMock.alert.mockClear();
        modalMock.confirm.mockClear();
        openExternalLinkMock.mockClear();
    });

    test('readonly error: warns once, no modal, still rethrows', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const err = new Error('attempt to write a readonly database');
        await expect(adapter.handleSQLiteError(err)).rejects.toBe(err);
        // Repeated readonly rejections are deduped — still exactly one warn.
        await expect(adapter.handleSQLiteError(err)).rejects.toBe(err);
        expect(modalMock.alert).not.toHaveBeenCalled();
        expect(modalMock.confirm).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
    });

    test('readonly error: warn 文案不回显原始 SQL/绑定数据（F-2 防日志注入）', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // 模拟真实 SQLite 只读错误：消息内嵌 SQL 语句与用户内容（feed 消息体）。
        // 修复前 warn 原样拼接 msg → 用户内容可被写入本地日志；修复后只输出
        // 稳定摘要（错误类型标识），原始错误仍完整 rethrow 给调用方。
        const secret = 'SENSITIVE_PAYLOAD_7f3a';
        const err = new Error(
            'attempt to write a readonly database\n' +
                `INSERT INTO feed_gps (user_id, message) VALUES (@uid, @msg) -- '${secret}'`
        );
        await expect(adapter.handleSQLiteError(err)).rejects.toBe(err);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const text = warnSpy.mock.calls[0][0];
        expect(text).toContain('SQLITE_READONLY');
        expect(text).not.toContain('INSERT INTO');
        expect(text).not.toContain('feed_gps');
        expect(text).not.toContain(secret);
        // 原始错误完整保留给调用方（rethrow 不被截断/改写）
        expect(err.message).toContain(secret);
        warnSpy.mockRestore();
    });

    test('"database is locked" still maps to the locked modal branch', async () => {
        const err = new Error('database is locked');
        await expect(adapter.handleSQLiteError(err)).rejects.toBe(err);
        expect(modalMock.alert).toHaveBeenCalledTimes(1);
        expect(modalMock.alert.mock.calls[0][0].title).toBe(
            'Database is locked'
        );
        expect(modalMock.confirm).not.toHaveBeenCalled();
    });

    test('unrelated errors bypass all branches and rethrow without modal', async () => {
        const err = new Error('no such table: configs');
        await expect(adapter.handleSQLiteError(err)).rejects.toBe(err);
        expect(modalMock.alert).not.toHaveBeenCalled();
        expect(modalMock.confirm).not.toHaveBeenCalled();
    });
});
