// @ts-check
/**
 * 浏览模式只读写入门禁（docs/architecture/BROWSE_MODE_M1_DESIGN.md §2.2 / §4）。
 *
 * `createReadOnlyAdapter(inner)` 返回一个 Proxy：`WRITE_METHODS` 名单内的写
 * 方法被替换为守恒 no-op（`Promise.resolve(0)` / `Promise.resolve(undefined)`，
 * 不抛错、零 SQL，每进程每方法名仅 `console.warn` 一次），其余属性/方法原样
 * 透传。
 *
 * 透传机制（MEDIUM-1）：get trap 对非写属性返回 `Reflect.get(inner, prop,
 * receiver)`——函数**未绑定**，以 `proxy.method()` 形式调用时 `this === proxy`，
 * inner 方法内部的 `this._normalizeArgs` / `this._txStack` 等链式访问继续经
 * get trap 透传，行为与直接调用 inner 一致；`withTransaction` /
 * `beginTransaction` / `commit` / `rollback` / `keepAlive` 透传（只读事务合法，
 * 事务体内写仍被拦截）。
 *
 * 门禁边界（§4.5）：本文件只覆盖单例 adapter 路径；`createAdapter` 实例、
 * `execute()` 裸 SQL 通道、C# 桥直调不在此门禁范围（连接层兜底）。
 */

/**
 * 拦截名单：22 个写方法（§4.1，MEDIUM-2 修订，含 PgSQLAdapter.js:1148 独有的
 * `dropUserSchema`）。完整性由 readOnlyGate.test.js 的原型反射测试锁定——
 * 引擎未来"只增"写方法时测试即失败，迫使名单同步。
 *
 * @type {string[]}
 */
export const WRITE_METHODS = [
    'executeNonQuery',
    'insert',
    'bulkInsert',
    'update',
    'updateWhere',
    'delete',
    'deleteAll',
    'deleteWhere',
    'increment',
    'upsertPartial',
    'createTable',
    'createIndex',
    'alterTableAddColumn',
    'alterTableDropColumn',
    'alterTableRename',
    'dropTable',
    'vacuum',
    'optimize',
    'initUserSchema',
    'initGlobalSchema',
    'initValueColumnsLongText',
    'dropUserSchema'
];

/**
 * 返回 `Promise<void>` 的写方法（§4.2 守恒契约：void → `undefined`）。
 *
 * 依据 EngineAdapter.js 各方法 JSDoc `@returns` 核对：
 * - `initUserSchema`（EngineAdapter.js:734）、`initGlobalSchema`（:744）→ `Promise<void>`；
 * - 其余 19 个（含 PgSQLAdapter.js:1146 的 `dropUserSchema`）→ `Promise<number>`，
 *   no-op 返回 `0`。
 *
 * @type {Set<string>}
 */
const VOID_METHODS = new Set([
    'initUserSchema',
    'initGlobalSchema',
    'initValueColumnsLongText'
]);

/** @type {Set<string>} 名单 O(1) 查找集 */
const _writeSet = new Set(WRITE_METHODS);

/** @type {Set<string>} 每进程每方法名仅 warn 一次的记录（§4.2 副作用契约） */
const _warnedMethods = new Set();

/**
 * 生成单方法 no-op：不抛错、零 SQL、守恒返回、每方法名一次 warn。
 *
 * @param {string} name - 写方法名
 * @returns {(...args: unknown[]) => Promise<number | undefined>}
 */
function _makeNoOp(name) {
    return () => {
        if (!_warnedMethods.has(name)) {
            _warnedMethods.add(name);
            console.warn(`[browse] 只读模式，写方法已跳过: ${name}`);
        }
        return VOID_METHODS.has(name)
            ? Promise.resolve(undefined)
            : Promise.resolve(0);
    };
}

/**
 * 归一化节点模式（§2.5 MEDIUM-5，JS 侧实现，C# 侧 NodeMode.cs 同契约）。
 *
 * `String(raw ?? '').trim().toLowerCase() === 'browse'` → `'browse'`，其余
 * （含 `'auto'` / `'collector'` / 空 / 非法值）→ `'collector'`（fail-safe：
 * 判定错误的最坏后果是 collector 照常运行，绝不反向误判为 browse）。
 *
 * @param {unknown} raw - VRCX_NodeMode 原始值（VRCXStorage flat 键）
 * @returns {'browse' | 'collector'}
 */
export function normalizeNodeMode(raw) {
    return String(raw ?? '')
        .trim()
        .toLowerCase() === 'browse'
        ? 'browse'
        : 'collector';
}

/**
 * 创建只读门禁 Proxy（§2.2 H-1 / §4.2 no-op 契约）。
 *
 * @template {object} T
 * @param {T} inner - 被包装的 adapter 实例
 * @returns {T} 门禁 Proxy（结构与 inner 相同，类型透传）
 */
export function createReadOnlyAdapter(inner) {
    /** @type {Map<string, (...args: unknown[]) => Promise<number | undefined>>} */
    const noOps = new Map();
    return new Proxy(inner, {
        /**
         * @param {T} target
         * @param {string | symbol} prop
         * @param {unknown} receiver
         */
        get(target, prop, receiver) {
            if (typeof prop === 'string' && _writeSet.has(prop)) {
                // no-op 每 proxy 缓存一份，保持 `proxy.insert === proxy.insert`
                // 的引用稳定性；once-warn 状态在模块级 _warnedMethods（进程级）。
                let noOp = noOps.get(prop);
                if (!noOp) {
                    noOp = _makeNoOp(prop);
                    noOps.set(prop, noOp);
                }
                return noOp;
            }
            // 透传：返回未绑定函数，调用时 this = proxy（MEDIUM-1），
            // inner 内部 `this._normalizeArgs` / `this._txStack` 链式访问
            // 继续经 get trap 透传，与直接调用 inner 行为一致。
            return Reflect.get(target, prop, receiver);
        }
    });
}
