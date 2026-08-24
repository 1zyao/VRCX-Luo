import { EngineAdapter } from './EngineAdapter.js';

// Once-per-process dedup for the readonly-error warn (L-1 / browse mode):
// a single misleading modal was replaced by a recognizable warn — repeated
// readonly rejections (e.g. browse backstop writes) must not spam the log.
const _readonlyWarnedMessages = new Set();

/**
 * SQLite dialect adapter.
 *
 * Encapsulates SQLite-specific syntax (INSERT OR IGNORE/REPLACE, @-params,
 * IF NOT EXISTS, etc.). All SQLite dialect keywords are centralized here —
 * when switching engines, replace this adapter's implementation.
 *
 * Business logic modules (feed.js, gameLog.js, etc.) call these methods with
 * structured parameters and never construct SQL strings directly.
 */
class SQLiteAdapter extends EngineAdapter {
    /** @type {string|null} */
    connectionString = null;

    /**
     * Engine type identifier — used by the migration runner's
     * `getDatabaseEngine()` to detect the active engine from the
     * singleton adapter without importing adapter classes or re-reading
     * `VRCXStorage`. Aligns with the MySQL branch's `engineType` getter
     * mechanism (SQLiteAdapter → 'sqlite', PgSQLAdapter → 'postgresql',
     * MySQLAdapter → 'mysql').
     *
     * @override
     * @type {string}
     */
    get engineType() {
        return 'sqlite';
    }

    /**
     * @param {object} [config]
     * @param {string} [config.connection] - sqlite:/// URI 或连接字符串
     * @param {...object} [config.params] - 额外连接参数（覆盖默认）
     */
    constructor({ connection, ...params } = {}) {
        super();
        if (connection) {
            this.connectionString = this._buildConnectionString(
                connection,
                params
            );
        }
    }

    /** @override */
    _normalizeArgs(args) {
        if (args && typeof args === 'object' && !Array.isArray(args)) {
            const prefixed = {};
            for (const [k, v] of Object.entries(args)) {
                prefixed[k.startsWith('@') ? k : `@${k}`] = v;
            }
            return prefixed;
        }
        return args;
    }

    /** @private */
    async handleSQLiteError(e) {
        if (
            typeof e.message !== 'string' ||
            (typeof window !== 'undefined' && window.isVrOverlay)
        )
            throw e;
        const msg = e.message;
        const isReadOnly = msg.includes('attempt to write a readonly database');
        const isMalformed = msg.includes('database disk image is malformed');
        const isFull = msg.includes('database or disk is full');
        const isLocked = msg.includes('database is locked');
        const isIO = msg.includes('disk I/O error');
        if (!isReadOnly && !isMalformed && !isFull && !isLocked && !isIO)
            throw e;

        // Readonly rejection is expected when the pool is opened read-only
        // (browse mode backstop for writes bypassing the gate) — log once
        // and rethrow instead of showing the misleading "Database is locked"
        // modal. The caller still receives the underlying error.
        if (isReadOnly) {
            if (!_readonlyWarnedMessages.has(msg)) {
                _readonlyWarnedMessages.add(msg);
                // F-2 日志注入防护：SQLite 错误消息可内嵌 SQL 语句与绑定数据
                // （feed 等用户内容），只输出稳定摘要不回显原始消息；去重仍按
                // 完整消息文本（同消息不刷屏），原始错误完整 rethrow 给调用方。
                console.warn(
                    '[browse] SQLite 只读错误（写入被拒绝，SQLITE_READONLY）'
                );
            }
            throw e;
        }

        const [{ useModalStore }, { i18n }, { openExternalLink }] =
            await Promise.all([
                import('../../../stores/modal'),
                import('../../../plugins/i18n'),
                import('../../../shared/utils/appActions')
            ]);
        const modalStore = useModalStore();
        if (isMalformed) {
            modalStore
                .confirm({
                    description:
                        'Please repair or delete your database file by following these instructions.',
                    title: 'Your database is corrupted'
                })
                .then(({ ok }) => {
                    if (!ok) return;
                    openExternalLink(
                        'https://github.com/vrcx-team/VRCX/wiki#how-to-repair-vrcx-database'
                    );
                })
                .catch(() => {});
        }
        if (isFull) {
            modalStore.alert({
                description: i18n.global.t('message.database.disk_space'),
                title: 'Disk containing database is full'
            });
        }
        if (isLocked) {
            modalStore.alert({
                description:
                    'Please close other applications that might be using the database file.',
                title: 'Database is locked'
            });
        }
        if (isIO) {
            modalStore.alert({
                description: i18n.global.t('message.database.disk_error'),
                title: 'Disk I/O error'
            });
        }
        throw e;
    }

    /**
     * @private Build SQLite connection string from sqlite:// URI + custom params.
     *
     * Uses manual prefix stripping instead of `new URL()` — file paths are not URLs,
     * and URL parsing percent-encodes spaces/non-ASCII and truncates at `#`/`?`.
     *
     * URI forms accepted:
     *   sqlite:///C:\path\db.sqlite   → Windows drive-letter path
     *   sqlite:////home/user/db.sqlite → Linux absolute path (extra slash from caller)
     *   sqlite://host/share/db.sqlite  → UNC path (\\host\share\db.sqlite)
     */
    _buildConnectionString(uri, params = {}) {
        let dataSource;
        const rest = uri.slice('sqlite://'.length);

        if (rest.startsWith('/')) {
            // Local path
            if (WINDOWS) {
                // /C:\path → C:\path (strip all leading slashes for drive-letter paths)
                dataSource = rest.replace(/^\/+/, '');
            } else {
                // //home/path → /home/path (collapse multiple leading slashes to one)
                dataSource = rest.replace(/^\/{2,}/, '/');
            }
        } else {
            // UNC path: host/share/path → \\host\share\path
            const slashIdx = rest.indexOf('/');
            if (slashIdx === -1) {
                dataSource = `\\\\${rest}`;
            } else {
                const host = rest.slice(0, slashIdx);
                const path = rest.slice(slashIdx).replace(/\//g, '\\');
                dataSource = `\\\\${host}${path}`;
            }
        }

        const defaults = {
            'Data Source': `"${dataSource.replace(/"/g, '""')}"`,
            'Read Only': 'True',
            Version: '3'
        };

        const merged = { ...defaults, ...params };
        return Object.entries(merged)
            .map(([k, v]) => `${k}=${v}`)
            .join(';');
    }

    /** Execute raw SQL with row callback. Normalizes named-param keys. */
    async execute(callback, sql, args) {
        args = this._normalizeArgs(args);
        const connId = this._txStack.at(-1);
        try {
            if (this.connectionString) {
                if (LINUX && args) {
                    args = new Map(Object.entries(args));
                }
                const json = await SQLite.ExecuteJsonOnConnection(
                    this.connectionString,
                    sql,
                    args,
                    connId
                );
                const items = JSON.parse(json);
                items.forEach((item) => {
                    callback(item);
                });
                return;
            }
            if (connId !== undefined) {
                if (LINUX && args) {
                    args = new Map(Object.entries(args));
                }
                const json = await SQLite.ExecuteJson(sql, args, connId);
                const items = JSON.parse(json);
                items.forEach((item) => {
                    callback(item);
                });
                return;
            }
            if (LINUX) {
                if (args) {
                    args = new Map(Object.entries(args));
                }
                const json = await SQLite.ExecuteJson(sql, args, connId);
                const items = JSON.parse(json);
                items.forEach((item) => {
                    callback(item);
                });
                return;
            }
            const data = await SQLite.Execute(sql, args, connId);
            data.forEach((row) => {
                callback(row);
            });
        } catch (e) {
            await this.handleSQLiteError(e);
        }
    }

    /**
     * Execute raw SQL without row callback. Normalizes named-param keys.
     * @param {string} sql - SQL statement
     * @param {object|Array|null} [args] - named or positional parameters
     * @returns {Promise<number>}
     */
    async executeNonQuery(sql, args) {
        args = this._normalizeArgs(args);
        const connId = this._txStack.at(-1);
        try {
            if (this.connectionString) {
                if (LINUX && args) {
                    args = new Map(Object.entries(args));
                }
                return await SQLite.ExecuteNonQueryOnConnection(
                    this.connectionString,
                    sql,
                    args,
                    connId
                );
            }
            if (connId !== undefined) {
                if (LINUX && args) {
                    args = new Map(Object.entries(args));
                }
                return await SQLite.ExecuteNonQuery(sql, args, connId);
            }
            if (LINUX && args) {
                args = new Map(Object.entries(args));
            }
            return await SQLite.ExecuteNonQuery(sql, args, connId);
        } catch (e) {
            await this.handleSQLiteError(e);
        }
    }

    /** @private Map 'ignore'|'replace' to OR IGNORE|OR REPLACE clause. */
    _insertClause(conflict) {
        return conflict === 'ignore'
            ? 'OR IGNORE'
            : conflict === 'replace'
              ? 'OR REPLACE'
              : '';
    }

    /**
     * Single-row INSERT with optional conflict handling.
     * @param {string} table - target table name (with prefix if applicable)
     * @param {object} data - column:value mapping (snake_case keys)
     * @param {string} [conflict] - 'ignore' → INSERT OR IGNORE, 'replace' → INSERT OR REPLACE
     */
    insert(table, data, conflict) {
        const clause = this._insertClause(conflict);
        const columns = Object.keys(data);
        const params = {};
        const values = columns.map((col) => {
            params[col] = data[col];
            return `@${col}`;
        });
        return this.executeNonQuery(
            `INSERT ${clause} INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')})`,
            params
        );
    }

    /**
     * Bulk multi-row INSERT with optional conflict handling.
     * @param {string} table - target table name
     * @param {object[]} rows - array of column:value objects (all must share the same keys)
     * @param {string} [conflict] - 'ignore' → INSERT OR IGNORE, 'replace' → INSERT OR REPLACE
     */
    async bulkInsert(table, rows, conflict) {
        if (rows.length === 0) return;
        const clause = this._insertClause(conflict);
        const columns = Object.keys(rows[0]);
        const params = {};
        const values = rows.map((row, i) => {
            return (
                '(' +
                columns
                    .map((col) => {
                        params[`${col}_${i}`] = row[col];
                        return `@${col}_${i}`;
                    })
                    .join(', ') +
                ')'
            );
        });
        return this.executeNonQuery(
            `INSERT ${clause} INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`,
            params
        );
    }

    /**
     * UPDATE with equality conditions.
     * @param {string} table - target table name
     * @param {object} data - columns to SET (key:value)
     * @param {object} where - equality conditions (AND-ed)
     */
    update(table, data, where) {
        const params = {};
        const setClauses = Object.keys(data).map((col) => {
            params[`set_${col}`] = data[col];
            return `${col} = @set_${col}`;
        });
        const whereClauses = Object.keys(where).map((col) => {
            params[`where_${col}`] = where[col];
            return `${col} = @where_${col}`;
        });
        return this.executeNonQuery(
            `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
            params
        );
    }

    /**
     * UPDATE with raw WHERE clause (non-equality conditions).
     * @param {string} table - target table name
     * @param {object} data - columns to SET (key:value)
     * @param {string} whereClause - raw WHERE content (without the WHERE keyword)
     * @param {object} [params] - named parameters
     */
    updateWhere(table, data, whereClause, params = {}) {
        const setClauses = Object.keys(data).map((col) => {
            params[`set_${col}`] = data[col];
            return `${col} = @set_${col}`;
        });
        return this.executeNonQuery(
            `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClause}`,
            params
        );
    }

    /**
     * DELETE with equality conditions.
     * @param {string} table - target table name
     * @param {object} where - equality conditions (AND-ed)
     */
    delete(table, where) {
        const params = {};
        const clauses = Object.keys(where).map((col) => {
            params[col] = where[col];
            return `${col} = @${col}`;
        });
        return this.executeNonQuery(
            `DELETE FROM ${table} WHERE ${clauses.join(' AND ')}`,
            params
        );
    }

    /**
     * DELETE all rows from a table.
     * @param {string} table - target table name
     */
    deleteAll(table) {
        return this.executeNonQuery(`DELETE FROM ${table}`);
    }

    /** DROP TABLE IF EXISTS. */
    dropTable(table) {
        return this.executeNonQuery(`DROP TABLE IF EXISTS ${table}`);
    }

    /**
     * DELETE with raw WHERE clause (non-equality conditions).
     * @param {string} table - target table name
     * @param {string} whereClause - raw WHERE content (without the WHERE keyword)
     * @param {object} [params] - named parameters
     */
    deleteWhere(table, whereClause, params = {}) {
        return this.executeNonQuery(
            `DELETE FROM ${table} WHERE ${whereClause}`,
            params
        );
    }

    /**
     * SELECT one row with equality WHERE and LIMIT 1.
     * @returns {Promise<Array|null>} row as array, or null if not found
     */
    async selectOne(table, columns, where) {
        const params = {};
        const clauses = Object.keys(where).map((col) => {
            params[col] = where[col];
            return `${col} = @${col}`;
        });
        const colStr = Array.isArray(columns) ? columns.join(', ') : columns;
        let result = null;
        await this.execute(
            (row) => {
                result = row;
            },
            `SELECT ${colStr} FROM ${table} WHERE ${clauses.join(' AND ')} LIMIT 1`,
            params
        );
        return result;
    }

    /**
     * SELECT rows with equality conditions. Omit `where` to select all rows.
     * @param {object} [where] - equality conditions (AND-ed), omit for no WHERE clause
     * @param {object} [options] - { order, limit, distinct }
     * @returns {Promise<Array<Array>>} array of row arrays
     */
    async select(table, columns, where, options = {}) {
        const { order, limit, distinct } = options;
        const colStr = Array.isArray(columns) ? columns.join(', ') : columns;
        const distinctStr = distinct ? 'DISTINCT ' : '';
        let sql = `SELECT ${distinctStr}${colStr} FROM ${table}`;
        const params = {};
        if (where && Object.keys(where).length > 0) {
            const clauses = Object.keys(where).map((col) => {
                params[col] = where[col];
                return `${col} = @${col}`;
            });
            sql += ` WHERE ${clauses.join(' AND ')}`;
        }
        if (order) sql += ` ORDER BY ${order}`;
        if (limit) sql += ` LIMIT ${limit}`;
        const rows = [];
        await this.execute((row) => rows.push(row), sql, params);
        return rows;
    }

    /**
     * SELECT with raw WHERE clause string (for complex filters, LIKE, date ranges).
     * @param {string} [whereClause] - raw WHERE content (without the WHERE keyword), null to skip
     * @param {object} [params] - named parameters for the WHERE clause
     * @param {object} [options] - { order, limit, distinct }
     * @returns {Promise<Array<Array>>} array of row arrays
     */
    async selectWhere(table, columns, whereClause, params, options = {}) {
        const { order, limit, distinct } = options;
        const colStr = Array.isArray(columns) ? columns.join(', ') : columns;
        const distinctStr = distinct ? 'DISTINCT ' : '';
        let sql = `SELECT ${distinctStr}${colStr} FROM ${table}`;
        if (whereClause) sql += ` WHERE ${whereClause}`;
        if (order) sql += ` ORDER BY ${order}`;
        if (limit) sql += ` LIMIT ${limit}`;
        const rows = [];
        await this.execute((row) => rows.push(row), sql, params);
        return rows;
    }

    /**
     * SELECT with JOIN(s), raw WHERE, ORDER BY, LIMIT.
     *
     * JOIN 语法跨引擎高度一致，方言差异仅限于 LIMIT/ORDER BY 位置（已由 options 处理）。
     * 接受完整的表别名和 ON 子句，由调用方保证列歧义消除。
     *
     * @param {object} spec
     * @param {string}   spec.from       - 主表名
     * @param {string}   [spec.alias]    - 主表别名
     * @param {Array<{type:string, table:string, alias?:string, on:string}>} [spec.joins] - JOIN 描述
     * @param {string[]|string} spec.columns - SELECT 列
     * @param {string}   [spec.where]    - WHERE 子句（raw）
     * @param {object}   [spec.params]   - 命名参数
     * @param {string}   [spec.order]    - ORDER BY
     * @param {number}   [spec.limit]    - LIMIT
     * @returns {Promise<Array<Array>>}
     */
    async selectJoin(spec) {
        const { from, alias, joins, columns, where, params, order, limit } =
            spec;
        let sql = `SELECT ${Array.isArray(columns) ? columns.join(', ') : columns} FROM ${from}`;
        if (alias) sql += ` ${alias}`;
        if (joins) {
            for (const j of joins) {
                sql += ` ${j.type} JOIN ${j.table}`;
                if (j.alias) sql += ` ${j.alias}`;
                sql += ` ON ${j.on}`;
            }
        }
        if (where) sql += ` WHERE ${where}`;
        if (order) sql += ` ORDER BY ${order}`;
        if (limit) sql += ` LIMIT ${limit}`;
        const rows = [];
        await this.execute((row) => rows.push(row), sql, params);
        return rows;
    }

    /**
     * SELECT with WHERE col IN (...) + optional extra conditions.
     * Builds named params for the IN list to avoid SQL injection.
     * @param {string} inColumn - column name for IN clause
     * @param {*[]} inValues - values for IN list
     * @param {string} [extraWhere] - additional AND conditions (raw SQL fragment)
     * @param {object} [extraParams] - named params for extraWhere
     * @param {object} [options] - { order, limit }
     * @returns {Promise<Array<Array>>} array of row arrays
     */
    async selectWhereIn(
        table,
        columns,
        inColumn,
        inValues,
        extraWhere,
        extraParams,
        options = {}
    ) {
        if (!inValues || inValues.length === 0) return [];
        const { order, limit } = options;
        const params = { ...(extraParams || {}) };
        const placeholders = inValues.map((v, i) => {
            params[`in_${i}`] = v;
            return `@in_${i}`;
        });
        const colStr = Array.isArray(columns) ? columns.join(', ') : columns;
        let sql = `SELECT ${colStr} FROM ${table} WHERE ${inColumn} IN (${placeholders.join(', ')})`;
        if (extraWhere) sql += ` AND ${extraWhere}`;
        if (order) sql += ` ORDER BY ${order}`;
        if (limit) sql += ` LIMIT ${limit}`;
        const rows = [];
        await this.execute((row) => rows.push(row), sql, params);
        return rows;
    }

    /**
     * UNION ALL across multiple sources with optional outer ORDER BY + LIMIT.
     *
     * Each source defines a sub-SELECT. `columns` are real columns for that table;
     * `nulls` are columns that should appear as NULL in this branch (for column alignment).
     * Pass `columns` as a raw SQL string (with `'Literal' AS type`, `NULL AS col`)
     * and omit `nulls` to handle complex interleaved column layouts.
     * All sources' params are merged together (they should use distinct or shared keys).
     *
     * SQLite compound-select 语法限制：
     * 1. 分支内不允许 ORDER BY / LIMIT（只能出现在整个 compound select 末尾）
     * 2. 不支持 `(SELECT ...) UNION ALL (SELECT ...)` 分支括号语法
     * 解决：每个分支包装成 `SELECT * FROM (branch)` 派生表，分支内的
     * ORDER BY/LIMIT 在派生表内部合法，UNION ALL 分支本身无外层括号。
     *
     * @param {object[]} sources - Array of { table, columns?, nulls?, where?, params?, order?, limit? }
     * @param {object}   [options] - { schema?, order?, limit? }
     *   schema: outer column list (default '*'), order: outer ORDER BY, limit: outer LIMIT
     * @returns {Promise<Array<Array>>}
     */
    async selectUnion(sources, options = {}) {
        if (!sources || sources.length === 0) return [];
        const { schema, order, limit } = options;
        const allParams = {};
        const parts = sources.map((source) => {
            const {
                table,
                columns,
                nulls,
                where,
                params,
                order: srcOrder,
                limit: srcLimit
            } = source;
            if (params) Object.assign(allParams, params);
            let colStr = Array.isArray(columns)
                ? columns.join(', ')
                : columns || '*';
            if (nulls && nulls.length > 0) {
                colStr +=
                    ', ' + nulls.map((col) => `NULL AS ${col}`).join(', ');
            }
            let sql = `SELECT ${colStr} FROM ${table}`;
            if (where) sql += ` WHERE ${where}`;
            if (srcOrder) sql += ` ORDER BY ${srcOrder}`;
            if (srcLimit) sql += ` LIMIT ${srcLimit}`;
            // Wrap each branch as a derived table so that per-branch
            // ORDER BY/LIMIT is legal inside, while the UNION ALL branches
            // themselves stay unparenthesised (SQLite requirement).
            return `SELECT * FROM (${sql})`;
        });
        const outerSchema = schema
            ? Array.isArray(schema)
                ? schema.join(', ')
                : schema
            : '*';
        let finalSql = `SELECT ${outerSchema} FROM (${parts.join(' UNION ALL ')})`;
        if (order) finalSql += ` ORDER BY ${order}`;
        if (limit) finalSql += ` LIMIT ${limit}`;
        const rows = [];
        await this.execute((row) => rows.push(row), finalSql, allParams);
        return rows;
    }

    /**
     * SELECT with GROUP BY and aggregate expressions.
     *
     * @param {string} table
     * @param {object} spec
     * @param {string[]|string} [spec.columns] - non-aggregate SELECT columns (GROUP BY columns)
     * @param {Array<{expr:string, alias:string}>} [spec.aggregates] - aggregate expressions
     * @param {string[]|string} [spec.groupBy] - GROUP BY columns
     * @param {string} [spec.where] - raw WHERE clause
     * @param {object} [spec.params] - named params for WHERE
     * @param {string} [spec.order] - ORDER BY clause
     * @param {number} [spec.limit] - LIMIT
     * @param {string} [spec.having] - HAVING clause
     * @returns {Promise<Array<Array>>}
     */
    async selectGroupBy(table, spec) {
        // 这一坨参数叠叠乐是 GROUP BY 查询本身所需的复杂度，不是设计失误。
        // 总比让调用方手写 SELECT COUNT(*) FROM ... GROUP BY ... 然后每个引擎重写一遍好。
        const {
            columns,
            aggregates,
            groupBy,
            where,
            params,
            order,
            limit,
            having
        } = spec;
        const colParts = [];
        if (columns) {
            colParts.push(
                Array.isArray(columns) ? columns.join(', ') : columns
            );
        }
        if (aggregates) {
            for (const agg of aggregates) {
                colParts.push(`${agg.expr} AS ${agg.alias}`);
            }
        }
        let sql = `SELECT ${colParts.join(', ')} FROM ${table}`;
        if (where) sql += ` WHERE ${where}`;
        if (groupBy) {
            sql += ` GROUP BY ${Array.isArray(groupBy) ? groupBy.join(', ') : groupBy}`;
        }
        if (having) sql += ` HAVING ${having}`;
        if (order) sql += ` ORDER BY ${order}`;
        if (limit) sql += ` LIMIT ${limit}`;
        const rows = [];
        await this.execute((row) => rows.push(row), sql, params);
        return rows;
    }

    /**
     * Enumerate table names matching a LIKE pattern.
     * Wraps sqlite_schema query — dialect-specific, engine-dependent.
     * @param {string} likePattern - e.g. '%_feed_gps'
     * @returns {Promise<string[]>} matching table names
     */
    async listTables(likePattern) {
        const tables = [];
        await this.execute(
            (row) => tables.push(row[0]),
            `SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE @pattern`,
            { pattern: likePattern }
        );
        return tables;
    }

    /**
     * Get column metadata for a table.
     * SQLite: PRAGMA table_xinfo(table)
     * PgSQL:  SELECT column_name, data_type, is_nullable FROM information_schema.columns
     * MySQL:  SHOW COLUMNS FROM table
     * @param {string} table - table name
     * @returns {Promise<Array<Array>>} rows as positional arrays
     */
    async getTableColumns(table) {
        const rows = [];
        await this.execute(
            (row) => rows.push(row),
            `PRAGMA table_xinfo("${table}")`
        );
        return rows;
    }

    /**
     * Enumerate all user tables with their column metadata.
     *
     * Combines sqlite_schema enumeration with PRAGMA table_xinfo per table.
     * Returns structured objects instead of positional arrays.
     *
     * @returns {Promise<Array<{tableName: string, columns: Array<{name: string, type: string, notNull: boolean, defaultValue: *, isPK: boolean, isHidden: boolean}>}>>}
     */
    async listTablesTypes() {
        const tableRows = [];
        await this.execute(
            (r) => tableRows.push(r),
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        );

        const result = [];
        for (const [tableName] of tableRows) {
            const colRows = [];
            await this.execute(
                (r) => colRows.push(r),
                `PRAGMA table_xinfo("${tableName}")`
            );
            result.push({
                tableName,
                columns: colRows.map((c) => ({
                    name: c[1],
                    type: c[2],
                    notNull: !!c[3],
                    defaultValue: c[4],
                    isPK: !!c[5],
                    isHidden: !!c[6]
                }))
            });
        }
        return result;
    }

    /** COUNT with equality conditions. */
    async count(table, where) {
        const params = {};
        const clauses = Object.keys(where).map((col) => {
            params[col] = where[col];
            return `${col} = @${col}`;
        });
        let result = 0;
        await this.execute(
            (row) => {
                result = row[0];
            },
            `SELECT COUNT(*) FROM ${table} WHERE ${clauses.join(' AND ')}`,
            params
        );
        return result;
    }

    /** COUNT with raw WHERE clause. Omit whereClause to COUNT all rows. */
    async countWhere(table, whereClause, params) {
        let result = 0;
        await this.execute(
            (row) => {
                result = row[0];
            },
            `SELECT COUNT(*) FROM ${table}${whereClause ? ` WHERE ${whereClause}` : ''}`,
            params
        );
        return result;
    }

    /**
     * CREATE TABLE IF NOT EXISTS from structured column definitions.
     * @param {object[]} columns - [{ name, type, constraints? }] or raw string for simple defs
     */
    createTable(tableName, columns) {
        const colDefs = columns.map((col) => {
            if (typeof col === 'string') return col;
            const constraints = col.constraints ? ` ${col.constraints}` : '';
            return `${col.name} ${col.type}${constraints}`;
        });
        return this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(', ')})`
        );
    }

    /** CREATE INDEX IF NOT EXISTS. */
    createIndex(indexName, table, columns, unique = false) {
        const uniqueStr = unique ? 'UNIQUE ' : '';
        const colStr = Array.isArray(columns) ? columns.join(', ') : columns;
        return this.executeNonQuery(
            `CREATE ${uniqueStr}INDEX IF NOT EXISTS ${indexName} ON ${table} (${colStr})`
        );
    }

    /** ALTER TABLE ADD COLUMN. */
    alterTableAddColumn(table, columnDef) {
        return this.executeNonQuery(
            `ALTER TABLE ${table} ADD COLUMN ${columnDef}`
        );
    }

    /** ALTER TABLE DROP COLUMN. */
    alterTableDropColumn(table, column) {
        return this.executeNonQuery(
            `ALTER TABLE ${table} DROP COLUMN ${column}`
        );
    }

    /** ALTER TABLE RENAME TO. */
    alterTableRename(table, newName) {
        return this.executeNonQuery(
            `ALTER TABLE ${table} RENAME TO ${newName}`
        );
    }

    /**
     * Compute ISO date string for N days ago.
     * Replaces SQLite datetime('now', '-N days') in SQL with a pre-computed JS value.
     * @param {number} days - number of days to go back
     * @returns {string} ISO date string
     */
    daysAgoISO(days) {
        return new Date(Date.now() - days * 86400000).toISOString();
    }

    /**
     * SQL expression: convert ISO datetime column to Unix milliseconds.
     * SQLite: (strftime('%s', column) * 1000)
     * @param {string} column - column name containing ISO datetime
     * @returns {string} SQL expression
     */
    sqlToUnixMs(column) {
        return `(strftime('%s', ${column}) * 1000)`;
    }

    /**
     * SQL expression: extract world ID from a location string (e.g. "wrld_xxx:12345" → "wrld_xxx").
     * SQLite: SUBSTR(location, 1, INSTR(location, ':') - 1)
     * @param {string} column - column name containing full location string
     * @returns {string} SQL expression
     */
    sqlExtractWorldId(column) {
        return `SUBSTR(${column}, 1, INSTR(${column}, ':') - 1)`;
    }

    /**
     * SQL expression: check if a location string has an instance ID (contains ':').
     * SQLite: INSTR(column, ':') > 0
     * PostgreSQL: POSITION(':' IN column) > 0 or strpos(column, ':') > 0
     * @param {string} column - column name containing location
     * @returns {string} SQL expression
     */
    sqlHasInstanceId(column) {
        return `INSTR(${column}, ':') > 0`;
    }

    /**
     * SQL expression: extract date part from an ISO datetime column.
     * SQLite/PostgreSQL: date(column)
     * @param {string} column - column name containing ISO datetime
     * @returns {string} SQL expression
     */
    sqlDate(column) {
        return `date(${column})`;
    }

    /**
     * SQL expression: compute the "enter time" from a leave event record.
     *
     * ── 2026-07-08 后代开发者吐槽 ──
     * 这个方法的出现是因为 gamelog_join_leave 表只记录了"离开事件"（created_at）
     * 和"停留时长"（time, 毫秒），没有记录"进入时间"。
     * 为了做两人是否同时在线的时间重叠检测，不得不用离开时间减去时长来推算进入时间。
     *
     * 如果当年设计表的时候就加一列 entered_at，这整个方法都不需要存在。
     * 现在加列需要改表结构 + migration + 数据回填，成本远大于保留这个函数。
     * 所以它就在这里了——一个推算函数，不是翻译器。
     *
     * 协议：input 是 ISO 时间戳列名 + 毫秒数列名，
     *       output 是和 ISO 时间戳字符串可比较的表达式。
     * ──────────────────────────────────
     *
     * gamelog_join_leave stores OnPlayerLeft events with:
     *   created_at — ISO timestamp when the player left
     *   time       — duration spent in the instance (milliseconds)
     *
     * The actual enter time is: created_at - time (in ms).
     *
     * @param {string} tsColumn  - column name of the ISO leave timestamp
     * @param {string} msColumn  - column name of the duration in milliseconds
     * @returns {string} SQL expression that evaluates to the enter timestamp
     */
    sqlEnterTime(tsColumn, msColumn) {
        return `strftime('%Y-%m-%dT%H:%M:%SZ', ${tsColumn}, '-' || (${msColumn} * 1.0 / 1000) || ' seconds')`;
    }

    /**
     * UPDATE with arithmetic expression: SET col = col + @amount WHERE conditions.
     * @param {string} table - target table name
     * @param {string} column - column to increment
     * @param {number} amount - value to add
     * @param {object} where - equality conditions (AND-ed)
     */
    increment(table, column, amount, where) {
        const params = { amount };
        const whereClauses = Object.keys(where).map((col) => {
            params[`where_${col}`] = where[col];
            return `${col} = @where_${col}`;
        });
        return this.executeNonQuery(
            `UPDATE ${table} SET ${column} = ${column} + @amount WHERE ${whereClauses.join(' AND ')}`,
            params
        );
    }

    /**
     * INSERT with partial ON CONFLICT UPDATE.
     *
     * Writes insertData on fresh row; on conflict only updates the columns
     * listed in updateData (leaving other existing columns unchanged).
     *
     * SQLite/PgSQL:  INSERT ... ON CONFLICT(col) DO UPDATE SET ...
     * MySQL:         INSERT ... ON DUPLICATE KEY UPDATE ...
     *
     * @param {string} table          - target table name
     * @param {object} insertData     - all columns for INSERT
     * @param {object} updateData     - subset of columns for UPDATE on conflict
     * @param {string} conflictColumn - column to detect conflict on
     */
    upsertPartial(table, insertData, updateData, conflictColumn) {
        const columns = Object.keys(insertData);
        const params = {};
        const values = columns.map((col) => {
            params[col] = insertData[col];
            return `@${col}`;
        });
        const updateClauses = Object.keys(updateData).map((col) => {
            params[`up_${col}`] = updateData[col];
            return `${col} = @up_${col}`;
        });
        const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT(${conflictColumn}) DO UPDATE SET ${updateClauses.join(', ')}`;
        return this.executeNonQuery(sql, params);
    }

    /**
     * Resolve user-specific table name.
     * SQLite/MySQL:  prefix_name
     * PgSQL:         account_prefix.name
     * Respects _prefixOverride (set by withPrefix) for cross-account queries.
     * @param {string} prefix
     * @param {string} name
     * @returns {string}
     */
    userTable(prefix, name) {
        const p = this._prefixOverride ?? prefix;
        return `${p}_${name}`;
    }

    /**
     * Create all user-specific tables for the given prefix.
     * 表结构定义的锅——50 张表拆成结构化数组就变成 400 行了，
     * integer primary key 又没有跨引擎的公共表达方式，
     * 所以直接堆 ddl 在这。换引擎时重写整个方法。
     * (我也不想写石山能怎么办呢总不能init的时候 if 引擎类型然后下面跟着一大坨方言吧））)
     * @param {string} prefix - user table prefix
     */
    async initUserSchema(prefix) {
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'feed_gps')} (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time INTEGER, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'feed_status')} (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, status TEXT, status_description TEXT, previous_status TEXT, previous_status_description TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'feed_bio')} (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'feed_avatar')} (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, owner_id TEXT, avatar_name TEXT, current_avatar_image_url TEXT, current_avatar_thumbnail_image_url TEXT, previous_current_avatar_image_url TEXT, previous_current_avatar_thumbnail_image_url TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'feed_online_offline')} (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time INTEGER, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS ${this.userTable(prefix, 'feed_online_offline')}_user_created_idx ON ${this.userTable(prefix, 'feed_online_offline')} (user_id, created_at)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'activity_sync_state_v2')} (user_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL DEFAULT '', is_self INTEGER NOT NULL DEFAULT 0, source_last_created_at TEXT NOT NULL DEFAULT '', pending_session_start_at INTEGER, cached_range_days INTEGER NOT NULL DEFAULT 0)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'activity_sessions_v2')} (session_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, is_open_tail INTEGER NOT NULL DEFAULT 0, source_revision TEXT NOT NULL DEFAULT '')`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS ${this.userTable(prefix, 'activity_sessions_v2')}_user_start_idx ON ${this.userTable(prefix, 'activity_sessions_v2')} (user_id, start_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS ${this.userTable(prefix, 'activity_sessions_v2')}_user_end_idx ON ${this.userTable(prefix, 'activity_sessions_v2')} (user_id, end_at)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'activity_bucket_cache_v2')} (user_id TEXT NOT NULL, target_user_id TEXT NOT NULL DEFAULT '', range_days INTEGER NOT NULL, view_kind TEXT NOT NULL, exclude_key TEXT NOT NULL DEFAULT '', bucket_version INTEGER NOT NULL DEFAULT 1, raw_buckets_json TEXT NOT NULL DEFAULT '[]', normalized_buckets_json TEXT NOT NULL DEFAULT '[]', built_from_cursor TEXT NOT NULL DEFAULT '', summary_json TEXT NOT NULL DEFAULT '{}', built_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, target_user_id, range_days, view_kind, exclude_key))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'friend_log_current')} (user_id TEXT PRIMARY KEY, display_name TEXT, trust_level TEXT, friend_number INTEGER)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'friend_log_history')} (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS ${this.userTable(prefix, 'friend_log_history')}_user_id_idx ON ${this.userTable(prefix, 'friend_log_history')} (user_id)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'notifications')} (id TEXT PRIMARY KEY, created_at TEXT, type TEXT, sender_user_id TEXT, sender_username TEXT, receiver_user_id TEXT, message TEXT, world_id TEXT, world_name TEXT, image_url TEXT, invite_message TEXT, request_message TEXT, response_message TEXT, expired INTEGER)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'notifications_v2')} (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, expires_at TEXT, type TEXT, link TEXT, link_text TEXT, message TEXT, title TEXT, image_url TEXT, seen INTEGER, sender_user_id TEXT, sender_username TEXT, data TEXT, responses TEXT, details TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'moderation')} (user_id TEXT PRIMARY KEY, updated_at TEXT, display_name TEXT, block INTEGER, mute INTEGER)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'avatar_history')} (avatar_id TEXT PRIMARY KEY, created_at TEXT, time INTEGER)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'notes')} (user_id TEXT PRIMARY KEY, display_name TEXT, note TEXT, created_at TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'mutual_graph_friends')} (friend_id TEXT PRIMARY KEY)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'mutual_graph_links')} (friend_id TEXT NOT NULL, mutual_id TEXT NOT NULL, PRIMARY KEY(friend_id, mutual_id))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'mutual_graph_links_old')} (friend_id TEXT NOT NULL, mutual_id TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY(friend_id, mutual_id))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'mutual_graph_friends_old')} (friend_id TEXT PRIMARY KEY, last_updated TEXT NOT NULL)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'mutual_graph_meta')} (friend_id TEXT PRIMARY KEY, last_fetched_at TEXT, opted_out INTEGER DEFAULT 0)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'tracked_nonfriends')} (user_id TEXT PRIMARY KEY, display_name TEXT, added_at TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${this.userTable(prefix, 'manual_relations_MANUEL')} (user_id_a TEXT NOT NULL, user_id_b TEXT NOT NULL, relation_type TEXT NOT NULL DEFAULT 'friend', added_at TEXT, PRIMARY KEY(user_id_a, user_id_b))`
        );
    }

    /**
     * Create all global shared tables.
     * Called once during app startup (initTables).
     */
    async initGlobalSchema() {
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time INTEGER, group_name TEXT, UNIQUE(created_at, location))`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS gamelog_location_created_at_idx ON gamelog_location (created_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_location_world_created ON gamelog_location (world_id, created_at)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time INTEGER, UNIQUE(created_at, type, display_name))`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON gamelog_join_leave (location)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_created ON gamelog_join_leave (user_id, created_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_display_created ON gamelog_join_leave (display_name, created_at)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (id INTEGER PRIMARY KEY, created_at TEXT, display_name TEXT, location TEXT, user_id TEXT, instance_id TEXT, world_name TEXT, UNIQUE(created_at, display_name))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS gamelog_video_play (id INTEGER PRIMARY KEY, created_at TEXT, video_url TEXT, video_name TEXT, video_id TEXT, location TEXT, display_name TEXT, user_id TEXT, UNIQUE(created_at, video_url))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS gamelog_resource_load (id INTEGER PRIMARY KEY, created_at TEXT, resource_url TEXT, resource_type TEXT, location TEXT, UNIQUE(created_at, resource_url))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS gamelog_event (id INTEGER PRIMARY KEY, created_at TEXT, data TEXT, UNIQUE(created_at, data))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS gamelog_external (id INTEGER PRIMARY KEY, created_at TEXT, message TEXT, display_name TEXT, user_id TEXT, location TEXT, UNIQUE(created_at, message))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS cache_avatar (id TEXT PRIMARY KEY, added_at TEXT, author_id TEXT, author_name TEXT, created_at TEXT, description TEXT, image_url TEXT, name TEXT, release_status TEXT, thumbnail_image_url TEXT, updated_at TEXT, version INTEGER)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS cache_world (id TEXT PRIMARY KEY, added_at TEXT, author_id TEXT, author_name TEXT, created_at TEXT, description TEXT, image_url TEXT, name TEXT, release_status TEXT, thumbnail_image_url TEXT, updated_at TEXT, version INTEGER)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS favorite_world (id INTEGER PRIMARY KEY, created_at TEXT, world_id TEXT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS favorite_avatar (id INTEGER PRIMARY KEY, created_at TEXT, avatar_id TEXT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS favorite_friend (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS memos (user_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS world_memos (world_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS avatar_memos (avatar_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS avatar_tags (avatar_id TEXT NOT NULL, tag TEXT NOT NULL, color TEXT, PRIMARY KEY (avatar_id, tag))`
        );
        // cookies 表纳入 GLOBAL_TABLES 走 global 主动迁移路径(与 IAuthStore
        // C# 侧 EnsureCookiesTable 同步),让切引擎 push/pull 时 VRChat auth
        // token 不丢失、用户无需重新登录。SQLite 无 LONGTEXT 类型,但接受
        // 任意列类型名,按 TEXT 亲和处理,value 列无界定大,语义与 MySQL
        // LONGTEXT / PG TEXT 等价(三方 DDL 在适配器层语义统一为 LONGTEXT)。
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS cookies (\`key\` TEXT PRIMARY KEY, \`value\` LONGTEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value LONGTEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS node_registry (node_id TEXT PRIMARY KEY, mode TEXT NOT NULL, prefixes TEXT NOT NULL, heartbeat_at TEXT NOT NULL)`
        );
    }

    // ── Transaction ──────────────────────────────────────────────────
    // SQLite 单连接模式:BEGIN/COMMIT/ROLLBACK 通过 C# 的
    // BeginTransaction/CommitTransaction/RollbackTransaction 管理,
    // C# 侧 _pinnedConnId 单槽 + sliding Timer 防泄漏。
    // execute/executeNonQuery 读栈顶 connId 传给 C# 重置 Timer
    // (单连接无需路由,但保持三引擎 JS 层统一)。

    /**
     * @override
     * @returns {Promise<number>} C# 返回的真实 connId
     * @protected
     */
    async _doBegin() {
        // connectionString 模式(pullEngine dstAdapter):在目标文件上开 pinned 事务,
        // 使 withTransaction 体内的写操作走 pinned 连接,保证原子性。
        if (this.connectionString) {
            return SQLite.BeginTransactionOnConnection(this.connectionString);
        }
        return SQLite.BeginTransaction();
    }

    /**
     * @override
     * @param {number} connId
     * @protected
     */
    async _doCommit(connId) {
        SQLite.CommitTransaction(connId);
    }

    /**
     * @override
     * @param {number} connId
     * @protected
     */
    async _doRollback(connId) {
        SQLite.RollbackTransaction(connId);
    }

    /**
     * @override
     * @param {number} connId
     * @returns {Promise<boolean>} C# KeepAliveTransaction 返回值
     * @protected
     */
    async _doKeepAlive(connId) {
        return SQLite.KeepAliveTransaction(connId);
    }

    /** VACUUM — reclaim storage. */
    vacuum() {
        return this.executeNonQuery('VACUUM');
    }

    /** PRAGMA optimize — maintenance hint. SQLite-specific; replace with ANALYZE on other engines. */
    optimize() {
        return this.executeNonQuery('PRAGMA optimize');
    }

    // C# 侧用 peak-borrowed 近似(并发借出峰值)返回 totalOpen/idleInPool,
    // 非估算也非真值——池无统计 API 且空闲连接弱引用(GC 回收不可见),
    // 详见 Dotnet/SQLite.cs GetPoolStats。
    async getPoolStats() {
        const json = await SQLite.GetPoolStats();
        return json
            ? JSON.parse(json)
            : {
                  active: 0,
                  pinnedIdle: 0,
                  availableCapacity: 0,
                  max: 0,
                  totalOpen: 0,
                  idleInPool: 0
              };
    }

    async clearIdleConnections() {
        await SQLite.ClearIdleConnections();
    }

    /**
     * Async liveness probe backed by C# `SQLite.Ping()`.
     *
     * @returns {Promise<boolean>}
     */
    async isConnected() {
        if (typeof SQLite === 'undefined' || !SQLite?.Ping) return false;
        return Boolean(await SQLite.Ping());
    }

    /**
     * Health probe backed by C# `SQLite.GetHealth()`.
     *
     * @returns {Promise<{ connected: boolean, latencyMs?: number, lastHealthCheck?: string|null }>}
     */
    async getHealth() {
        const json = await SQLite.GetHealth();
        return json ? JSON.parse(json) : { connected: false };
    }

    /**
     * 完备层计数器:`PRAGMA data_version`(DB 级,提交级,无假阳性)。
     * 任何写者(含外部进程)提交后递增;按文件计数,VRCX 运行时数据
     * 单文件,计数范围即业务范围。
     *
     * data_version 是"他写者视角"计数器——本连接读不到自己提交的
     * 递增(单连接下恒为初始值),但能可靠追踪其他连接/外部进程的
     * 提交。漏斗事件的 dv 快照须读自非写者连接(专用观察连接),
     * 否则基线去重会滞后一版失效。详见 docs/architecture/ADAPTER_API.md §9。
     *
     * @override @protected
     * @returns {Promise<number | null>}
     */
    async _readChangeCounter() {
        if (!this.connectionString) {
            // F7:默认单例经桥读 C# 专用观察连接(与漏斗事件 dv 同源)——池连接是
            // "写者视角",读不到自己提交的递增,会造成基线滞后与假触发。
            // CefSharp 同步返回 number|null,Electron 经 IPC 异步——await 统一。
            // 旧桥无 GetDataVersion 或调用失败 → 回退 execute 池路径(行为同现状)。
            if (typeof SQLite?.GetDataVersion === 'function') {
                try {
                    const v = await SQLite.GetDataVersion();
                    if (v === null || v === undefined) return null;
                    const n = Number(v);
                    return Number.isInteger(n) ? n : null;
                } catch {
                    /* 回退下方 execute 路径 */
                }
            }
        }
        let version = null;
        await this.execute((row) => {
            version = Number(row[0]);
        }, 'PRAGMA data_version');
        return version;
    }
}

export { SQLiteAdapter };
