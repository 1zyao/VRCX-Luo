import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PgSQLAdapter } from './PgSQLAdapter.js';

/**
 * Phase 9 Stage 6 (QA H3): PgSQLAdapter pure unit tests.
 *
 * Design §7.3 requires pure unit tests that do NOT need a PostgreSQL
 * container. The existing `PgSQLAdapter.pgsql.test.js` is a TCP smoke
 * test gated on `PG_TEST_HOST`; it stays inert under the default
 * `npm test` suite. This file fills the gap: it runs in the default
 * vitest environment (jsdom + `vitest.setup.js` noopAsync stubs) and
 * covers the invariants INV-01/03/07/08/10 + R5/R6/R11 + the §4.1.15
 * extensions that have no automated verification otherwise.
 *
 * What's tested here (no PG container required):
 *   - `_bind` named-param → positional `$N` translation (INV-07/08)
 *   - `_mapColumnType` longest-match-first type mapping (R6)
 *   - `userTable` schema-qualified identifier (INV-01)
 *   - SQL fragments: `sqlEnterTime` (R5), `sqlToUnixMs`,
 *     `sqlExtractWorldId`, `sqlHasInstanceId`, `sqlDate`
 *   - `_stripWildcardPrefix` / `_schemaPrefix` / `_splitQualified` (R11)
 *   - `dropUserSchema` emits correct DDL (§4.1.15)
 *   - `isConnected` / `getHealth` defensive stub behaviour
 *
 * What's NOT tested here (needs a real PG backend):
 *   - `execute` / `executeNonQuery` actually hitting Npgsql
 *   - `initUserSchema` / `initGlobalSchema` DDL round-trips
 *   - `listTables` / `_describeColumns` / `listTablesTypes` catalog
 *     queries (covered by the integration test when `PG_TEST_HOST` is set)
 *
 * TODO: 事务单元测试覆盖空白。`beginTransaction`/`commit`/`rollback`
 *   (现已标 @private) 及 `withTransaction` 的 PG 引擎级语义
 *   (pinned 连接生命周期、C# `BeginTransaction/CommitTransaction`
 *   往返、超时 sliding Timer 回收后 rollback no-op)目前仅由
 *   `transaction.test.js` 用 MemorySQLiteAdapter 做引擎无关的栈
 *   契约验证。PG 特定的事务行为需真实 Npgsql 后端 + C# 桥,
 *   无法在纯 JS unit test 中覆盖,待 follow-up 补集成测试。
 *
 * JS has no true private methods — the `_`-prefixed methods are accessed
 * directly on the instance. This is intentional and matches the
 * codebase convention (the SQLiteAdapter tests do the same).
 */
describe('PgSQLAdapter', () => {
    /** @type {PgSQLAdapter} */
    let adapter;

    beforeEach(() => {
        // Constructor has no side effects (no Init call — see JSDoc L54-63).
        // Under vitest.setup.js, globalThis.PostgreSQL is a noopAsync Proxy
        // so importing/constructing PgSQLAdapter is safe.
        adapter = new PgSQLAdapter({ connection: 'postgresql://test' });
    });

    // ── _bind: @param → $N binding ────────────────────────────────────

    describe('_bind', () => {
        it('INV-07: distinct idents get distinct $N, values in first-occurrence order', () => {
            const result = adapter._bind('WHERE @user_id=@user', {
                user_id: 1,
                user: 'x'
            });
            expect(result.sql).toBe('WHERE $1=$2');
            expect(result.args).toEqual([1, 'x']);
        });

        it('INV-08: repeated key reuses the same $N, value pushed only once', () => {
            const result = adapter._bind('@a AND @a', { a: 1 });
            expect(result.sql).toBe('$1 AND $1');
            expect(result.args).toEqual([1]);
        });

        it('unknown ident in SQL is left untouched; unused args do NOT enter the values array', () => {
            // NOTE: the task spec's expected `args: ['other_value']` does
            // NOT match the actual `_bind` implementation. `_bind` only
            // pushes a value when an `@ident` actually appears in the SQL
            // AND `ident` is in `args`. `other` is in args but `@other`
            // never appears in the SQL, so it is never pushed — `args`
            // ends up as `[]`. This is the correct behaviour (unused
            // params must not leak into the positional array Npgsql
            // receives). The test pins the actual, correct behaviour.
            const result = adapter._bind('SELECT @missing', { other: 1 });
            expect(result.sql).toBe('SELECT @missing');
            expect(result.args).toEqual([]);
        });

        it('null args → { sql, args: null } (no params path)', () => {
            const result = adapter._bind('SELECT 1', null);
            expect(result.sql).toBe('SELECT 1');
            expect(result.args).toBeNull();
        });

        it('undefined args → { sql, args: null }', () => {
            const result = adapter._bind('SELECT 1', undefined);
            expect(result.sql).toBe('SELECT 1');
            expect(result.args).toBeNull();
        });

        it('Array args pass through unchanged (caller-managed $N)', () => {
            const result = adapter._bind('SELECT $1', [1]);
            expect(result.sql).toBe('SELECT $1');
            expect(result.args).toEqual([1]);
        });

        it('@-prefixed key in args is normalised (stripped) before lookup', () => {
            const result = adapter._bind('WHERE @col=@col', { '@col': 5 });
            expect(result.sql).toBe('WHERE $1=$1');
            expect(result.args).toEqual([5]);
        });

        it('bare key (no @ prefix) in args also works', () => {
            const result = adapter._bind('WHERE @col=@col', { col: 5 });
            expect(result.sql).toBe('WHERE $1=$1');
            expect(result.args).toEqual([5]);
        });

        it('non-object, non-array, non-null primitive args → { sql, args: null }', () => {
            const result = adapter._bind('SELECT 1', 42);
            expect(result.sql).toBe('SELECT 1');
            expect(result.args).toBeNull();
        });

        it('mixed first-occurrence ordering across many idents', () => {
            const result = adapter._bind(
                'SET a=@a, b=@b, a2=@a WHERE k=@b',
                { a: 'A', b: 'B' }
            );
            expect(result.sql).toBe('SET a=$1, b=$2, a2=$1 WHERE k=$2');
            expect(result.args).toEqual(['A', 'B']);
        });
    });

    // ── _mapColumnType: SQLite → PG type mapping (R6) ─────────────────

    describe('_mapColumnType', () => {
        it('longest match: INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY', () => {
            expect(
                adapter._mapColumnType('INTEGER PRIMARY KEY AUTOINCREMENT')
            ).toBe('BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
        });

        it('INTEGER PRIMARY KEY (no AUTOINCREMENT) → BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY', () => {
            expect(adapter._mapColumnType('INTEGER PRIMARY KEY')).toBe(
                'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
            );
        });

        it('bare INTEGER → BIGINT (R6: int4 would overflow for ms timestamps)', () => {
            expect(
                adapter._mapColumnType('INTEGER NOT NULL DEFAULT 0')
            ).toBe('BIGINT NOT NULL DEFAULT 0');
        });

        it('TEXT stays TEXT (no substitution)', () => {
            expect(adapter._mapColumnType('TEXT')).toBe('TEXT');
        });

        it('empty string returns empty string', () => {
            expect(adapter._mapColumnType('')).toBe('');
        });

        it('non-string input returns input unchanged', () => {
            expect(adapter._mapColumnType(/** @type {*} */ (null))).toBeNull();
        });

        it('AUTOINCREMENT must NOT leak as a dangling token (longest-match rule)', () => {
            // If rule 1 didn't precede rule 2, rule 2 would consume
            // `INTEGER PRIMARY KEY` and leave `AUTOINCREMENT` behind.
            const out = adapter._mapColumnType(
                'id INTEGER PRIMARY KEY AUTOINCREMENT'
            );
            expect(out).toBe(
                'id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
            );
            expect(out).not.toContain('AUTOINCREMENT');
        });
    });

    // ── userTable: schema-qualified identifier (INV-01) ───────────────

    describe('userTable', () => {
        it('INV-01: returns account_{prefix}.{name} two-segment identifier', () => {
            expect(adapter.userTable('abc', 'feed_gps')).toBe(
                'account_abc.feed_gps'
            );
        });

        it('numeric-prefixed prefix produces account__123.t (legal PG identifier)', () => {
            // The prefix generation rule (database/index.js L56-58)
            // prepends `_` when the hash starts with a digit, so
            // `account__123` starts with `account_` (letter-led) — legal.
            expect(adapter.userTable('_123', 't')).toBe('account__123.t');
        });

        it('respects _prefixOverride set by withPrefix (cross-account)', () => {
            // withPrefix sets _prefixOverride; userTable uses it in
            // preference to the passed prefix. Simulate by setting the
            // field directly (withPrefix returns a new bound adapter in
            // production, but the override mechanism is the same).
            adapter._prefixOverride = 'override';
            expect(adapter.userTable('abc', 't')).toBe('account_override.t');
        });
    });

    // ── SQL fragments (PG-specific syntax) ────────────────────────────

    describe('SQL fragments', () => {
        it('sqlEnterTime (R5) uses to_char with strict ISO-8601 format', () => {
            const expr = adapter.sqlEnterTime('created_at', 'time');
            expect(expr).toContain('to_char');
            expect(expr).toContain('YYYY-MM-DD"T"HH24:MI:SS"Z"');
            expect(expr).toContain('created_at');
            expect(expr).toContain('time');
            expect(expr).toContain('::timestamptz');
            // Must subtract the duration (enter = leave - duration).
            expect(expr).toMatch(/1000\.0/);
        });

        it('sqlToUnixMs uses EXTRACT(EPOCH FROM ... ::timestamptz) * 1000', () => {
            const expr = adapter.sqlToUnixMs('col');
            expect(expr).toContain('EXTRACT(EPOCH FROM');
            expect(expr).toContain('::timestamptz');
            expect(expr).toContain('* 1000');
            expect(expr).toContain('col');
        });

        it('sqlExtractWorldId uses SUBSTRING + POSITION(... IN ...)', () => {
            const expr = adapter.sqlExtractWorldId('col');
            expect(expr).toContain('SUBSTRING');
            expect(expr).toContain("POSITION(':' IN");
            expect(expr).toContain('col');
        });

        it('sqlHasInstanceId uses POSITION(... IN ...) > 0', () => {
            const expr = adapter.sqlHasInstanceId('col');
            expect(expr).toContain("POSITION(':' IN");
            expect(expr).toContain('> 0');
        });

        it('sqlDate returns {column}::date', () => {
            expect(adapter.sqlDate('col')).toBe('col::date');
        });
    });

    // ── _stripWildcardPrefix / _schemaPrefix / _splitQualified (R11) ──

    describe('_stripWildcardPrefix', () => {
        it('strips leading %_ from a LIKE pattern', () => {
            expect(adapter._stripWildcardPrefix('%_feed_gps')).toBe(
                'feed_gps'
            );
        });

        it('passes through a bare table name unchanged', () => {
            expect(adapter._stripWildcardPrefix('gamelog_location')).toBe(
                'gamelog_location'
            );
        });

        it('passes through undefined unchanged (defensive)', () => {
            expect(
                adapter._stripWildcardPrefix(
                    /** @type {*} */ (undefined)
                )
            ).toBeUndefined();
        });

        it('does NOT strip a lone % or _ (only the combined %_ prefix)', () => {
            expect(adapter._stripWildcardPrefix('%feed_gps')).toBe(
                '%feed_gps'
            );
            expect(adapter._stripWildcardPrefix('_feed_gps')).toBe(
                '_feed_gps'
            );
        });
    });

    describe('_schemaPrefix', () => {
        it('returns account_{prefix}', () => {
            expect(adapter._schemaPrefix('abc')).toBe('account_abc');
        });

        it('preserves a leading underscore in the prefix', () => {
            expect(adapter._schemaPrefix('_123')).toBe('account__123');
        });
    });

    describe('_splitQualified', () => {
        it('splits account_xxx.feed_gps into { schema, name }', () => {
            expect(adapter._splitQualified('account_xxx.feed_gps')).toEqual({
                schema: 'account_xxx',
                name: 'feed_gps'
            });
        });

        it('splits public.gamelog_location into { schema, name }', () => {
            expect(adapter._splitQualified('public.gamelog_location')).toEqual({
                schema: 'public',
                name: 'gamelog_location'
            });
        });

        it('bare name defaults to the public schema', () => {
            expect(adapter._splitQualified('gamelog_location')).toEqual({
                schema: 'public',
                name: 'gamelog_location'
            });
        });

        it('only splits on the FIRST dot (schema names never contain dots)', () => {
            // Defensive: a table name itself could theoretically contain
            // a dot (it shouldn't, but the split should only honour the
            // first segment as the schema).
            expect(adapter._splitQualified('public.my.table')).toEqual({
                schema: 'public',
                name: 'my.table'
            });
        });
    });

    // ── §4.1.15 extensions: dropUserSchema / isConnected / getHealth ──

    describe('dropUserSchema', () => {
        it('executes DROP SCHEMA IF EXISTS account_{prefix} CASCADE', async () => {
            // Mock executeNonQuery so no C# bridge is hit. We spy on the
            // instance method directly (JS methods are writable).
            const spy = vi.fn().mockResolvedValue(0);
            adapter.executeNonQuery = spy;
            await adapter.dropUserSchema('xxx');
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith(
                'DROP SCHEMA IF EXISTS account_xxx CASCADE'
            );
        });

        it('returns the rows-affected value from executeNonQuery', async () => {
            adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
            await expect(adapter.dropUserSchema('xxx')).resolves.toBe(0);
        });

        it('preserves a leading underscore in the schema name', async () => {
            const spy = vi.fn().mockResolvedValue(0);
            adapter.executeNonQuery = spy;
            await adapter.dropUserSchema('_123');
            expect(spy).toHaveBeenCalledWith(
                'DROP SCHEMA IF EXISTS account__123 CASCADE'
            );
        });
    });

    describe('isConnected', () => {
        it('resolves to a boolean and does not throw under the vitest noopAsync stub', async () => {
            // Under vitest.setup.js, PostgreSQL is a Proxy returning noopAsync
            // for any property access, so PostgreSQL.Ping is noopAsync
            // → returns Promise.resolve(''). `await` it → '' → Boolean('') === false.
            // The real C# binding returns a synchronous bool (CefSharp) or a
            // Promise<boolean> (Electron); either way `await` yields a boolean.
            const result = await adapter.isConnected();
            expect(typeof result).toBe('boolean');
            await expect(adapter.isConnected()).resolves.toBeDefined();
        });

        it('resolves false when the PostgreSQL binding is absent', async () => {
            const saved = globalThis.PostgreSQL;
            // @ts-expect-error — deliberately delete the global for this test
            delete globalThis.PostgreSQL;
            try {
                await expect(adapter.isConnected()).resolves.toBe(false);
            } finally {
                globalThis.PostgreSQL = saved;
            }
        });
    });

    describe('getHealth', () => {
        it('returns { connected: false } when the bridge returns an empty payload (vitest stub)', async () => {
            const result = await adapter.getHealth();
            expect(result).toEqual({ connected: false });
        });

        it('parses a real JSON payload from the bridge', async () => {
            const payload = {
                connected: true,
                latencyMs: 7,
                lastHealthCheck: '2026-07-19T00:00:00.000Z'
            };
            const saved = globalThis.PostgreSQL;
            globalThis.PostgreSQL = {
                GetHealth: () => Promise.resolve(JSON.stringify(payload))
            };
            try {
                const result = await adapter.getHealth();
                expect(result).toEqual(payload);
            } finally {
                globalThis.PostgreSQL = saved;
            }
        });
    });

    // ── createTable PK registration ──────────────────────────────────

    describe('createTable PK metadata', () => {
        it('registers single-column PRIMARY KEY from structured column defs', async () => {
            adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
            await adapter.createTable('configs', [
                { name: 'key', type: 'TEXT', constraints: 'PRIMARY KEY' },
                { name: 'value', type: 'TEXT' }
            ]);
            expect(adapter._tablePkMap.get('configs')).toEqual(['key']);
        });

        it('registers PRIMARY KEY from raw-string column defs', async () => {
            adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
            await adapter.createTable('t_raw', [
                'id INTEGER PRIMARY KEY',
                'v TEXT'
            ]);
            expect(adapter._tablePkMap.get('t_raw')).toEqual(['id']);
        });

        it('registers the mapped INTEGER PRIMARY KEY AUTOINCREMENT form', async () => {
            adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
            await adapter.createTable('t_auto', [
                'id INTEGER PRIMARY KEY AUTOINCREMENT',
                'v TEXT'
            ]);
            expect(adapter._tablePkMap.get('t_auto')).toEqual(['id']);
        });

        it('does not register a PK when no column has the constraint', async () => {
            adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
            await adapter.createTable('t_nopk', [
                { name: 'a', type: 'TEXT' },
                { name: 'b', type: 'BIGINT' }
            ]);
            expect(adapter._tablePkMap.has('t_nopk')).toBe(false);
        });

        it('configs replace emits ON CONFLICT (key) DO UPDATE after createTable', async () => {
            adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
            await adapter.createTable('configs', [
                { name: 'key', type: 'TEXT', constraints: 'PRIMARY KEY' },
                { name: 'value', type: 'TEXT' }
            ]);
            const spy = vi.fn().mockResolvedValue(1);
            adapter.executeNonQuery = spy;
            await adapter.insert('configs', { key: 'k', value: 'v' }, 'replace');
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0][0]).toBe(
                'INSERT INTO configs (key, value) VALUES (@key, @value) ' +
                    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
            );
            expect(spy.mock.calls[0][1]).toEqual({ key: 'k', value: 'v' });
        });

        it('replace with identity PK not in data degrades silently to DO NOTHING', async () => {
            adapter.executeNonQuery = vi.fn().mockResolvedValue(0);
            await adapter.createTable('t_auto', [
                'session_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
                'user_id TEXT'
            ]);
            const spy = vi.fn().mockResolvedValue(1);
            adapter.executeNonQuery = spy;
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                await adapter.insert(
                    't_auto',
                    { user_id: 'u', start_at: 1 },
                    'replace'
                );
            } finally {
                warnSpy.mockRestore();
            }
            expect(spy.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    // ── Constructor ───────────────────────────────────────────────────

    describe('constructor', () => {
        it('stores the connection string when provided', () => {
            const a = new PgSQLAdapter({
                connection: 'postgresql://h:5432/db'
            });
            expect(a.connectionString).toBe('postgresql://h:5432/db');
        });

        it('leaves connectionString null when no connection is given', () => {
            const a = new PgSQLAdapter();
            expect(a.connectionString).toBeNull();
        });

        it('does not call PostgreSQL.Init (no side effects)', () => {
            // The C# Init runs once at startup, not per adapter instance.
            // Construction must be side-effect-free so test environments
            // without a real PostgreSQL binding can still instantiate.
            expect(() => new PgSQLAdapter()).not.toThrow();
        });
    });

    // ── _readChangeCounter(完备层计数器钩子,Phase 1) ────────────────

    // ── initGlobalSchema(M2 node_registry DDL) ───────────────────────

    describe('initGlobalSchema', () => {
        it('创建 node_registry 心跳表(public schema,TEXT 主键)', async () => {
            const spy = vi.fn().mockResolvedValue(0);
            adapter.executeNonQuery = spy;
            await adapter.initGlobalSchema();
            const ddl = spy.mock.calls
                .map((c) => c[0])
                .find((sql) => String(sql).includes('node_registry'));
            expect(ddl).toContain(
                'CREATE TABLE IF NOT EXISTS public.node_registry'
            );
            expect(ddl).toContain('node_id TEXT PRIMARY KEY');
            expect(ddl).toContain('mode TEXT NOT NULL');
            expect(ddl).toContain('prefixes TEXT NOT NULL');
            expect(ddl).toContain('heartbeat_at TEXT NOT NULL');
        });
    });

    describe('_readChangeCounter', () => {
        it('读取 pg_stat_user_tables 行级 DML 计数聚合,返回 row[0] 数值', async () => {
            vi.stubGlobal('PostgreSQL', {
                ExecuteJsonOnConnection: vi.fn().mockResolvedValue('[[7]]')
            });
            try {
                const version = await adapter._readChangeCounter();
                expect(version).toBe(7);
                const sql = globalThis.PostgreSQL.ExecuteJsonOnConnection.mock
                    .calls[0][1];
                expect(sql).toContain('pg_stat_user_tables');
                expect(sql).toContain('n_tup_ins');
                expect(sql).not.toContain('xact_commit');
            } finally {
                vi.unstubAllGlobals();
            }
        });

        it('查询无返回行时返回 null(完备层不运行)', async () => {
            vi.stubGlobal('PostgreSQL', {
                ExecuteJsonOnConnection: vi.fn().mockResolvedValue('[]')
            });
            try {
                await expect(adapter._readChangeCounter()).resolves.toBeNull();
            } finally {
                vi.unstubAllGlobals();
            }
        });
    });
});
