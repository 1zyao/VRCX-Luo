// Remote → SQLite pull engine.
//
// Provides `pullToSqlite(dstConnStr, options)` which copies every
// global + user table from the currently-initialised remote singleton
// adapter (PostgreSQL or MySQL/MariaDB) into a NEW SQLite database file
// the user picks via a native Save-As dialog. This is the symmetric
// counterpart to `pushEngine.js`'s `pushFromSqlite`: the push copies
// SQLite → remote (live singleton), the pull copies remote (live
// singleton) → SQLite (new throwaway file). The pull is non-destructive
// — it never touches the running remote database; it only reads from it
// and writes to the user-chosen `.sqlite3` file.
//
// The backup body is engine-agnostic: it only touches the abstract
// `EngineAdapter` surface (`listTablesTypes` / `listGlobalTablesTypes` /
// `initGlobalSchema` / `initUserSchema` / `userTable` / `bulkInsert` /
// `createTable`), which every adapter implements. The one engine-specific
// wrinkle is PostgreSQL: PG keeps user tables in per-account `account_*`
// schemas and global tables in the `public` schema, and its
// `listTablesTypes` only enumerates `account_*` tables (per its JSDoc), so
// we probe for the PG-specific `listGlobalTablesTypes` extension and fall
// back to deriving global tables from the `GLOBAL_TABLES` whitelist for
// MySQL/SQLite (which enumerate all tables flatly through `listTablesTypes`).
// The PG branch whitelist-filters the `listGlobalTablesTypes` result
// (public-schema enumeration covers every table, known or not);
// non-whitelist `public` tables fall into the §5 mirror bucket.
//
// Design constraints honoured here (mirrors `pushEngine.js`):
//   - The source is the live singleton `adapter` only — there is no
//     `srcConfig` parameter. Callers MUST ensure the engine has been
//     switched + restarted so the singleton matches the user's intended
//     source; the UI-side guard `canPullFromRemote` in
//     `stores/settings/advanced.js` enforces this by checking
//     `adapter.engineType` is a remote engine (not 'sqlite'/'unknown').
//   - `id` / `session_id` columns are copied verbatim (SELECT * includes
//     them, bulkInsert writes them through).
//   - Errors per-GROUP are collected and the run continues — a single
//     broken group (global / per-prefix / mirror) does not abort the
//     whole pull. Tables within a group share one transaction (atomic +
//     1 fsync per group instead of per-batch).
//   - Row-count verification per table; deeper sampling left to QA.
//   - DATA-INTEGRITY PRIORITY: the 18 global + 22 user base-name whitelists
//     cover the *known* schema, but the backup MUST NOT silently drop tables
//     that fall outside them (upstream additions, legacy tables, etc.).
//     After the known tables are copied, every
//     remaining source table is mirrored into the destination: its column
//     metadata is read from the source adapter's `listTablesTypes` and
//     re-emitted as a `CREATE TABLE IF NOT EXISTS` via the destination
//     adapter's `createTable` (which applies engine-specific type mapping),
//     then the rows are copied through the same paged `copyTable` path.
//     Constraints are mirrored at column-level only (single-col PK inline,
//     composite PK as a table-level `PRIMARY KEY(...)` clause; UNIQUE/indexes
//     are NOT re-created — recovery-time concerns). `configs` is copied under
//     its original name.

import { adapter, createAdapter } from './adapter/index.js';

/**
 * 19 global tables (public schema) — mirrors `pushEngine.js`'s
 * `GLOBAL_TABLES` and `SQLiteAdapter.initGlobalSchema` /
 * `PgSQLAdapter.initGlobalSchema` / `MySQLAdapter.initGlobalSchema`
 * table-for-table. Used to split the flat MySQL/SQLite `listTablesTypes`
 * result into global vs user vs unknown buckets.
 * @type {string[]}
 */
const GLOBAL_TABLES = [
    'gamelog_location',
    'gamelog_join_leave',
    'gamelog_portal_spawn',
    'gamelog_video_play',
    'gamelog_resource_load',
    'gamelog_event',
    'gamelog_external',
    'cache_avatar',
    'cache_world',
    'favorite_world',
    'favorite_avatar',
    'favorite_friend',
    'memos',
    'world_memos',
    'avatar_memos',
    'avatar_tags',
    'cookies',
    'configs',
    'node_registry'
];

/**
 * 22 user-table base names — mirrors `pushEngine.js`'s `USER_TABLE_NAMES`.
 * In the source MySQL DB these live flat as `${prefix}_${name}`; in a
 * source PG DB they live in the `account_${prefix}` schema as just
 * `${name}`. Sorted longest-first when matching so e.g.
 * `activity_sync_state_v2` is tried before `activity_sessions_v2`.
 * @type {string[]}
 */
const USER_TABLE_NAMES = [
    'activity_bucket_cache_v2',
    'activity_sync_state_v2',
    'activity_sessions_v2',
    'manual_relations_MANUEL',
    'mutual_graph_friends_old',
    'mutual_graph_links_old',
    'mutual_graph_friends',
    'mutual_graph_links',
    'mutual_graph_meta',
    'feed_online_offline',
    'friend_log_current',
    'friend_log_history',
    'tracked_nonfriends',
    'notifications_v2',
    'notifications',
    'avatar_history',
    'feed_status',
    'feed_avatar',
    'feed_gps',
    'feed_bio',
    'moderation',
    'notes'
];

// Longest-first for `endsWith('_' + name)` matching.
const USER_TABLE_NAMES_BY_LENGTH_DESC = [...USER_TABLE_NAMES].sort(
    (a, b) => b.length - a.length
);

/**
 * @typedef {Object} PullProgress
 * @property {'global'|'user'|'mirror'} phase
 * @property {string} table - destination table identifier (bare name or `account_{prefix}.{name}`)
 * @property {number} current - 1-based index of the current table within its phase
 * @property {number} total - total tables in this phase
 * @property {number} rowsCopied - running total rows copied across all tables so far
 */

/**
 * @typedef {Object} PullResult
 * @property {number} globalTables - count of whitelist global tables actually enumerated on the source (MySQL: flat `listTablesTypes` whitelist filter; PG: `listGlobalTablesTypes` whitelist filter), ≤18; unlike push side which is always 18 (fixed whitelist iteration, includes missing tables)
 * @property {number} userTables - number of known user tables processed (across all prefixes)
 * @property {number} unknownTables - number of non-whitelist tables mirrored + copied (data-integrity safety net)
 * @property {number} rowsCopied - total rows copied
 * @property {string[]} errors - per-table error messages (empty on full success)
 */

/**
 * Pull data from a remote-engine source into a NEW SQLite database file.
 *
 * The source is, by default, the singleton `adapter` from `./adapter/index.js`,
 * which is a `PgSQLAdapter` when the app booted with `VRCX_Database.mode ===
 * 'postgresql'` (C# `PostgreSQL` pool initialised) or a `MySQLAdapter`
 * when mode is `'mysql'`/`'mariadb'` (C# `MySQL` initialised). In this mode
 * callers must ensure the engine has been switched + the app restarted before
 * invoking this function; otherwise the source reads will go to the live
 * SQLite adapter and the "pull" would be SQLite → SQLite (useless).
 * We guard against this by refusing to run when the singleton's
 * `engineType` is `'sqlite'` (or the abstract `'unknown'`).
 *
 * When `options.srcAdapter` is provided, ALL reads are routed to that
 * adapter instance instead of the singleton. This enables ad-hoc pull
 * without restart: a fresh adapter is constructed from form fields on the
 * caller side (see `advanced.js`) and passed through, bypassing the
 * boot-time C# pool entirely. The singleton engine-type and liveness
 * guards are skipped in this mode — the caller is responsible for
 * providing a properly-initialised source adapter.
 *
 * The destination is a throwaway `SQLiteAdapter` constructed from
 * `dstConnStr` (a `sqlite:///path` URI pointing at the user-chosen
 * `.sqlite3` file). The file is created by SQLite on first connection
 * (read-write mode), so the user's chosen path does not need to pre-exist.
 *
 * The body is engine-agnostic: it only touches abstract `EngineAdapter`
 * methods every adapter implements, so PG and MySQL share one code path.
 * `isConnected` (a real `SELECT 1` liveness probe on both PgSQLAdapter
 * and MySQLAdapter) is probed best-effort when present; subclasses
 * without it (SQLite) are assumed connected after a successful Init.
 *
 * @param {string} dstConnStr - SQLite connection string like 'sqlite:///C:/path/to/backup.sqlite3'.
 * @param {object} [options] - Optional { batchSize=500, onProgress?, srcAdapter? }.
 * @param {number} [options.batchSize=500] - rows per bulkInsert call.
 * @param {(p: PullProgress) => void} [options.onProgress] - progress callback for UI.
 * @param {import('./adapter/EngineAdapter.js').EngineAdapter} [options.srcAdapter] - ad-hoc source adapter. When present, ALL reads go to this instance instead of the singleton `adapter`, and the engine-type + liveness guards are skipped. The caller is responsible for initialisation and teardown.
 * @returns {Promise<PullResult>}
 */
export async function pullToSqlite(dstConnStr, options = {}) {
    const { batchSize = 500, onProgress, srcAdapter } = options;
    const src = srcAdapter ?? adapter;
    const errors = [];
    let rowsCopied = 0;
    let globalTables = 0;
    let userTables = 0;
    let unknownTables = 0;

    // ── 0. Guards ────────────────────────────────────────────────────
    // The source must NOT be a SQLiteAdapter. If it is, the user hasn't
    // switched engine + restarted yet — refuse to run rather than produce
    // a useless SQLite → SQLite copy that masquerades as a remote backup.
    //
    // When `srcAdapter` is provided (ad-hoc mode), the engine-type and
    // liveness checks are skipped — the caller is responsible for
    // providing a properly-initialised adapter. Ad-hoc adapters are
    // constructed on the caller side (see `advanced.js`), bypassing the
    // boot-time C# pool, so no singleton guard is needed.
    if (!srcAdapter) {
        const engine =
            /** @type {{ engineType?: string, isConnected?: () => Promise<boolean> }} */ (
                adapter
            ).engineType;
        if (!engine || engine === 'sqlite' || engine === 'unknown') {
            throw new Error(
                'pullToSqlite: source adapter is the default SQLite engine. ' +
                    'Switch VRCX_Database.mode to "postgresql", "mysql" or "mariadb" and ' +
                    'restart the app before running the backup.'
            );
        }
        const adapterAny = /** @type {{ isConnected?: () => Promise<boolean> }} */ (adapter);
        if (
            typeof adapterAny.isConnected === 'function' &&
            !await adapterAny.isConnected()
        ) {
            throw new Error(
                `pullToSqlite: ${engine} backend is not connected. ` +
                    'Check VRCX_Database.host/port/credentials and restart the app.'
            );
        }
    }

    const engine = src.engineType;

    // ── 1. Build destination SQLite adapter (read-write) ─────────────
    // The destination is a NEW file the user picked via a Save-As dialog.
    // `createAdapter` with a `sqlite:///path` URI constructs a
    // `SQLiteAdapter` in read-only mode by default; we override to
    // `Read Only=False` so SQLite creates the file if it doesn't exist
    // (proving the directory is writable) and opens existing files in
    // read-write mode for the bulkInsert writes.
    const dstAdapter = await createAdapter(
        /** @type {any} */ ({
            connection: dstConnStr,
            'Read Only': 'False'
        })
    );

    // ── 2. Enumerate source tables + split into global/user/unknown ──
    // PostgreSQL keeps global tables in the `public` schema and user
    // tables in per-account `account_*` schemas. Its `listTablesTypes`
    // only enumerates `account_*` tables (per its JSDoc), so we call the
    // PG-specific `listGlobalTablesTypes` extension for the global half.
    // `listGlobalTablesTypes` enumerates EVERY `public`-schema table, so
    // its result is whitelist-filtered below: known globals go to the
    // global group, anything else (upstream additions, legacy tables) to
    // the §5 mirror bucket — mirroring the MySQL branch's split.
    // MySQL/SQLite enumerate ALL tables flatly through `listTablesTypes`,
    // so we derive the global/user/unknown split from the whitelists.
    /** @type {Array<{tableName: string, columns: Array<{name: string, type: string, notNull: boolean, defaultValue: *, isPK: boolean, isHidden: boolean}>}>} */
    const globalSchema = [];
    /**
     * User tables as a per-prefix Map of copy tasks: `{ srcTable, dstTable, columns }`.
     * Keyed by prefix so §4 can wrap each prefix's tables in their own
     * transaction (per-account atomicity, 1 fsync per prefix).
     * Built uniformly for both PG (schema-qualified source → flat dest)
     * and MySQL (flat source → flat dest), so §4 has one code path.
     * @type {Map<string, Array<{srcTable: string, dstTable: string, columns: Array<{name: string, isHidden: boolean}>}>>}
     */
    const userTasksByPrefix = new Map();
    /** @type {string[]} non-whitelist table names to mirror in §5 */
    const unknownNames = [];
    /** @type {Map<string, {tableName: string, columns: Array}>} */
    const srcSchemaMap = new Map();

    const pgGlobalExt =
        /** @type {{ listGlobalTablesTypes?: () => Promise<Array<{tableName: string, columns: Array}>> } | null} */ (
            src
        );
    if (
        engine === 'postgresql' &&
        typeof pgGlobalExt?.listGlobalTablesTypes === 'function'
    ) {
        // PG: global tables in `public`, user tables in `account_*`.
        const pgGlobal = await pgGlobalExt.listGlobalTablesTypes();
        for (const entry of pgGlobal) {
            // A2 fix: whitelist-filter the public-schema enumeration, mirroring
            // the MySQL branch's global/unknown split. Known global tables go to
            // the global group; anything else (upstream additions, legacy tables)
            // is a data-integrity mirror candidate keyed by its schema-qualified
            // name so §5 can recreate it from real column metadata (A6).
            if (GLOBAL_TABLES.includes(stripSchemaPrefix(entry.tableName))) {
                globalSchema.push(entry);
            } else {
                unknownNames.push(entry.tableName);
                srcSchemaMap.set(entry.tableName, entry);
            }
        }
        const pgUser = await src.listTablesTypes();
        for (const entry of pgUser) {
            const { prefix, name } = splitPgUserTable(entry.tableName);
            if (!userTasksByPrefix.has(prefix)) {
                userTasksByPrefix.set(prefix, []);
            }
            userTasksByPrefix.get(prefix).push({
                srcTable: entry.tableName,
                dstTable: dstAdapter.userTable(prefix, name),
                columns: entry.columns
            });
        }
    } else {
        // MySQL (and the SQLite fallback, which we refuse above but keep
        // for robustness): enumerate all tables flatly, then split via
        // the whitelists. This mirrors `pushEngine.js` §4.
        const allTables = await src.listTablesTypes();
        /** @type {Map<string, string[]>} prefix -> list of user-table base names */
        const userTablesByPrefix = new Map();
        for (const entry of allTables) {
            const tableName = entry.tableName;
            if (!tableName) continue;
            srcSchemaMap.set(tableName, entry);
            if (GLOBAL_TABLES.includes(tableName)) {
                globalSchema.push(entry);
                continue;
            }
            const match = matchUserTable(tableName);
            if (match) {
                const { prefix, name } = match;
                if (!userTablesByPrefix.has(prefix)) {
                    userTablesByPrefix.set(prefix, []);
                }
                userTablesByPrefix.get(prefix).push(name);
            } else {
                unknownNames.push(tableName);
            }
        }
        // Group into per-prefix map so §4 has a single uniform loop
        // (same shape as the PG branch) + per-prefix transaction wrapping.
        for (const [prefix, names] of userTablesByPrefix) {
            if (!userTasksByPrefix.has(prefix)) {
                userTasksByPrefix.set(prefix, []);
            }
            for (const name of names) {
                const srcTable = `${prefix}_${name}`;
                const entry = srcSchemaMap.get(srcTable);
                userTasksByPrefix.get(prefix).push({
                    srcTable,
                    dstTable: dstAdapter.userTable(prefix, name),
                    columns: entry?.columns || []
                });
            }
        }
    }

    // ── 3. Ensure destination global schema exists + copy global tables ─
    // 整组包一个事务(目标 SQLite 单连接,1 次 fsync)。
    await dstAdapter.initGlobalSchema();
    const globalTotal = globalSchema.length;
    let globalIdx = 0;
    try {
        await dstAdapter.withTransaction(async () => {
            for (const { tableName, columns } of globalSchema) {
                globalIdx += 1;
                const dstTable = stripSchemaPrefix(tableName);
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'global',
                        table: dstTable,
                        current: globalIdx,
                        total: globalTotal,
                        rowsCopied
                    });
                }
                const copied = await copyTable(
                    src,
                    dstAdapter,
                    tableName,
                    dstTable,
                    batchSize,
                    columns
                );
                rowsCopied += copied;
                globalTables += 1;
            }
        });
    } catch (err) {
        errors.push(`global-group: ${err.message || String(err)}`);
    }

    // ── 4. Copy user tables (per-prefix transaction) ──────────────
    const userTotal = Array.from(userTasksByPrefix.values()).reduce(
        (acc, tasks) => acc + tasks.length,
        0
    );
    let userIdx = 0;
    for (const [prefix, tasks] of userTasksByPrefix) {
        try {
            await dstAdapter.withTransaction(async () => {
                await dstAdapter.initUserSchema(prefix);
                for (const task of tasks) {
                    userIdx += 1;
                    if (typeof onProgress === 'function') {
                        onProgress({
                            phase: 'user',
                            table: task.dstTable,
                            current: userIdx,
                            total: userTotal,
                            rowsCopied
                        });
                    }
                    const copied = await copyTable(
                        src,
                        dstAdapter,
                        task.srcTable,
                        task.dstTable,
                        batchSize,
                        task.columns
                    );
                    rowsCopied += copied;
                    userTables += 1;
                }
            });
        } catch (err) {
            errors.push(`user-group:${prefix}: ${err.message || String(err)}`);
        }
    }

    // ── 5. Mirror + copy unknown tables (data-integrity safety net) ───
    // Both branches produce unknowns: the MySQL/SQLite branch from the
    // flat `listTablesTypes` enumeration, the PG branch from non-whitelist
    // `public` tables (A2 fix — its `listGlobalTablesTypes` enumerates
    // every public table, not just the known globals). Every source table
    // not covered by the known global/user schema is recreated on the
    // destination from its column metadata (column-level PK + type mapping
    // only; UNIQUE/indexes are NOT re-created) then copied through the
    // same paged `copyTable`. The destination table is created under the
    // schema-stripped bare name (`public.x` → `x`). `configs` ∈
    // GLOBAL_TABLES, so it is copied in §3 under its original name, never
    // through this bucket.
    if (unknownNames.length > 0) {
        console.warn(
            `[备份] 发现 ${unknownNames.length} 张非白名单表，将镜像保底复制: ` +
                unknownNames.join(', ')
        );
    }
    const mirrorTotal = unknownNames.length;
    let mirrorIdx = 0;
    try {
        await dstAdapter.withTransaction(async () => {
            for (const srcTable of unknownNames) {
                mirrorIdx += 1;
                const dstTable = stripSchemaPrefix(srcTable);
                const entry = srcSchemaMap.get(srcTable);
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'mirror',
                        table: dstTable,
                        current: mirrorIdx,
                        total: mirrorTotal,
                        rowsCopied
                    });
                }
                const colDefs = buildMirroredColumns(entry);
                if (colDefs.length > 0) {
                    await dstAdapter.createTable(dstTable, colDefs);
                }
                const copied = await copyTable(
                    src,
                    dstAdapter,
                    srcTable,
                    dstTable,
                    batchSize,
                    entry?.columns || []
                );
                rowsCopied += copied;
                unknownTables += 1;
            }
        });
    } catch (err) {
        errors.push(`mirror-group: ${err.message || String(err)}`);
    }

    return {
        globalTables,
        userTables,
        unknownTables,
        rowsCopied,
        errors
    };
}

/**
 * Match a flat SQLite/MySQL table name against the 22 known user-table
 * base names. Symmetric to `pushEngine.js`'s `matchUserTable`.
 *
 * @param {string} tableName - flat table name like `abc_feed_gps`.
 * @returns {{prefix: string, name: string}|null}
 */
function matchUserTable(tableName) {
    for (const name of USER_TABLE_NAMES_BY_LENGTH_DESC) {
        const suffix = '_' + name;
        if (tableName.endsWith(suffix)) {
            const prefix = tableName.slice(0, tableName.length - suffix.length);
            if (prefix.length > 0) {
                return { prefix, name };
            }
            return null;
        }
    }
    return null;
}

/**
 * Strip a leading `public.` schema qualifier from a PG table identifier,
 * returning the bare table name. Non-PG identifiers pass through
 * unchanged.
 *
 * @param {string} table - optionally schema-qualified table name
 * @returns {string} bare table name
 */
function stripSchemaPrefix(table) {
    if (table.startsWith('public.')) {
        return table.slice('public.'.length);
    }
    return table;
}

/**
 * Split a PG schema-qualified user table identifier into `{ prefix, name }`.
 *
 * `'account_xxx.feed_gps'` → `{ prefix: 'xxx', name: 'feed_gps' }`.
 * The `account_` schema-name prefix is stripped to recover the bare
 * account hash, matching how `database/index.js` derives `userPrefix`
 * from `userId`.
 *
 * @param {string} table - `account_{prefix}.{name}` identifier
 * @returns {{prefix: string, name: string}}
 */
function splitPgUserTable(table) {
    const dot = table.indexOf('.');
    const schema = dot >= 0 ? table.slice(0, dot) : table;
    const name = dot >= 0 ? table.slice(dot + 1) : '';
    const prefix = schema.startsWith('account_')
        ? schema.slice('account_'.length)
        : schema;
    return { prefix, name };
}

/**
 * Copy all rows from `srcTable` (remote) to `dstTable` (SQLite), in
 * batches of `batchSize`. Reads the source in paged `LIMIT/OFFSET` chunks
 * and writes each batch via `bulkInsert(..., 'ignore')` so memory stays
 * bounded. Symmetric to `pushEngine.js`'s `copyTable`.
 *
 * @param {import('./adapter/EngineAdapter.js').EngineAdapter} srcAdapter
 * @param {import('./adapter/EngineAdapter.js').EngineAdapter} dstAdapter
 * @param {string} srcTable - source table identifier (PG: schema-qualified; MySQL: flat).
 * @param {string} dstTable - destination table identifier (SQLite flat).
 * @param {number} batchSize - rows per bulkInsert call.
 * @param {Array<{name: string, isHidden: boolean}>} columns - source column metadata.
 * @returns {Promise<number>} number of rows copied.
 */
async function copyTable(
    srcAdapter,
    dstAdapter,
    srcTable,
    dstTable,
    batchSize,
    columns
) {
    const visibleColumns = (columns || []).filter((c) => !c.isHidden);
    if (visibleColumns.length === 0) return 0;
    // MySQL 源(pull 方向)列名需反引号转义(key 是 MySQL 保留字);
    // SQLite/PG 源无 quoteIdent → 回退裸名(与 pushEngine copyTable 对称)。
    const srcQuoteIdent =
        /** @type {{ quoteIdent?: (name: string) => string } | null} */ (
            srcAdapter
        ).quoteIdent;
    const quote = (name) => srcQuoteIdent?.(name) ?? name;
    const colList = visibleColumns.map((c) => quote(c.name)).join(', ');

    // ── 游标分页(keyset pagination)─────────────────────────────────
    // 旧实现用 LIMIT/OFFSET,O(N²)。改用 WHERE pk > @lastPk ORDER BY pk
    // LIMIT @limit,O(N)。复合 PK 或无 PK 退回 OFFSET 模式。
    // 与 pushEngine.js 的 copyTable 对称。
    const pkCols = visibleColumns.filter((c) => c.isPK);
    const useCursor = pkCols.length === 1;
    const pkCol = useCursor ? pkCols[0].name : null;

    let lastPk = null;
    let offset = 0;
    let totalCopied = 0;
    while (true) {
        const batch = [];
        let sql;
        let params;
        if (useCursor) {
            if (lastPk === null) {
                sql = `SELECT ${colList} FROM ${srcTable} ORDER BY ${quote(pkCol)} LIMIT @limit`;
                params = { limit: batchSize };
            } else {
                sql = `SELECT ${colList} FROM ${srcTable} WHERE ${quote(pkCol)} > @lastPk ORDER BY ${quote(pkCol)} LIMIT @limit`;
                params = { limit: batchSize, lastPk };
            }
        } else {
            sql = `SELECT ${colList} FROM ${srcTable} LIMIT @limit OFFSET @offset`;
            params = { limit: batchSize, offset };
        }
        await srcAdapter.execute(
            (row) => {
                const obj = {};
                visibleColumns.forEach((col, i) => {
                    // DBNull 经 C# 封送/JSON 序列化为 null/undefined,统一
                    // 兜底为 null,避免 undefined 作为参数传回 C# 时被跳过。
                    obj[col.name] = row[i] ?? null;
                });
                batch.push(obj);
            },
            sql,
            params
        );
        if (batch.length === 0) break;
        await dstAdapter.bulkInsert(dstTable, batch, 'ignore');
        totalCopied += batch.length;
        if (useCursor) {
            const lastRow = batch[batch.length - 1];
            lastPk = lastRow[pkCol];
        } else {
            offset += batch.length;
        }
        if (batch.length < batchSize) break;
    }

    // Row-count verification: totalCopied 是源侧实际读到的行数,等价于
    // srcCount 但无需全表 COUNT。只校验 dstCount == totalCopied。
    // 与 pushEngine.js 对称。
    // TODO(review #7):当 push/pull 支持增量/合并场景时,目标可能已有
    // 数据,bulkInsert('ignore') 遇 PK 冲突跳过行,导致 dstCount <
    // totalCopied。此时本校验无法区分"源读丢失"(真 bug)与"目标冲突
    // 跳过"(正常)。需要让 bulkInsert 返回实际写入行数(affected rows),
    // 在 copyTable 中累加 actualInserted,用 actualInserted 替代
    // totalCopied 与 dstCount 比较。这需要 C# 三引擎 + JS 三 adapter +
    // 基类协同改造(目前 bulkInsert 返回 Promise<void>),应在增量/合并
    // 功能落地时一并实施。
    const dstCount = await dstAdapter.countWhere(dstTable);
    if (dstCount !== totalCopied) {
        throw new Error(
            `row count mismatch after copy: copied=${totalCopied} dst=${dstCount}`
        );
    }

    return totalCopied;
}

/**
 * Build structured column definitions for mirroring an unknown source table
 * onto the destination via `adapter.createTable`. Symmetric to
 * `pushEngine.js`'s `buildMirroredColumns`.
 *
 * @param {{tableName: string, columns: Array<{name: string, type: string, notNull: boolean, defaultValue: *, isPK: boolean, isHidden: boolean}>}|undefined} tableMeta
 * @returns {object[]} column defs for `createTable`
 */
function buildMirroredColumns(tableMeta) {
    if (!tableMeta || !Array.isArray(tableMeta.columns)) return [];
    const visible = tableMeta.columns.filter((c) => !c.isHidden);
    if (visible.length === 0) return [];
    const pkCols = visible.filter((c) => c.isPK).map((c) => c.name);
    /** @type {object[]} */
    const cols = visible.map((c) => {
        /** @type {string[]} */
        const cons = [];
        if (c.notNull) cons.push('NOT NULL');
        if (c.defaultValue != null && c.defaultValue !== '') {
            const dv = c.defaultValue;
            if (typeof dv === 'object') {
                cons.push(
                    `DEFAULT '${JSON.stringify(dv).replace(/'/g, "''")}'`
                );
            } else if (typeof dv === 'number' || typeof dv === 'boolean') {
                cons.push(`DEFAULT ${dv}`);
            } else {
                cons.push(
                    `DEFAULT '${String(dv).replace(/'/g, "''")}'`
                );
            }
        }
        if (pkCols.length === 1 && c.isPK) cons.push('PRIMARY KEY');
        /** @type {{name: string, type: string, constraints?: string}} */
        const def = { name: c.name, type: c.type || 'TEXT' };
        if (cons.length > 0) def.constraints = cons.join(' ');
        return def;
    });
    if (pkCols.length > 1) {
        cols.push(
            /** @type {object} */ (
                /** @type {unknown} */ (`PRIMARY KEY (${pkCols.join(', ')})`)
            )
        );
    }
    return cols;
}

export { GLOBAL_TABLES, USER_TABLE_NAMES };
