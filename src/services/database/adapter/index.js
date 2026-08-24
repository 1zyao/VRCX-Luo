import { SQLiteAdapter } from './SQLiteAdapter.js';
import { setChangeGateHook } from './EngineAdapter.js';
import { createReadOnlyAdapter } from './readOnlyGate.js';
import InteropApi from '../../../ipc-electron/interopApi.js';

// ── Engine singleton & lazy-load policy ──────────────────────────────
//
// `PgSQLAdapter.js` (1760 lines) and `MySQLAdapter.js` (1229 lines)
// are intentionally NOT statically imported here. A static import
// forces every test file that touches the database layer to transform
// those modules, inflating transform time ~11x and import time ~3.3x,
// which pushes unrelated tests past their default 5s/10s timeouts (see
// Phase 9 Stage 5 D15 for the PgSQL measurement; the same applies to
// MySQL). Instead we lazy-load them via literal-path loader functions
// (`_engineSpec.load`) only when `initAdapter(mode)` is called with
// `'postgresql'` or `'mysql'`/`'mariadb'`, *or* `createAdapter()` is
// called with a matching URI scheme. In the default `sqlite` mode
// (production + vitest stub), neither module body is ever evaluated.
//
// Why loader functions instead of `import(spec.path)` with a variable
// path? Rolldown (the production bundler) statically analyses dynamic
// `import()` specifiers; a string-variable specifier cannot be
// resolved, so it is rewritten into a runtime network-fetch fallback
// that 404s in the packaged CefSharp/Electron app (the bug this
// refactor fixes). Each `load` function carries its specifier as a
// *literal* `import('./XxxAdapter.js')`, which Rolldown resolves and
// emits as a separate on-demand chunk.
//
// Why not top-level `await import()` for the singleton? Rolldown's CJS
// output rejects top-level await in modules that are transitively
// `require()`d (e.g. `accountHub.js` uses `require()` to break circular
// deps with stores that re-export the adapter). So the non-sqlite
// singletons are initialised lazily by `initAdapter(mode)`, while the
// sqlite singleton stays synchronously initialised at module load to
// preserve the existing test/app contract (no init ceremony required
// for sqlite).
//
// ── Alignment with the MySQL branch ──────────────────────────────────
//
// The MySQL branch uses `initAdapter(mode)` (mode parameter) and reads
// `adapter.engineType` for engine detection in the migration runner.
// Phase 9 previously used a parameterless `initAdapter()` that read
// `VRCXStorage.Get('VRCX_Database.mode')` at module top level. This
// file aligns Phase 9 to the MySQL branch's contract:
//   - `initAdapter(mode)` takes an explicit mode argument (the caller
//     — `interopApi.js` — reads `VRCXStorage` once and passes it in,
//     keeping the adapter module free of `VRCXStorage` reads so it can
//     be unit-tested without stubbing the global).
//   - `getDatabaseEngine()` in `migrations/index.js` now reads
//     `adapter.engineType` instead of re-reading `VRCXStorage`, so
//     engine detection stays in sync with whichever adapter
//     `initAdapter(mode)` actually constructed.
// Phase 9 retains its D15 fix (lazy import for PgSQL) and extends the
// same lazy-import policy to MySQL so the merged codebase treats both
// non-sqlite engines uniformly.

// Default sqlite singleton. Constructed synchronously at module load
// so callers can keep using the `import { adapter } from '.../adapter'
// pattern with no init ceremony in the default (sqlite) mode. In
// `postgresql` / `mysql` mode the singleton is swapped by
// `initAdapter(mode)` via lazy import — `let` + live ESM binding
// ensures importers observe the post-init value.
//
// The singleton is typed as the abstract base `EngineAdapter` rather
// than a `SQLiteAdapter | PgSQLAdapter | MySQLAdapter` union: callers
// only ever go through the base interface, so the union adds no type
// information (and a union would drag both heavy adapter modules into
// every type-check of the database layer). Using the base class keeps
// the lazy-load policy intact — the adapter modules are never
// statically referenced from this file.
/** @type {import('./EngineAdapter.js').EngineAdapter} */
let adapter = new SQLiteAdapter();

/** @type {string} engine mode currently held by `adapter` ('sqlite' | 'postgresql' | 'mysql') */
let _initializedMode = 'sqlite';

/** @type {Promise<import('./EngineAdapter.js').EngineAdapter> | null} */
let _initPromise = null;

// ── 浏览模式只读门禁（§2.2 H-1 / §4）───────────────────────────────
//
// `initAdapter(mode, { readOnly: true })`（browse 模式）时对单例 adapter 做
// 单次 Proxy 包装：22 个写方法 no-op，读方法/事务 API 透传。包装动作在
// initAdapter 双分支（sqlite 复用 / 非 sqlite 新建）收敛，两处返回值均为包装
// 实例；`_gatedInstances` WeakSet 同时登记原始实例与包装后代理，保证同一
// 实例（或代理本身）不会被包两次。`createAdapter` 实例不门禁（§4.5 边界
// 声明：调用方自控连接串）。

/** @type {WeakSet<object>} 已门禁实例（防双重包装） */
const _gatedInstances = new WeakSet();

/**
 * 应用只读门禁：`readOnly` 为真且实例尚未门禁时包装一次并登记。
 *
 * @param {import('./EngineAdapter.js').EngineAdapter} instance - 当前单例
 * @param {boolean} readOnly - initAdapter `options.readOnly`（启动即定，
 *   运行中切换属 M3）
 * @returns {import('./EngineAdapter.js').EngineAdapter} 门禁后的实例
 *   （readOnly 缺省/false 时原样返回，collector 行为零变化）
 */
function _applyReadOnlyGate(instance, readOnly) {
    if (!readOnly || _gatedInstances.has(instance)) return instance;
    const gated = createReadOnlyAdapter(instance);
    // 原始实例与包装后代理都登记：同一 inner 不会被包两次，且重复
    // initAdapter 调用传回代理时也不会再包一层。
    _gatedInstances.add(instance);
    _gatedInstances.add(gated);
    return gated;
}

/**
 * Normalise an engine mode token.
 *
 * `'mariadb'` is treated as an alias for `'mysql'` (same adapter, same
 * wire protocol). Any other value is returned as-is so the caller can
 * reject it with a precise error message.
 *
 * @param {string} mode
 * @returns {string} 'sqlite' | 'postgresql' | 'mysql' | original
 * @private
 */
function _normalizeMode(mode) {
    if (mode === 'mariadb') return 'mysql';
    return mode;
}

/**
 * Lazy-load spec for non-sqlite engines.
 *
 * Kept as a lookup table so `initAdapter` and `createAdapter` share the
 * same loader/class-name mapping, and so adding a fourth engine later
 * is a one-line change here.
 *
 * Each `load` is a function whose body is a dynamic `import()` of a
 * *literal* relative path. Literal specifiers can be statically
 * analysed by Rolldown, so each adapter is emitted as its own chunk and
 * loaded on demand; a variable-path `import(spec.path)` cannot be
 * resolved statically and would degrade to a runtime fetch that 404s in
 * the packaged app. The `Promise<Record<string, unknown>>` return type
 * keeps the module namespace opaque — the class is read back out via
 * `className`.
 *
 * @typedef {new (config?: object) => import('./EngineAdapter.js').EngineAdapter} EngineAdapterCtor
 * @type {Record<string, { load: () => Promise<Record<string, unknown>>, className: string }>}
 * @private
 */
const _engineSpec = {
    postgresql: {
        load: () => import('./PgSQLAdapter.js'),
        className: 'PgSQLAdapter'
    },
    mysql: {
        load: () => import('./MySQLAdapter.js'),
        className: 'MySQLAdapter'
    }
};

// ── 写漏斗事件路由 ───────────────────────────────────────────────
//
// C# DatabaseChanged 事件(CefSharp: 绑定对象事件暴露为 add_EventName;
// Electron: SetChangeCallback)负载 { conn, table, count, ts, dv },
// 按 conn 路由:conn="default" → 单例 adapter;conn=connectionString →
// createAdapter 创建的实例(外部迁移文件的写无对应实例,直接丢弃)。
// 详见 docs/architecture/ADAPTER_API.md §9。

/** @type {Map<string, import('./EngineAdapter.js').EngineAdapter>} connectionString → 实例 */
const _changeInstances = new Map();

/**
 * @param {string} payloadJson - C# 漏斗事件负载(JSON 字符串)
 * @private
 */
function _onFunnelEvent(payloadJson) {
    let payload;
    try {
        payload = JSON.parse(payloadJson);
    } catch {
        return;
    }
    if (!payload || typeof payload !== 'object') return;
    const instance =
        payload.conn === 'default'
            ? adapter
            : _changeInstances.get(payload.conn);
    if (!instance) return;
    instance._onFunnelEvent(payload);
}

/** @type {Set<object>} 已绑定的桥对象(按对象幂等,防止重复绑定) */
const _funnelBridges = new Set();

/** @type {string[]} 门控扇出的引擎桥名(与 wireFunnelEvents 同列表) */
const CHANGE_BRIDGES = ['SQLite', 'PostgreSQL', 'MySQL'];

/**
 * C# 写漏斗门控扇出。桥缺 SetChangeEnabled(旧版)静默跳过——事件恒发,
 * 行为同现状;Electron 下桥方法经 IPC 异步返回 Promise,CefSharp 同步返回
 * undefined——Promise.resolve 统一两种形态,调用不等待结果(门控是尽力而为)。
 * @param {boolean} enabled
 */
function _applyChangeEnabled(enabled) {
    for (const bridgeName of CHANGE_BRIDGES) {
        const bridge = globalThis[bridgeName];
        if (!bridge || typeof bridge.SetChangeEnabled !== 'function') continue;
        try {
            Promise.resolve(bridge.SetChangeEnabled(enabled)).catch(() => {});
        } catch {
            /* 旧桥/绑定异常静默 */
        }
    }
}

setChangeGateHook(_applyChangeEnabled);

/**
 * 绑定运行时桥的写漏斗事件(启动后调用;按桥对象幂等)。
 * - Electron:preload 暴露 `window.electron.onDbChange`(主进程 SetChangeCallback
 *   → 'db-change' 转推)。InteropApi Proxy 对任意类名属性返回 async 函数,
 *   不能走 add_DatabaseChanged——JS 函数无法经 IPC 序列化;
 * - CefSharp:绑定对象事件暴露为 `add_EventName(handler)`;
 * - 桥版本差异/绑定失败静默——完备层计数器轮询兜底,不阻断主流程。
 */
export function wireFunnelEvents() {
    if (
        typeof window !== 'undefined' &&
        window.electron &&
        typeof window.electron.onDbChange === 'function'
    ) {
        try {
            InteropApi.onDbChange(_onFunnelEvent);
        } catch {
            /* 绑定失败静默:完备层轮询兜底 */
        }
        return;
    }
    for (const bridgeName of ['SQLite', 'PostgreSQL', 'MySQL']) {
        const bridge = globalThis[bridgeName];
        if (!bridge || _funnelBridges.has(bridge)) continue;
        try {
            if (typeof bridge.add_DatabaseChanged === 'function') {
                bridge.add_DatabaseChanged(_onFunnelEvent);
                _funnelBridges.add(bridge);
            }
        } catch {
            /* 桥版本差异/绑定失败静默 */
        }
    }
}

/**
 * Initialise (or switch) the singleton adapter for the given engine mode.
 *
 * Mode handling:
 *   - `'sqlite'` (default) — synchronously constructed. No async cost.
 *     If the current singleton is not a `SQLiteAdapter` (e.g. after a
 *     prior non-sqlite init), a fresh `SQLiteAdapter` is constructed.
 *   - `'postgresql'` — lazy-loads `PgSQLAdapter.js` (1760 lines) via
 *     its `_engineSpec` loader so the module is only transformed when
 *     PG is actually used (Phase 9 Stage 5 D15 fix — keeps sqlite-mode
 *     tests fast).
 *   - `'mysql'` / `'mariadb'` — lazy-loads `MySQLAdapter.js` (1229
 *     lines) via the same mechanism. Both adapter files exist in this
 *     workspace, so `mysql` mode is fully available; the loaders fire
 *     only when the user actually selects the engine.
 *
 * Concurrent calls:
 *   - Same-mode concurrent calls share the in-flight `_initPromise`.
 *   - Cross-mode concurrent calls serialise: a later call awaits the
 *     in-flight init, then re-checks the mode and starts its own init
 *     if the mode still differs.
 *
 * Must be `await`ed from `interopApi.js` startup (after
 * `CefSharp.BindObjectAsync` / Electron proxy setup, before
 * `configRepository.init()`) so the singleton is ready before any
 * database operation runs.
 *
 * @param {string} [mode='sqlite'] - 'sqlite' | 'postgresql' | 'mysql' | 'mariadb'
 * @param {{ readOnly?: boolean }} [options] - 浏览模式只读门禁开关（§2.2）：
 *   `readOnly: true` 时单例被包装为只读 Proxy（22 个写方法 no-op）；缺省/false
 *   时零行为变化（collector 回归线）。启动即定，运行中切换属 M3。
 * @returns {Promise<import('./EngineAdapter.js').EngineAdapter>}
 */
export async function initAdapter(mode = 'sqlite', options = {}) {
    const normalized = _normalizeMode(mode);
    wireFunnelEvents();
    // 启动时无订阅 → 门控关闭;首个 onTableChange 订阅经钩子开启。
    _applyChangeEnabled(false);

    // sqlite: synchronous, no lazy import.
    if (normalized === 'sqlite') {
        // If a non-sqlite init is in flight, wait for it to finish so we
        // don't race on the `adapter` binding.
        if (_initPromise) {
            await _initPromise;
        }
        if (!(adapter instanceof SQLiteAdapter)) {
            adapter = new SQLiteAdapter();
        }
        _initializedMode = 'sqlite';
        adapter = _applyReadOnlyGate(adapter, options.readOnly === true);
        return adapter;
    }

    // Non-sqlite engines must be in the spec table.
    const spec = _engineSpec[normalized];
    if (!spec) {
        throw new Error(
            `initAdapter: unsupported engine mode: ${mode}` +
                ` (expected 'sqlite' | 'postgresql' | 'mysql' | 'mariadb')`
        );
    }

    // Already initialised for this mode — return the singleton. The
    // short-circuit must still apply the readOnly gate (MEDIUM-3, qa):
    // collector 首启后同进程再以 readOnly:true 调用 → 返回包装实例并换绑
    // live binding,与 sqlite 分支对称;WeakSet 幂等保证不重复包。
    if (_initializedMode === normalized && adapter) {
        adapter = _applyReadOnlyGate(adapter, options.readOnly === true);
        return adapter;
    }

    // If a different mode's init is in flight, await it before starting
    // our own so we don't race on the `adapter` binding. After awaiting,
    // re-check in case the in-flight init was for our mode after all
    // (e.g. two concurrent postgresql calls). Same readOnly gate as the
    // short-circuit above (MEDIUM-3, qa).
    if (_initPromise) {
        await _initPromise;
        if (_initializedMode === normalized && adapter) {
            adapter = _applyReadOnlyGate(adapter, options.readOnly === true);
            return adapter;
        }
    }

    // Begin lazy load. The promise is shared with concurrent same-mode
    // callers; cross-mode callers will await it above and then start
    // their own.
    _initPromise = spec
        .load()
        .then((mod) => {
            // `mod` is `Record<string, unknown>` — cast the class back
            // out so it is constructable at the type level.
            const AdapterClass = /** @type {EngineAdapterCtor} */ (
                mod[spec.className]
            );
            if (!AdapterClass) {
                throw new Error(
                    `initAdapter: adapter module did not export ${spec.className}`
                );
            }
            adapter = _applyReadOnlyGate(
                new AdapterClass(),
                options.readOnly === true
            );
            _initializedMode = normalized;
            _initPromise = null;
            return adapter;
        })
        .catch((err) => {
            // Clear the in-flight marker so a later retry can attempt
            // the import again instead of awaiting a rejected promise
            // forever.
            _initPromise = null;
            throw err;
        });
    return _initPromise;
}

/**
 * Create a new adapter instance for a given connection URI.
 *
 * Async because the PostgreSQL / MySQL branches lazy-load their adapter
 * modules via the `_engineSpec` loader functions (literal-path dynamic
 * `import()`) — see the file header note for why the static imports
 * were removed. The SQLite branch pays no async cost beyond a
 * microtask.
 *
 * URI schemes:
 *   - `sqlite:///path`            → SQLiteAdapter
 *   - `postgresql://host:port/db` → PgSQLAdapter
 *   - `mysql://host:port/db`      → MySQLAdapter
 *   - `mariadb://host:port/db`    → MySQLAdapter (alias)
 *
 * @param {object} config
 * @param {string} config.connection - 连接 URI，如 sqlite:///C:/path.db 或 postgresql://host:port/db
 * @param {...object} [config.params] - 额外连接参数（覆盖默认，如 'Read Only': 'False'）
 * @returns {Promise<import('./EngineAdapter.js').EngineAdapter>}
 */
async function createAdapter(config) {
    const { connection } = config;
    if (!connection || typeof connection !== 'string') {
        throw new Error(
            'createAdapter requires a connection URI (e.g. sqlite:///path)'
        );
    }
    const scheme = connection.split('://')[0];
    if (scheme === 'sqlite') {
        const rest = connection.slice('sqlite://'.length);
        if (!rest || /^\/+$/.test(rest) || !rest.trim()) {
            throw new Error('createAdapter: connection URI has empty path');
        }
        const instance = new SQLiteAdapter(config);
        if (instance.connectionString) {
            // 漏斗事件按 conn=connectionString 路由到实例(与 PG/MySQL 分支同款)
            _changeInstances.set(instance.connectionString, instance);
        }
        return instance;
    }
    // Non-sqlite schemes: resolve via the `_engineSpec` table. Each
    // entry's `load` is a literal-path dynamic `import()` that Rolldown
    // can statically resolve, so every non-sqlite adapter is emitted as
    // its own chunk and fetched on demand — never a runtime network
    // fetch of a variable path. Both `PgSQLAdapter.js` and
    // `MySQLAdapter.js` exist in this workspace, so the literal
    // specifiers pass CheckJS with no TS2307.
    const spec = _engineSpec[scheme === 'mariadb' ? 'mysql' : scheme];
    if (!spec) {
        throw new Error(
            `Unsupported connection scheme: ${scheme} (expected sqlite://, postgresql://, mysql://, or mariadb://)`
        );
    }
    const mod = await spec.load();
    const AdapterClass = /** @type {EngineAdapterCtor} */ (mod[spec.className]);
    if (!AdapterClass) {
        throw new Error(
            `createAdapter: adapter module did not export ${spec.className}`
        );
    }
    const instance = new AdapterClass(config);
    if (instance.connectionString) {
        // 漏斗事件按 conn=connectionString 路由到实例
        _changeInstances.set(instance.connectionString, instance);
    }
    return instance;
}

/**
 * 运行中降级为只读（browse 模式）。复用 initAdapter 的 readOnly 门禁：
 * 以当前 engineType 重新 init，WeakSet 幂等保证不重复包装。
 * 供 vrcx.js auto 检测到其他活跃 collector 时调用。
 * @returns {Promise<import('./EngineAdapter.js').EngineAdapter>}
 */
export async function downgradeToReadOnly() {
    return initAdapter(adapter.engineType, { readOnly: true });
}

export { adapter, SQLiteAdapter, createAdapter };
