import { describe, it, expect, afterEach } from 'vitest';

import {
    initAdapter,
    createAdapter,
    adapter,
    SQLiteAdapter,
    downgradeToReadOnly
} from './index.js';

/**
 * Stage 3 (dynamic import 404 fix): `adapter/index.js` unit tests.
 *
 * The `_engineSpec` table was changed from variable-path
 * `{ path }` entries to literal-path loader functions
 * (`load: () => import('./XxxAdapter.js')`) so Rolldown can statically
 * resolve the dynamic imports and emit real on-demand chunks instead of
 * a runtime network-fetch fallback that 404s in the packaged app.
 *
 * These tests pin the observable contract of `initAdapter` /
 * `createAdapter` / the `adapter` live binding under vitest:
 *   - postgresql / mysql / mariadb init swap the exported `adapter`
 *     singleton to the lazy-loaded engine adapter;
 *   - sqlite mode stays synchronous and never touches the loaders;
 *   - concurrent same-mode calls share the in-flight init promise;
 *   - createAdapter resolves schemes through the same `_engineSpec`
 *     table with identical error messages.
 *
 * Under `vitest.setup.js`, `PostgreSQL` / `MySQL` are noopAsync Proxy
 * globals, so lazy-importing and constructing PgSQLAdapter /
 * MySQLAdapter is safe and side-effect-free.
 *
 * NOTE: `adapter` is an ESM live binding — its value changes whenever
 * `initAdapter` switches mode. `afterEach` resets the singleton back to
 * sqlite so tests never observe a leaked engine instance.
 */

// 轻量假 PgSQLAdapter — 仅用于"短路路径门禁"测试 (MEDIUM-3, qa): 该用例
// 经 vi.doMock 替换懒加载模块, 不依赖 1760 行的真实 PgSQLAdapter.js。
class FakePgSQLAdapter {
    get engineType() {
        return 'postgresql';
    }

    connectionString = null;

    async insert() {
        return 1;
    }

    async selectOne() {
        return null;
    }
}
describe('adapter/index lazy-load (literal-path loaders)', () => {
    afterEach(async () => {
        // Reset to sqlite so the `adapter` live binding never leaks a
        // non-sqlite engine into a later test.
        await initAdapter('sqlite');
    });

    // ── initAdapter: mode → engine singleton ─────────────────────────

    it('postgresql: returns a PgSQLAdapter and rebinds the exported adapter singleton', async () => {
        const instance = await initAdapter('postgresql');

        expect(instance.engineType).toBe('postgresql');
        expect(instance.constructor.name).toBe('PgSQLAdapter');
        // The exported `adapter` is a live binding — it must now point
        // at the same lazy-loaded singleton.
        expect(instance).toBe(adapter);
    });

    it('mysql: returns a MySQLAdapter instance', async () => {
        const instance = await initAdapter('mysql');

        expect(instance.engineType).toBe('mysql');
        expect(instance.constructor.name).toBe('MySQLAdapter');
        expect(instance).toBe(adapter);
    });

    it('mariadb: alias normalises to mysql', async () => {
        const instance = await initAdapter('mariadb');

        expect(instance.engineType).toBe('mysql');
        expect(instance.constructor.name).toBe('MySQLAdapter');
        expect(instance).toBe(adapter);
    });

    it('sqlite: resolves synchronously and never triggers a loader', async () => {
        // The sqlite branch awaits nothing — its promise settles on the
        // first microtask, i.e. before a plain `await Promise.resolve()`.
        // A non-sqlite path would need at least one dynamic-import
        // round-trip before settling.
        const promise = initAdapter('sqlite');
        let settled = false;
        promise.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(true);

        const instance = await promise;
        expect(instance).toBeInstanceOf(SQLiteAdapter);
        expect(instance.constructor.name).toBe('SQLiteAdapter');
        expect(instance).toBe(adapter);
    });

    it('switching from postgresql back to sqlite restores the SQLiteAdapter singleton', async () => {
        await initAdapter('postgresql');
        expect(adapter.constructor.name).toBe('PgSQLAdapter');

        const sqlite = await initAdapter('sqlite');
        expect(sqlite).toBeInstanceOf(SQLiteAdapter);
        expect(sqlite.constructor.name).toBe('SQLiteAdapter');
        expect(sqlite).toBe(adapter);
    });

    it('unsupported mode throws the exact error message', async () => {
        await expect(initAdapter('unsupported')).rejects.toThrow(
            'initAdapter: unsupported engine mode: unsupported' +
                " (expected 'sqlite' | 'postgresql' | 'mysql' | 'mariadb')"
        );
        // The singleton must be untouched after the rejection.
        expect(adapter.constructor.name).toBe('SQLiteAdapter');
    });

    it('concurrent same-mode calls share the in-flight init (single load)', async () => {
        await initAdapter('sqlite');

        const first = initAdapter('postgresql');
        const second = initAdapter('postgresql');

        const [a, b] = await Promise.all([first, second]);
        // Both calls must resolve to the SAME instance. Had the second
        // call started its own load instead of awaiting the shared
        // `_initPromise`, it would have constructed a second
        // PgSQLAdapter — identity equality proves promise sharing.
        expect(a).toBe(b);
        expect(a).toBe(adapter);
        expect(a.constructor.name).toBe('PgSQLAdapter');
    });

    // ── createAdapter: connection URI → new engine instance ──────────

    it('createAdapter: postgresql:// URI returns a PgSQLAdapter', async () => {
        const instance = await createAdapter({
            connection: 'postgresql://host:5432/db'
        });

        expect(instance.engineType).toBe('postgresql');
        expect(instance.constructor.name).toBe('PgSQLAdapter');
        expect(instance.connectionString).toBe('postgresql://host:5432/db');
    });

    it('createAdapter: mysql:// URI returns a MySQLAdapter', async () => {
        const instance = await createAdapter({
            connection: 'mysql://host:3306/db'
        });

        expect(instance.engineType).toBe('mysql');
        expect(instance.constructor.name).toBe('MySQLAdapter');
        // MySQLAdapter._buildConnectionString normalises the URI into a
        // `Server=...;Port=...;Database=...` connection string.
        expect(instance.connectionString).toBe(
            'Server=host;Port=3306;Database=db'
        );
    });

    it('createAdapter: mariadb:// URI returns a MySQLAdapter (alias)', async () => {
        const instance = await createAdapter({
            connection: 'mariadb://host:3306/db'
        });

        expect(instance.engineType).toBe('mysql');
        expect(instance.constructor.name).toBe('MySQLAdapter');
    });

    it('createAdapter: sqlite:/// URI returns a SQLiteAdapter', async () => {
        const instance = await createAdapter({
            connection: 'sqlite:///C:/data/vrcx.db'
        });

        expect(instance).toBeInstanceOf(SQLiteAdapter);
        expect(instance.constructor.name).toBe('SQLiteAdapter');
    });

    it('createAdapter: empty/missing connection and unknown scheme throw', async () => {
        await expect(createAdapter({})).rejects.toThrow(
            'createAdapter requires a connection URI (e.g. sqlite:///path)'
        );
        await expect(createAdapter({ connection: '' })).rejects.toThrow(
            'createAdapter requires a connection URI (e.g. sqlite:///path)'
        );
        await expect(
            createAdapter({ connection: 'oracle://host:1521/db' })
        ).rejects.toThrow(
            'Unsupported connection scheme: oracle' +
                ' (expected sqlite://, postgresql://, mysql://, or mariadb://)'
        );
    });
});

// ── Browse-mode read-only gate (H-1, §2.2 / §6.1) ─────────────────
//
// `initAdapter(mode, { readOnly: true })`（browse 模式）时单例被包装为只读
// Proxy：22 个写方法 no-op、读方法/事务 API 透传。覆盖 H-1 五路径：
//   ① 模块加载单例 + readOnly:true → 包装；
//   ② initAdapter('sqlite') 复用路径（现存在实例）→ 包装；
//   ③ initAdapter('postgresql') 新建路径 → 包装（懒加载）；
//   ④ 两处返回值（sqlite 同步返回 / _initPromise 解析值）均为包装实例；
//   ⑤ 重复调用幂等（WeakSet 不重复包）。

describe('browse-mode read-only gate (H-1)', () => {
    afterEach(async () => {
        // 复位为裸 sqlite 单例：browse 测试可能留下门禁包装实例，此时直接
        // initAdapter('sqlite') 会复用（proxy instanceof SQLiteAdapter 为真）
        // 而无法解包——经 postgresql 中转强制重建新实例。
        await initAdapter('postgresql');
        await initAdapter('sqlite');
    });

    it('① 模块加载单例 + readOnly:true → 单例被包装为 Proxy（写方法 no-op）', async () => {
        await initAdapter('sqlite');
        const raw = adapter;
        expect(raw).toBeInstanceOf(SQLiteAdapter);

        const gated = await initAdapter('sqlite', { readOnly: true });

        // 返回值即包装实例：与原始单例不同对象
        expect(gated).not.toBe(raw);
        expect(gated.constructor.name).toBe('SQLiteAdapter');
        expect(gated.engineType).toBe('sqlite');
        // 写方法被 no-op 拦截（不是原型上的真实实现，返回守恒值 0）
        expect(gated.insert).not.toBe(SQLiteAdapter.prototype.insert);
        await expect(gated.insert('t', { a: 1 })).resolves.toBe(0);
        await expect(gated.executeNonQuery('DELETE FROM t')).resolves.toBe(0);
        // 读方法透传（同一原型实现）
        expect(gated.selectOne).toBe(SQLiteAdapter.prototype.selectOne);
        // live ESM binding：importers 看到包装实例
        expect(adapter).toBe(gated);
    });

    it('② initAdapter sqlite 复用路径 → 已有实例被包装（不重建）', async () => {
        const first = await initAdapter('sqlite');
        const gated = await initAdapter('sqlite', { readOnly: true });
        // 复用路径：后续 collector 缺省调用仍返回同一包装实例，
        // 证明 sqlite 分支复用既有单例而非每次重建
        const again = await initAdapter('sqlite');
        expect(gated).not.toBe(first);
        expect(again).toBe(gated);
        await expect(gated.insert('t', { a: 1 })).resolves.toBe(0);
    });

    it('③ initAdapter postgresql 新建路径 → 懒加载实例被包装', async () => {
        const gated = await initAdapter('postgresql', { readOnly: true });

        expect(gated.constructor.name).toBe('PgSQLAdapter');
        expect(gated.engineType).toBe('postgresql');
        // 返回值 = 包装实例：写方法 no-op（非原型实现）、读/属性透传
        const proto = Object.getPrototypeOf(gated);
        expect(gated.insert).not.toBe(proto.insert);
        await expect(gated.insert('t', { a: 1 })).resolves.toBe(0);
        expect(gated.connectionString).toBeNull();
        expect(adapter).toBe(gated);
    });

    it('④ 两处返回路径均解析为包装实例（返回值写 no-op）', async () => {
        // sqlite 分支（同步返回）
        const sqlite = await initAdapter('sqlite', { readOnly: true });
        await expect(sqlite.insert('t', { a: 1 })).resolves.toBe(0);
        // 非 sqlite 分支（_initPromise 解析值）
        const pg = await initAdapter('postgresql', { readOnly: true });
        await expect(pg.insert('t', { a: 1 })).resolves.toBe(0);
        expect(pg.constructor.name).toBe('PgSQLAdapter');
    });

    it('⑤ 重复调用幂等（WeakSet 不重复包）', async () => {
        const a = await initAdapter('sqlite', { readOnly: true });
        const b = await initAdapter('sqlite', { readOnly: true });
        expect(b).toBe(a);
        expect(adapter).toBe(a);
    });

    it('⑥ collector 首启后同模式 readOnly 调用 → 短路路径也返回包装实例（mock 懒加载模块）', async () => {
        // MEDIUM-3, qa: 非 sqlite 同模式短路路径此前直接返回未包装实例 —
        // collector 首启 initAdapter('postgresql') 后再调
        // initAdapter('postgresql', { readOnly: true }) 必须返回包装实例
        // 且 live binding 同步换绑 (与 sqlite 分支对称)。
        // 隔离: 独立模块实例 + 替换懒加载模块, 不影响本文件其他用例。
        vi.resetModules();
        vi.doMock('./PgSQLAdapter.js', () => ({
            PgSQLAdapter: FakePgSQLAdapter
        }));
        try {
            const fresh = await import('./index.js');

            // collector 首启: 新建实例, 不门禁, 写方法走真实实现
            const raw = await fresh.initAdapter('postgresql');
            expect(raw.constructor.name).toBe('FakePgSQLAdapter');
            expect(raw.engineType).toBe('postgresql');
            await expect(raw.insert('t', { a: 1 })).resolves.toBe(1);

            // 同模式 + readOnly:true → 命中短路路径, 必须过 _applyReadOnlyGate
            const gated = await fresh.initAdapter('postgresql', {
                readOnly: true
            });
            expect(gated).not.toBe(raw);
            await expect(gated.insert('t', { a: 1 })).resolves.toBe(0);
            expect(gated.engineType).toBe('postgresql');
            // live ESM binding 换绑为包装实例 (修复前仍指向 raw)
            expect(fresh.adapter).toBe(gated);
        } finally {
            vi.doUnmock('./PgSQLAdapter.js');
            vi.resetModules();
        }
    });
});

describe('downgradeToReadOnly (M2 auto 检测 re-gate)', () => {
    afterEach(async () => {
        await initAdapter('sqlite');
    });

    it('将当前连接降级为只读：adapter 换绑为门禁包装实例', async () => {
        await initAdapter('sqlite');

        const raw = adapter;
        const downgraded = await downgradeToReadOnly();

        expect(downgraded).toBe(adapter);
        expect(downgraded).not.toBe(raw);
        expect(downgraded.engineType).toBe('sqlite');
        await expect(downgraded.insert('t', { a: 1 })).resolves.toBe(0);
    });
});
