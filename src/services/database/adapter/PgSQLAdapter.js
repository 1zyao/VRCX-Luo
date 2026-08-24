import { EngineAdapter } from './EngineAdapter.js';

/**
 * PostgreSQL dialect adapter.
 *
 * Mirrors `SQLiteAdapter` SQL-builder logic but emits PostgreSQL syntax:
 *   - `@key` named params are translated to positional `$N` by `_bind` before
 *     being handed to the C# `PostgreSQL` bridge (which accepts `object[]`).
 *   - `INSERT OR IGNORE/REPLACE` → `ON CONFLICT DO NOTHING` / layered
 *     `ON CONFLICT (pk) DO UPDATE SET ...` (see `_buildOnConflictReplace`).
 *   - DDL column types are mapped from SQLite-style declarations to PG via
 *     `_mapColumnType` so callers can keep passing SQLite-style definitions.
 *   - SQL fragments (`sqlToUnixMs`/`sqlExtractWorldId`/`sqlDate`/...)
 *     emit PG-native expressions.
 *
 * Phase 9 slice S2 scope (this file):
 *   - All 42 abstract methods either implemented or inherited from the base
 *     (the 5 schema/metadata methods — `initUserSchema`, `initGlobalSchema`,
 *     `listTables`, `getTableColumns`, `listTablesTypes` — remain abstract
 *     and are implemented in slices S4/S5).
 *   - 3 optional methods (`_normalizeArgs`, `withPrefix`, `daysAgoISO`)
 *     are inherited unchanged.
 *   - 3 PgSQL-specific extensions (`dropUserSchema`, `isConnected`,
 *     `getHealth`) per §4.1.15; `dropUserSchema` is implemented in slice
 *     S3 alongside `userTable` schema isolation (§4.1.6 + §10.2).
 *
 * `globalThis.PostgreSQL` is registered by the C# backend (CefSharp) or the
 * Electron main process; in vitest it is a `noopAsync` Proxy (see
 * `vitest.setup.js` L19) so importing this module has no side effects.
 */
class PgSQLAdapter extends EngineAdapter {
    /** @type {string|null} */
    connectionString = null;

    /**
     * PK metadata for the layered `insert(..., 'replace')` path.
     *
     * Maps `table → string[]` (PK column names). Populated by
     * `initUserSchema`/`initGlobalSchema` (slice S4) when tables are created.
     * Empty in slice S2 → every `'replace'` call degrades to
     * `ON CONFLICT DO NOTHING` + warn (see `_buildOnConflictReplace`).
     *
     * @type {Map<string, string[]>}
     * @protected
     */
    _tablePkMap = new Map();

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
        return 'postgresql';
    }

    /**
     * @param {object} [config]
     * @param {string} [config.connection] - postgresql:// URI (informational; the C# backend reads VRCXStorage itself)
     * @param {...object} [config.params] - 额外连接参数（保留兼容，PgSQLAdapter 构造无副作用）
     */
    constructor({ connection, ...params } = {}) {
        super();
        if (connection) {
            this.connectionString = connection;
        }
        // params reserved for future use; no Init is called here — the C#
        // PostgreSQL.Init() runs once at startup (src-electron/main.js /
        // Program.cs), not per adapter instance.
        void params;
    }

    // ── D1: @param → $N binding ───────────────────────────────────────

    /**
     * Translate `@key` named params in `sql` to PostgreSQL positional `$N`
     * and collect values into an array. C# `PostgreSQL.Execute*` accepts a
     * positional `object[]` bound by `$N`.
     *
     * Rules:
     *   - `args == null`           → `{ sql, args: null }` (no params)
     *   - `Array.isArray(args)`    → returned as-is; SQL is assumed to
     *                                already use `$N` (caller's responsibility)
     *   - `typeof args === 'object'` → each `@ident` in sql replaced by `$N`;
     *                                first occurrence assigns the index,
     *                                subsequent occurrences reuse it.
     *                                Unknown idents (not in args) are left
     *                                untouched (will surface as a PG error).
     *
     * @private
     * @param {string} sql - SQL statement with `@ident` placeholders
     * @param {object|Array|null|undefined} args - named params or positional array
     * @returns {{ sql: string, args: Array|null }}
     */
    _bind(sql, args) {
        if (args == null) return { sql, args: null };
        if (Array.isArray(args)) return { sql, args };
        if (typeof args === 'object') {
            /** @type {Record<string, *>} */
            const normArgs = {};
            for (const [k, v] of Object.entries(args)) {
                normArgs[k.replace(/^@/, '')] = v;
            }
            /** @type {Map<string, number>} */
            const keyToIndex = new Map();
            /** @type {Array} */
            const values = [];
            const newSql = sql.replace(
                /@([A-Za-z_][A-Za-z0-9_]*)/g,
                (match, ident) => {
                    if (
                        !Object.prototype.hasOwnProperty.call(normArgs, ident)
                    ) {
                        return match;
                    }
                    if (!keyToIndex.has(ident)) {
                        keyToIndex.set(ident, keyToIndex.size + 1);
                        values.push(normArgs[ident]);
                    }
                    return `$${keyToIndex.get(ident)}`;
                }
            );
            return { sql: newSql, args: values };
        }
        return { sql, args: null };
    }

    // ── Raw execution ─────────────────────────────────────────────────

    /**
     * Execute raw SQL with a per-row callback.
     *
     * PgSQLAdapter does NOT call `_normalizeArgs` — `_bind` handles the
     * `@key` → `$N` translation in one step. Errors are allowed to propagate
     * (Phase 9 minimal error handling; no `handleSQLiteError` equivalent).
     *
     * Row shape: the C# `PostgreSQL.ExecuteJson` bridge serialises
     * `object[][]` (positional arrays) — each row arrives here as
     * `[col1, col2, ...]` in SELECT-column order, NOT as a keyed object.
     * This mirrors `SQLiteAdapter.execute` (which also receives positional
     * arrays from `SQLite.ExecuteJson`). Callers MUST access columns by
     * position (`row[0]`, `row[1]`, ...) — named access (`row.colname`)
     * yields `undefined` (QA H1/H2 root cause).
     *
     * @param {(row: any[]) => void} callback - called once per result row
     *   (positional array in SELECT-column order)
     * @param {string} sql - SQL statement (SELECT)
     * @param {object|Array|null} [args] - named `@key` params or positional `$N` array
     * @returns {Promise<void>}
     * @override
     */
    async execute(callback, sql, args) {
        const { sql: pgSql, args: pgArgs } = this._bind(sql, args);
        const connId = this._txStack.at(-1);
        if (this.connectionString) {
            const json = await PostgreSQL.ExecuteJsonOnConnection(this.connectionString, pgSql, pgArgs, connId);
            if (!json) return;
            const items = JSON.parse(json);
            if (Array.isArray(items)) {
                items.forEach((item) => callback(item));
            }
            return;
        }
        const json = await PostgreSQL.ExecuteJson(pgSql, pgArgs, connId);
        if (!json) return;
        const items = JSON.parse(json);
        if (Array.isArray(items)) {
            items.forEach((item) => callback(item));
        }
    }

    /**
     * Execute raw SQL without row callback (INSERT/UPDATE/DELETE/DDL).
     *
     * @param {string} sql - SQL statement
     * @param {object|Array|null} [args] - named `@key` params or positional `$N` array
     * @returns {Promise<number>} rows affected
     * @override
     */
    async executeNonQuery(sql, args) {
        const { sql: pgSql, args: pgArgs } = this._bind(sql, args);
        const connId = this._txStack.at(-1);
        if (this.connectionString) {
            return await PostgreSQL.ExecuteNonQueryOnConnection(this.connectionString, pgSql, pgArgs, connId);
        }
        return await PostgreSQL.ExecuteNonQuery(pgSql, pgArgs, connId);
    }

    // ── CRUD ──────────────────────────────────────────────────────────

    /**
     * Map 'ignore'/'replace' to a trailing `ON CONFLICT ...` clause.
     *
     * 'replace' is handled separately by `_buildOnConflictReplace` because it
     * needs the row's column list and the table's PK metadata; this helper
     * only covers 'ignore' and the no-conflict default.
     *
     * @private
     * @param {string} [conflict] - 'ignore' | 'replace' | undefined
     * @returns {string} ` ON CONFLICT DO NOTHING` for 'ignore', empty string otherwise
     */
    _insertClause(conflict) {
        if (conflict === 'ignore') return ' ON CONFLICT DO NOTHING';
        return '';
    }

    /**
     * Build the `ON CONFLICT (...) DO UPDATE SET ...` clause for
     * `insert(..., 'replace')` / `bulkInsert(..., 'replace')`.
     *
     * Layered scheme (§4.1.5):
     *   - Default path: PK cols are known (via `_tablePkMap`) AND every PK col
     *     is present in the row's data keys → emit
     *     `ON CONFLICT (pk_cols) DO UPDATE SET non_pk = EXCLUDED.non_pk, ...`.
     *   - Fallback path: PK unknown or PK cols not in data → degrade to
     *     `ON CONFLICT DO NOTHING` + `console.warn`. This matches SQLite
     *     semantics for the 4 auto-increment-PK call sites where the PK
     *     isn't in the row anyway (no conflict can fire).
     *
     * `_tablePkMap` is populated by `initUserSchema`/`initGlobalSchema`
     * (slice S4). In slice S2 the map is empty, so all `'replace'` calls
     * take the fallback path.
     *
     * @private
     * @param {string} table - target table name
     * @param {string[]} dataKeys - column names in the INSERT row
     * @returns {string} full ` ON CONFLICT ...` clause (leading space included)
     */
    _buildOnConflictReplace(table, dataKeys) {
        const pkCols = this._tablePkMap.get(table);
        if (!pkCols || pkCols.length === 0) {
            console.warn(
                `[PgSQLAdapter] insert replace degraded to DO NOTHING: table=${table}, no resolvable PK in metadata`
            );
            return ' ON CONFLICT DO NOTHING';
        }
        const allPkInData = pkCols.every((c) => dataKeys.includes(c));
        if (!allPkInData) {
            // 设计内降级:自增/生成主键(如 activity_sessions_v2.session_id)
            // 的 'replace' 调用,行数据不含 PK,冲突永远不会触发 ——
            // DO NOTHING 与 SQLite INSERT OR REPLACE 语义等价(同样插入新行)。
            // 属预期行为,不产生告警噪音。
            return ' ON CONFLICT DO NOTHING';
        }
        const nonPkCols = dataKeys.filter((c) => !pkCols.includes(c));
        if (nonPkCols.length === 0) {
            // All columns are PK members — nothing to update on conflict.
            return ' ON CONFLICT DO NOTHING';
        }
        const updateSet = nonPkCols
            .map((c) => `${c} = EXCLUDED.${c}`)
            .join(', ');
        return ` ON CONFLICT (${pkCols.join(', ')}) DO UPDATE SET ${updateSet}`;
    }

    /**
     * Single-row INSERT with optional conflict handling.
     *
     * @param {string} table - target table name (with prefix/schema if applicable)
     * @param {object} data - column:value mapping (snake_case keys)
     * @param {string} [conflict] - 'ignore' → ON CONFLICT DO NOTHING, 'replace' → layered ON CONFLICT DO UPDATE
     * @returns {Promise<number>} rows affected
     * @override
     */
    insert(table, data, conflict) {
        const columns = Object.keys(data);
        const params = {};
        const values = columns.map((col) => {
            params[col] = data[col];
            return `@${col}`;
        });
        let onConflict = this._insertClause(conflict);
        if (conflict === 'replace') {
            onConflict = this._buildOnConflictReplace(table, columns);
        }
        return this.executeNonQuery(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')})${onConflict}`,
            params
        );
    }

    /**
     * Bulk multi-row INSERT with optional conflict handling.
     *
     * @param {string} table - target table name
     * @param {object[]} rows - array of column:value objects (all must share the same keys)
     * @param {string} [conflict] - 'ignore' | 'replace'
     * @returns {Promise<number|undefined>} rows affected, or undefined if rows is empty
     * @override
     */
    async bulkInsert(table, rows, conflict) {
        if (rows.length === 0) return;
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
        let onConflict = this._insertClause(conflict);
        if (conflict === 'replace') {
            onConflict = this._buildOnConflictReplace(table, columns);
        }
        return this.executeNonQuery(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}${onConflict}`,
            params
        );
    }

    /**
     * UPDATE with equality conditions.
     *
     * @param {string} table - target table name
     * @param {object} data - columns to SET (key:value)
     * @param {object} where - equality conditions (AND-ed)
     * @returns {Promise<number>} rows affected
     * @override
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
     *
     * @param {string} table - target table name
     * @param {object} data - columns to SET (key:value)
     * @param {string} whereClause - raw WHERE content (without the WHERE keyword)
     * @param {object} [params] - named parameters for the WHERE clause
     * @returns {Promise<number>} rows affected
     * @override
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
     *
     * @param {string} table - target table name
     * @param {object} where - equality conditions (AND-ed)
     * @returns {Promise<number>} rows affected
     * @override
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
     *
     * @param {string} table - target table name
     * @returns {Promise<number>} rows affected
     * @override
     */
    deleteAll(table) {
        return this.executeNonQuery(`DELETE FROM ${table}`);
    }

    /**
     * DROP TABLE IF EXISTS.
     *
     * @param {string} table - table name to drop
     * @returns {Promise<number>} rows affected (0 for DDL)
     * @override
     */
    dropTable(table) {
        return this.executeNonQuery(`DROP TABLE IF EXISTS ${table}`);
    }

    /**
     * DELETE with raw WHERE clause (non-equality conditions).
     *
     * @param {string} table - target table name
     * @param {string} whereClause - raw WHERE content (without the WHERE keyword)
     * @param {object} [params] - named parameters for the WHERE clause
     * @returns {Promise<number>} rows affected
     * @override
     */
    deleteWhere(table, whereClause, params = {}) {
        return this.executeNonQuery(
            `DELETE FROM ${table} WHERE ${whereClause}`,
            params
        );
    }

    /**
     * UPDATE with arithmetic expression: SET col = col + @amount WHERE conditions.
     *
     * @param {string} table - target table name
     * @param {string} column - column to increment
     * @param {number} amount - value to add
     * @param {object} where - equality conditions (AND-ed)
     * @returns {Promise<number>} rows affected
     * @override
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
     * PostgreSQL native syntax; SQLite 3.24+ also supports it so the
     * generated SQL is identical to SQLiteAdapter's output. `@key` params
     * are translated to `$N` by `_bind`.
     *
     * @param {string} table          - target table name
     * @param {object} insertData     - all columns for INSERT
     * @param {object} updateData     - subset of columns for UPDATE on conflict
     * @param {string} conflictColumn - column to detect conflict on
     * @returns {Promise<number>} rows affected
     * @override
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

    // ── SELECT ────────────────────────────────────────────────────────

    /**
     * SELECT one row with equality WHERE and LIMIT 1.
     *
     * @param {string} table - source table name
     * @param {string[]|string} columns - column names to select
     * @param {object} where - equality conditions (key:value)
     * @returns {Promise<Array|null>} single row as positional array, or null
     * @override
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
     *
     * @param {string} table - source table name
     * @param {string[]|string} columns - column names to select
     * @param {object} [where] - equality conditions (AND-ed), omit for no WHERE clause
     * @param {object} [options] - { order, limit, distinct }
     * @returns {Promise<Array<Array>>} array of row arrays
     * @override
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
     *
     * @param {string} table - source table name
     * @param {string[]|string} columns - column names to select
     * @param {string} [whereClause] - raw WHERE content (without the WHERE keyword), null to skip
     * @param {object} [params] - named parameters for the WHERE clause
     * @param {object} [options] - { order, limit, distinct }
     * @returns {Promise<Array<Array>>} array of row arrays
     * @override
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
     * JOIN syntax is cross-engine uniform; only LIMIT/ORDER BY placement
     * differs (handled here via options).
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
     * @override
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
     *
     * @param {string} table - source table name
     * @param {string[]|string} columns - column names to select
     * @param {string} inColumn - column name for IN clause
     * @param {Array} inValues - values for IN list
     * @param {string} [extraWhere] - additional AND conditions (raw SQL fragment)
     * @param {object} [extraParams] - named params for extraWhere
     * @param {object} [options] - { order, limit }
     * @returns {Promise<Array<Array>>} array of row arrays
     * @override
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
     * Each branch is wrapped as `SELECT * FROM (branch)` derived table so
     * that per-branch ORDER BY/LIMIT stays legal inside. PostgreSQL natively
     * supports parenthesised branches + inner ORDER BY/LIMIT, but the
     * derived-table wrapping is retained here to keep the generated SQL
     * structurally identical to SQLiteAdapter (reduces cross-engine
     * divergence — one less thing for callers to reason about).
     *
     * @param {object[]} sources - Array of { table, columns?, nulls?, where?, params?, order?, limit? }
     * @param {object}   [options] - { schema?, order?, limit? }
     * @returns {Promise<Array<Array>>}
     * @override
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
            // Wrap each branch as a derived table — legal in both SQLite and
            // PgSQL. PgSQL could use bare parenthesised branches, but
            // keeping the same shape as SQLiteAdapter avoids divergence.
            return `SELECT * FROM (${sql}) AS _u`;
        });
        const outerSchema = schema
            ? Array.isArray(schema)
                ? schema.join(', ')
                : schema
            : '*';
        let finalSql = `SELECT ${outerSchema} FROM (${parts.join(' UNION ALL ')}) AS _outer`;
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
     * @override
     */
    async selectGroupBy(table, spec) {
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

    // ── COUNT ─────────────────────────────────────────────────────────

    /**
     * COUNT rows with equality conditions.
     *
     * @param {string} table - source table name
     * @param {object} where - equality conditions (key:value)
     * @returns {Promise<number>} row count
     * @override
     */
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

    /**
     * COUNT rows with raw WHERE clause. Omit whereClause to COUNT all rows.
     *
     * @param {string} table - source table name
     * @param {string} [whereClause] - raw WHERE content (without the WHERE keyword); omit/null to COUNT all rows
     * @param {object} [params] - named parameters for the WHERE clause
     * @returns {Promise<number>} row count
     * @override
     */
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

    // ── DDL ───────────────────────────────────────────────────────────

    /**
     * Map SQLite-style column type tokens to PostgreSQL equivalents.
     *
     * Longest-match-first to avoid `INTEGER PRIMARY KEY` shadowing
     * `INTEGER PRIMARY KEY AUTOINCREMENT` (the latter would otherwise leave
     * a dangling `AUTOINCREMENT` token in PG output).
     *
     * Other modifiers (NOT NULL / DEFAULT / UNIQUE / PRIMARY KEY(...) etc.)
     * are preserved verbatim — only the SQLite type tokens are rewritten.
     *
     * @private
     * @param {string} sqliteType - SQLite-style type fragment or full column def
     * @returns {string} PG-flavoured type fragment
     */
    _mapColumnType(sqliteType) {
        if (typeof sqliteType !== 'string' || sqliteType.length === 0) {
            return sqliteType;
        }
        let out = sqliteType;
        // Rule 1 — must precede rule 2 to consume AUTOINCREMENT.
        if (/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i.test(out)) {
            out = out.replace(
                /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i,
                'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
            );
            return out;
        }
        // Rule 2
        if (/INTEGER\s+PRIMARY\s+KEY/i.test(out)) {
            out = out.replace(
                /INTEGER\s+PRIMARY\s+KEY/i,
                'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
            );
            return out;
        }
        // Rule 3 — bare INTEGER (not part of PRIMARY KEY) → BIGINT
        out = out.replace(/\bINTEGER\b/g, 'BIGINT');
        // Rule 4 — TEXT stays TEXT; no substitution needed.
        return out;
    }

    /**
     * CREATE TABLE IF NOT EXISTS from structured column definitions.
     *
     * Column definitions may be raw strings or `{ name, type, constraints? }`
     * objects. SQLite-style type tokens in either form are mapped to PG via
     * `_mapColumnType`.
     *
     * @param {string} tableName - table name to create
     * @param {Array<object | string>} columns - [{ name, type, constraints? }] or raw string for simple defs
     * @returns {Promise<number>} rows affected (0 for DDL)
     * @override
     */
    createTable(tableName, columns) {
        const colDefs = columns.map((col) => {
            if (typeof col === 'string') {
                return this._mapColumnType(col);
            }
            const colDef = /** @type {{name: string, type?: string, constraints?: string}} */ (
                col
            );
            const constraints = colDef.constraints ? ` ${colDef.constraints}` : '';
            const raw = `${colDef.name} ${colDef.type}${constraints}`;
            return this._mapColumnType(raw);
        });
        // Register PRIMARY KEY metadata so `insert(..., 'replace')` can
        // build `ON CONFLICT (...) DO UPDATE` via `_buildOnConflictReplace`.
        // Structured column defs (e.g. configRepository's dynamic `configs`
        // table) and raw-string defs both carry the constraint; without this
        // registration the replace silently degrades to `ON CONFLICT DO
        // NOTHING` and existing rows never update.
        const pkCols = [];
        columns.forEach((col) => {
            if (typeof col === 'string') {
                if (/\bPRIMARY\s+KEY\b/i.test(col)) {
                    const rawName = col
                        .trim()
                        .split(/\s+/)[0]
                        .replace(/^"|"$/g, '');
                    if (rawName) pkCols.push(rawName);
                }
                return;
            }
            const colDef = /** @type {{name: string, type?: string, constraints?: string}} */ (
                col
            );
            const def = `${colDef.name} ${colDef.type || ''}${colDef.constraints ? ` ${colDef.constraints}` : ''}`;
            if (/\bPRIMARY\s+KEY\b/i.test(def)) {
                const name = colDef.name.replace(/^"|"$/g, '');
                if (name) pkCols.push(name);
            }
        });
        if (pkCols.length > 0) {
            this._tablePkMap.set(tableName, pkCols);
        }
        return this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(', ')})`
        );
    }

    /**
     * CREATE INDEX IF NOT EXISTS.
     *
     * @param {string} indexName - index name
     * @param {string} table - target table name
     * @param {string[]|string} columns - column(s) to index
     * @param {boolean} [unique] - create UNIQUE index
     * @returns {Promise<number>} rows affected (0 for DDL)
     * @override
     */
    createIndex(indexName, table, columns, unique = false) {
        const uniqueStr = unique ? 'UNIQUE ' : '';
        const colStr = Array.isArray(columns) ? columns.join(', ') : columns;
        return this.executeNonQuery(
            `CREATE ${uniqueStr}INDEX IF NOT EXISTS ${indexName} ON ${table} (${colStr})`
        );
    }

    /**
     * ALTER TABLE ADD COLUMN. SQLite-style type tokens in `columnDef` are
     * mapped to PG via `_mapColumnType`.
     *
     * @param {string} table - target table name
     * @param {string} columnDef - full column definition (e.g. 'name TEXT NOT NULL DEFAULT ""')
     * @returns {Promise<number>} rows affected (0 for DDL)
     * @override
     */
    alterTableAddColumn(table, columnDef) {
        return this.executeNonQuery(
            `ALTER TABLE ${table} ADD COLUMN ${this._mapColumnType(columnDef)}`
        );
    }

    /**
     * ALTER TABLE DROP COLUMN.
     *
     * @param {string} table - target table name
     * @param {string} column - column name to drop
     * @returns {Promise<number>} rows affected (0 for DDL)
     * @override
     */
    alterTableDropColumn(table, column) {
        return this.executeNonQuery(
            `ALTER TABLE ${table} DROP COLUMN ${column}`
        );
    }

    /**
     * ALTER TABLE RENAME TO.
     *
     * @param {string} table - current table name
     * @param {string} newName - new table name
     * @returns {Promise<number>} rows affected (0 for DDL)
     * @override
     */
    alterTableRename(table, newName) {
        return this.executeNonQuery(
            `ALTER TABLE ${table} RENAME TO ${newName}`
        );
    }

    // ── Transaction ───────────────────────────────────────────────────

    /**
     * 借一条 pooled 连接 + BEGIN 事务,返回 connId 供后续
     * execute/executeNonQuery 路由到同一连接。C# 侧 sliding 30s 超时
     * 防泄漏。详见 PostgreSQL.cs `_pinned` + `BeginTransaction`。
     *
     * @override
     * @returns {Promise<number>} connId
     * @protected
     */
    async _doBegin() {
        if (this.connectionString) return PostgreSQL.BeginTransactionOnConnection(this.connectionString);
        return PostgreSQL.BeginTransaction();
    }

    /**
     * COMMIT 事务 + 还池。connId 已超时回滚时抛错(调用方应重试)。
     *
     * @override
     * @param {number} connId
     * @protected
     */
    async _doCommit(connId) {
        PostgreSQL.CommitTransaction(connId);
    }

    /**
     * ROLLBACK 事务 + 还池。connId 已超时回滚时静默 no-op。
     *
     * @override
     * @param {number} connId
     * @protected
     */
    async _doRollback(connId) {
        PostgreSQL.RollbackTransaction(connId);
    }

    /**
     * @override
     * @param {number} connId
     * @returns {Promise<boolean>} C# KeepAliveTransaction 返回值
     * @protected
     */
    async _doKeepAlive(connId) {
        return PostgreSQL.KeepAliveTransaction(connId);
    }

    // ── Maintenance ───────────────────────────────────────────────────

    /** VACUUM ANALYZE — reclaim storage + refresh planner stats. */
    vacuum() {
        return this.executeNonQuery('VACUUM ANALYZE');
    }

    /** ANALYZE — refresh planner statistics (PgSQL equivalent of PRAGMA optimize). */
    optimize() {
        return this.executeNonQuery('ANALYZE');
    }

    // ── Naming ────────────────────────────────────────────────────────

    /**
     * Build PostgreSQL schema name for an account prefix.
     *
     * @param {string} prefix - Account prefix (already validated by database/index.js).
     * @returns {string} Schema name `account_{prefix}`.
     * @private
     */
    _schemaPrefix(prefix) {
        return `account_${prefix}`;
    }

    /**
     * Resolve a user table name as a PostgreSQL schema-qualified identifier.
     *
     * Phase 9 slice S3 (per §4.1.6 + §10.2): returns the two-segment
     * `account_{prefix}.{name}` identifier instead of the flat
     * `${prefix}_${name}` form used in S2. Each account lives in its own
     * PG schema (`account_{prefix}`), giving strict table-name isolation
     * across accounts without prefix-collision risk in shared catalogs.
     *
     * Respects `_prefixOverride` (set by `withPrefix`) for cross-account
     * queries — same semantics as SQLiteAdapter.
     *
     * INV-01: Returns a legal PG `schema.table` two-segment identifier.
     * The schema name `account_{prefix}` complies with PG unquoted
     * identifier rules (starts with letter/underscore, only
     * `[A-Za-z0-9_]`) because the prefix generation rule in
     * `database/index.js` L56-58 strips `-` and `_` from the userId and
     * prepends `_` when the result starts with a digit, so the resulting
     * `account_{prefix}` always starts with `account_` (letter-led).
     *
     * @param {string} prefix - user table prefix (account hash)
     * @param {string} name - base table name
     * @returns {string} `account_{prefix}.{name}` two-segment qualified identifier
     * @override
     */
    userTable(prefix, name) {
        const p = this._prefixOverride ?? prefix;
        return `${this._schemaPrefix(p)}.${name}`;
    }

    // ── SQL fragments (PG-specific syntax) ────────────────────────────

    /**
     * SQL expression: convert ISO datetime column to Unix milliseconds.
     * PostgreSQL: `(EXTRACT(EPOCH FROM ${column}::timestamptz) * 1000)`
     *
     * @param {string} column - column name containing ISO datetime
     * @returns {string} SQL expression
     * @override
     */
    sqlToUnixMs(column) {
        return `(EXTRACT(EPOCH FROM ${column}::timestamptz) * 1000)`;
    }

    /**
     * SQL expression: extract world ID from a location string (e.g. "wrld_xxx:12345" → "wrld_xxx").
     * PostgreSQL: `SUBSTRING(${column} FROM 1 FOR POSITION(':' IN ${column}) - 1)`
     *
     * @param {string} column - column name containing full location string
     * @returns {string} SQL expression
     * @override
     */
    sqlExtractWorldId(column) {
        return `SUBSTRING(${column} FROM 1 FOR POSITION(':' IN ${column}) - 1)`;
    }

    /**
     * SQL expression: check if a location string has an instance ID (contains ':').
     * PostgreSQL: `POSITION(':' IN ${column}) > 0`
     *
     * @param {string} column - column name containing location
     * @returns {string} SQL expression (boolean)
     * @override
     */
    sqlHasInstanceId(column) {
        return `POSITION(':' IN ${column}) > 0`;
    }

    /**
     * SQL expression: extract date part from an ISO datetime column.
     * PostgreSQL: `${column}::date`
     *
     * @param {string} column - column name containing ISO datetime
     * @returns {string} SQL expression
     * @override
     */
    sqlDate(column) {
        return `${column}::date`;
    }

    /**
     * SQL expression: compute the "enter time" from a leave event record.
     *
     * gamelog_join_leave records only leave events (created_at = leave time,
     * time = duration in ms). Enter time = leave time − duration.
     *
     * Uses `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` to produce a strict
     * ISO-8601 string (`T` separator, `Z` suffix) that matches SQLite's
     * `strftime('%Y-%m-%dT%H:%M:%SZ', ...)` output byte-for-byte. The
     * naive `${ts}::text` cast would emit `YYYY-MM-DD HH:MM:SS+00` (space
     * separator, numeric TZ) and break the BETWEEN lexicographic comparison
     * in gameLog.js (R5).
     *
     * @param {string} tsColumn  - column name of the ISO leave timestamp
     * @param {string} msColumn  - column name of the duration in milliseconds
     * @returns {string} SQL expression that evaluates to the enter timestamp
     * @override
     */
    sqlEnterTime(tsColumn, msColumn) {
        return `to_char(${tsColumn}::timestamptz - (${msColumn} / 1000.0) * INTERVAL '1 second', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
    }

    // ── PgSQL-specific extensions (§4.1.15; not part of the 42+3 interface) ──

    /**
     * Drop a user-prefixed schema and all its tables (PgSQL-only extension,
     * §4.1.15). Implemented in slice S3 (alongside `userTable` schema
     * isolation) per §10.2 to remove the slice-S6 placeholder friction.
     *
     * Uses PG-specific `DROP SCHEMA ... CASCADE` to drop every table within
     * the schema in one statement. SQLite has no equivalent — this method
     * is intentionally NOT added to the base `EngineAdapter` class.
     *
     * @param {string} prefix - user table prefix (account hash)
     * @returns {Promise<number>} rows affected (0 for DDL)
     */
    async dropUserSchema(prefix) {
        return await this.executeNonQuery(
            `DROP SCHEMA IF EXISTS ${this._schemaPrefix(prefix)} CASCADE`
        );
    }

    /**
     * Async liveness probe backed by C# `PostgreSQL.Ping()`.
     *
     * `Ping` executes `SELECT 1` against the pooled data source, so it
     * confirms the backend is actually reachable — unlike `IsConnected`,
     * which only reports initialisation state. Worst-case latency when the
     * server is unreachable is bounded by the connection string `Timeout`
     * (default 15s); in the common connected case it is sub-millisecond.
     *
     * Used by `pullEngine`/`pushEngine` as a fail-fast guard before
     * attempting a long copy operation, so a disconnected backend produces
     * a clear "backend is not connected" error rather than a delayed,
     * mid-copy SQL failure.
     *
     * Declared `async` and `await`s the C# bridge so the result is
     * correct on both runtimes: on CefSharp `Ping()` returns a plain
     * `boolean` (awaiting it is a no-op); on Electron `Ping()` returns
     * a `Promise<boolean>` via the InteropApi Proxy, and `Boolean(Promise)`
     * would otherwise always be `true`. The `typeof` guard short-circuits
     * both the undeclared-binding case and the `undefined` value case,
     * returning `false` without touching the bridge.
     *
     * @returns {Promise<boolean>}
     */
    async isConnected() {
        if (typeof PostgreSQL === 'undefined' || !PostgreSQL?.Ping)
            return false;
        return Boolean(await PostgreSQL.Ping());
    }

    /**
     * Health probe backed by C# `PostgreSQL.GetHealth()`.
     *
     * Returns the parsed JSON payload from the C# bridge. The actual C#
     * payload (verified against `Dotnet/PostgreSQL.cs` GetHealth) is
     * `{ connected: boolean, latencyMs: number, lastHealthCheck: string|null }`
     * — there is NO `poolSize` field (F-13.1: the previous JSDoc claimed
     * `poolSize` which never existed; the design §4.1.15/§11.1 internal
     * inconsistency between `poolSize` and `poolStats` is a doc bug, not
     * a code bug — no C# change required since no production caller
     * reads `poolSize`).
     *
     * Returns `{ connected: false }` when the bridge returns an empty
     * payload (vitest stub / not connected).
     *
     * @returns {Promise<{ connected: boolean, latencyMs?: number, lastHealthCheck?: string|null }>}
     */
    async getHealth() {
        const json = await PostgreSQL.GetHealth();
        return json ? JSON.parse(json) : { connected: false };
    }

    async getPoolStats() {
        const json = await PostgreSQL.GetPoolStats();
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
        await PostgreSQL.ClearIdleConnections();
    }

    // ── Schema (initUserSchema / initGlobalSchema) ────────────────────
    // Slice S4 (§4.1.7 + §4.1.8 + §5.2/§5.3 + §10.2). The 5 metadata
    // methods (`listTables` / `getTableColumns` / `listTablesTypes`)
    // remain abstract — slice S5 implements them against pg_catalog /
    // information_schema.

    /**
     * Create the account schema and all user tables (PgSQL DDL).
     *
     * Phase 9 slice S4 (§4.1.7 + §5.2 + §10.2). Mirrors
     * `SQLiteAdapter.initUserSchema` (L900-979) table-for-table, with
     * SQLite type tokens mapped to PG per §5.1:
     *   - `INTEGER PRIMARY KEY` / `... AUTOINCREMENT` →
     *     `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` (R6: BY
     *     DEFAULT lets the migration pipeline copy explicit session_id /
     *     id values from SQLite; always-identity would reject those).
     *   - bare `INTEGER` → `BIGINT` (PG int4 would overflow for ms
     *     timestamps / counts).
     *   - `TEXT` → `TEXT`; PK / NOT NULL / DEFAULT / UNIQUE modifiers
     *     preserved verbatim.
     *
     * Each account lives in its own PG schema `account_{prefix}`; the
     * schema is created first with `CREATE SCHEMA IF NOT EXISTS`. Index
     * names drop the SQLite flat `${prefix}_` prefix and use the
     * `tbl_col_idx` form — they are unique within the schema (§5.4),
     * which is sufficient because PG indexes are namespaced per-schema.
     *
     * PK metadata is recorded in `_tablePkMap` right after each table is
     * created, keyed by the same `userTable(prefix, name)` identifier
     * that `insert(..., 'replace')` will later pass to
     * `_buildOnConflictReplace` — this activates the default layered
     * `ON CONFLICT (pk) DO UPDATE SET ...` path (§4.1.5). Tables whose
     * PK is a `GENERATED BY DEFAULT AS IDENTITY` column and whose INSERT
     * rows never include the PK still degrade to `ON CONFLICT DO
     * NOTHING` at runtime (PK col not in data), matching the SQLite
     * `INSERT OR REPLACE` semantics for auto-increment call sites.
     *
     * INV-09: per-account schema isolation guarantees zero cross-account
     * table-name collision in the shared PG catalog.
     * INV-10: PK metadata is filled atomically per-table, so subsequent
     * `insert(..., 'replace')` calls always hit the default path instead
     * of the fallback warn+DO NOTHING.
     *
     * Table count: 22 user tables + 4 indexes (verified against
     * SQLiteAdapter L900-979; design §5.2 brief said "~25 / 50 incl.
     * indexes" — actual count reported, treated as authoritative).
     *
     * @override
     * @param {string} prefix - Account prefix (already validated).
     * @returns {Promise<void>}
     */
    async initUserSchema(prefix) {
        const tbl = (name) => this.userTable(prefix, name);
        // Step 1 — create the per-account schema (INV-01: account_{prefix}
        // is a legal PG unquoted identifier).
        await this.executeNonQuery(
            `CREATE SCHEMA IF NOT EXISTS ${this._schemaPrefix(prefix)}`
        );
        // Step 2 — create the 22 user tables (§5.1 type mapping inlined).
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('feed_gps')} (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time BIGINT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('feed_status')} (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, status TEXT, status_description TEXT, previous_status TEXT, previous_status_description TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('feed_bio')} (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('feed_avatar')} (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, owner_id TEXT, avatar_name TEXT, current_avatar_image_url TEXT, current_avatar_thumbnail_image_url TEXT, previous_current_avatar_image_url TEXT, previous_current_avatar_thumbnail_image_url TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('feed_online_offline')} (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time BIGINT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('activity_sync_state_v2')} (user_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL DEFAULT '', is_self BIGINT NOT NULL DEFAULT 0, source_last_created_at TEXT NOT NULL DEFAULT '', pending_session_start_at BIGINT, cached_range_days BIGINT NOT NULL DEFAULT 0)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('activity_sessions_v2')} (session_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id TEXT NOT NULL, start_at BIGINT NOT NULL, end_at BIGINT NOT NULL, is_open_tail BIGINT NOT NULL DEFAULT 0, source_revision TEXT NOT NULL DEFAULT '')`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('activity_bucket_cache_v2')} (user_id TEXT NOT NULL, target_user_id TEXT NOT NULL DEFAULT '', range_days BIGINT NOT NULL, view_kind TEXT NOT NULL, exclude_key TEXT NOT NULL DEFAULT '', bucket_version BIGINT NOT NULL DEFAULT 1, raw_buckets_json TEXT NOT NULL DEFAULT '[]', normalized_buckets_json TEXT NOT NULL DEFAULT '[]', built_from_cursor TEXT NOT NULL DEFAULT '', summary_json TEXT NOT NULL DEFAULT '{}', built_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, target_user_id, range_days, view_kind, exclude_key))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('friend_log_current')} (user_id TEXT PRIMARY KEY, display_name TEXT, trust_level TEXT, friend_number BIGINT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('friend_log_history')} (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number BIGINT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('notifications')} (id TEXT PRIMARY KEY, created_at TEXT, type TEXT, sender_user_id TEXT, sender_username TEXT, receiver_user_id TEXT, message TEXT, world_id TEXT, world_name TEXT, image_url TEXT, invite_message TEXT, request_message TEXT, response_message TEXT, expired BIGINT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('notifications_v2')} (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, expires_at TEXT, type TEXT, link TEXT, link_text TEXT, message TEXT, title TEXT, image_url TEXT, seen BIGINT, sender_user_id TEXT, sender_username TEXT, data TEXT, responses TEXT, details TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('moderation')} (user_id TEXT PRIMARY KEY, updated_at TEXT, display_name TEXT, block BIGINT, mute BIGINT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('avatar_history')} (avatar_id TEXT PRIMARY KEY, created_at TEXT, time BIGINT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('notes')} (user_id TEXT PRIMARY KEY, display_name TEXT, note TEXT, created_at TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('mutual_graph_friends')} (friend_id TEXT PRIMARY KEY)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('mutual_graph_links')} (friend_id TEXT NOT NULL, mutual_id TEXT NOT NULL, PRIMARY KEY(friend_id, mutual_id))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('mutual_graph_links_old')} (friend_id TEXT NOT NULL, mutual_id TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY(friend_id, mutual_id))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('mutual_graph_friends_old')} (friend_id TEXT PRIMARY KEY, last_updated TEXT NOT NULL)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('mutual_graph_meta')} (friend_id TEXT PRIMARY KEY, last_fetched_at TEXT, opted_out BIGINT DEFAULT 0)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('tracked_nonfriends')} (user_id TEXT PRIMARY KEY, display_name TEXT, added_at TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS ${tbl('manual_relations_MANUEL')} (user_id_a TEXT NOT NULL, user_id_b TEXT NOT NULL, relation_type TEXT NOT NULL DEFAULT 'friend', added_at TEXT, PRIMARY KEY(user_id_a, user_id_b))`
        );
        // Step 3 — create the 4 user indexes (schema-unique names, §5.4).
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS feed_online_offline_user_created_idx ON ${tbl('feed_online_offline')} (user_id, created_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS activity_sessions_v2_user_start_idx ON ${tbl('activity_sessions_v2')} (user_id, start_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS activity_sessions_v2_user_end_idx ON ${tbl('activity_sessions_v2')} (user_id, end_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS friend_log_history_user_id_idx ON ${tbl('friend_log_history')} (user_id)`
        );
        // Step 4 — record PK metadata so `insert(..., 'replace')` hits the
        // layered `ON CONFLICT (pk) DO UPDATE` default path (INV-10).
        this._tablePkMap.set(tbl('feed_gps'), ['id']);
        this._tablePkMap.set(tbl('feed_status'), ['id']);
        this._tablePkMap.set(tbl('feed_bio'), ['id']);
        this._tablePkMap.set(tbl('feed_avatar'), ['id']);
        this._tablePkMap.set(tbl('feed_online_offline'), ['id']);
        this._tablePkMap.set(tbl('activity_sync_state_v2'), ['user_id']);
        this._tablePkMap.set(tbl('activity_sessions_v2'), ['session_id']);
        this._tablePkMap.set(tbl('activity_bucket_cache_v2'), [
            'user_id',
            'target_user_id',
            'range_days',
            'view_kind',
            'exclude_key'
        ]);
        this._tablePkMap.set(tbl('friend_log_current'), ['user_id']);
        this._tablePkMap.set(tbl('friend_log_history'), ['id']);
        this._tablePkMap.set(tbl('notifications'), ['id']);
        this._tablePkMap.set(tbl('notifications_v2'), ['id']);
        this._tablePkMap.set(tbl('moderation'), ['user_id']);
        this._tablePkMap.set(tbl('avatar_history'), ['avatar_id']);
        this._tablePkMap.set(tbl('notes'), ['user_id']);
        this._tablePkMap.set(tbl('mutual_graph_friends'), ['friend_id']);
        this._tablePkMap.set(tbl('mutual_graph_links'), [
            'friend_id',
            'mutual_id'
        ]);
        this._tablePkMap.set(tbl('mutual_graph_links_old'), [
            'friend_id',
            'mutual_id'
        ]);
        this._tablePkMap.set(tbl('mutual_graph_friends_old'), ['friend_id']);
        this._tablePkMap.set(tbl('mutual_graph_meta'), ['friend_id']);
        this._tablePkMap.set(tbl('tracked_nonfriends'), ['user_id']);
        this._tablePkMap.set(tbl('manual_relations_MANUEL'), [
            'user_id_a',
            'user_id_b'
        ]);
    }

    /**
     * Create global shared tables in the `public` schema (PgSQL DDL).
     *
     * Phase 9 slice S4 (§4.1.8 + §5.3 + §10.2). Mirrors
     * `SQLiteAdapter.initGlobalSchema` (L985-1049) table-for-table.
     * Tables are created with the explicit `public.` schema qualifier so
     * the names resolve correctly regardless of the active search_path
     * (a per-account `account_{prefix}` search_path would otherwise
     * shadow unqualified global names).
     *
     * Index names keep their original SQLite form (e.g.
     * `idx_gamelog_location_world_created`) — they live in the `public`
     * schema and remain unique there. PK metadata is recorded in
     * `_tablePkMap` keyed by the **bare** table name (e.g.
     * `'gamelog_location'`, NOT `'public.gamelog_location'`) because
     * business modules pass bare global names to `insert()` /
     * `bulkInsert()` (verified against `gameLog.js` etc.) — PG resolves
     * them via the default `search_path` which includes `public`. The
     * layered `_buildOnConflictReplace` lookup uses the same bare name,
     * so global `insert(..., 'replace')` calls also activate the default
     * `ON CONFLICT (pk) DO UPDATE` path.
     *
     * `gamelog_*` tables carry `UNIQUE(created_at, ...)` constraints that
     * are NOT primary keys — their PK remains the `id` identity column.
     *
     * Table count: 16 global tables + 5 indexes (verified against
     * SQLiteAdapter L985-1049; design §5.3 brief said "20" / task said
     * "15" — actual count reported, treated as authoritative).
     *
     * @override
     * @returns {Promise<void>}
     */
    async initGlobalSchema() {
        // Step 1 — create the 16 global tables in the public schema.
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.gamelog_location (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time BIGINT, group_name TEXT, UNIQUE(created_at, location))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.gamelog_join_leave (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time BIGINT, UNIQUE(created_at, type, display_name))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.gamelog_portal_spawn (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, display_name TEXT, location TEXT, user_id TEXT, instance_id TEXT, world_name TEXT, UNIQUE(created_at, display_name))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.gamelog_video_play (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, video_url TEXT, video_name TEXT, video_id TEXT, location TEXT, display_name TEXT, user_id TEXT, UNIQUE(created_at, video_url))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.gamelog_resource_load (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, resource_url TEXT, resource_type TEXT, location TEXT, UNIQUE(created_at, resource_url))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.gamelog_event (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, data TEXT, UNIQUE(created_at, data))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.gamelog_external (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, message TEXT, display_name TEXT, user_id TEXT, location TEXT, UNIQUE(created_at, message))`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.cache_avatar (id TEXT PRIMARY KEY, added_at TEXT, author_id TEXT, author_name TEXT, created_at TEXT, description TEXT, image_url TEXT, name TEXT, release_status TEXT, thumbnail_image_url TEXT, updated_at TEXT, version BIGINT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.cache_world (id TEXT PRIMARY KEY, added_at TEXT, author_id TEXT, author_name TEXT, created_at TEXT, description TEXT, image_url TEXT, name TEXT, release_status TEXT, thumbnail_image_url TEXT, updated_at TEXT, version BIGINT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.favorite_world (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, world_id TEXT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.favorite_avatar (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, avatar_id TEXT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.favorite_friend (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, created_at TEXT, user_id TEXT, group_name TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.memos (user_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.world_memos (world_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.avatar_memos (avatar_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.avatar_tags (avatar_id TEXT NOT NULL, tag TEXT NOT NULL, color TEXT, PRIMARY KEY (avatar_id, tag))`
        );
        // cookies 表纳入 GLOBAL_TABLES 走 global 主动迁移路径,与 IAuthStore
        // C# 侧 EnsureCookiesTable DDL 同步。PG 没有 LONGTEXT 类型(任意 TEXT
        // 本就无界,等价于 MySQL 的 LONGTEXT),所以 value 用 TEXT。表落在 public
        // schema,与其它 16 张全局表一致(_tablePkMap 用 bare name 作 key,
        // bulkInsert 走 global 路径时按 search_path 解析到 public.cookies)。
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.cookies (key TEXT PRIMARY KEY, value TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.configs (key TEXT PRIMARY KEY, value TEXT)`
        );
        await this.executeNonQuery(
            `CREATE TABLE IF NOT EXISTS public.node_registry (node_id TEXT PRIMARY KEY, mode TEXT NOT NULL, prefixes TEXT NOT NULL, heartbeat_at TEXT NOT NULL)`
        );
        // Step 2 — create the 5 global indexes (names preserved from
        // SQLiteAdapter; they remain unique within the public schema).
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS gamelog_location_created_at_idx ON public.gamelog_location (created_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_location_world_created ON public.gamelog_location (world_id, created_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON public.gamelog_join_leave (location)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_created ON public.gamelog_join_leave (user_id, created_at)`
        );
        await this.executeNonQuery(
            `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_display_created ON public.gamelog_join_leave (display_name, created_at)`
        );
        // Step 3 — record PK metadata for the layered replace path (INV-10).
        // Keys are BARE names (e.g. 'gamelog_location') — matching what
        // business modules pass to insert()/bulkInsert(); PG resolves
        // bare names to public.{name} via search_path.
        this._tablePkMap.set('gamelog_location', ['id']);
        this._tablePkMap.set('gamelog_join_leave', ['id']);
        this._tablePkMap.set('gamelog_portal_spawn', ['id']);
        this._tablePkMap.set('gamelog_video_play', ['id']);
        this._tablePkMap.set('gamelog_resource_load', ['id']);
        this._tablePkMap.set('gamelog_event', ['id']);
        this._tablePkMap.set('gamelog_external', ['id']);
        this._tablePkMap.set('cache_avatar', ['id']);
        this._tablePkMap.set('cache_world', ['id']);
        this._tablePkMap.set('favorite_world', ['id']);
        this._tablePkMap.set('favorite_avatar', ['id']);
        this._tablePkMap.set('favorite_friend', ['id']);
        this._tablePkMap.set('memos', ['user_id']);
        this._tablePkMap.set('world_memos', ['world_id']);
        this._tablePkMap.set('avatar_memos', ['avatar_id']);
        this._tablePkMap.set('avatar_tags', ['avatar_id', 'tag']);
        this._tablePkMap.set('cookies', ['key']);
    }

    // ── Metadata (listTables / getTableColumns / listTablesTypes) ─────
    // Slice S5 (§4.1.9 / §4.1.10 / §4.1.11 + §8 INV-02 + §9 R4/R11 +
    // §10.2). Enumerates `pg_catalog.pg_tables` / `information_schema.columns`
    // and returns schema-qualified names (`account_xxx.feed_gps`) so the
    // results can be fed straight back into SQL identifiers (D4).

    /**
     * Strip the SQLite-style `%_` prefix from a LIKE pattern.
     *
     * `%_feed_gps` → `feed_gps`; `feed_gps` → `feed_gps`. Used by
     * `listTables` to split a flat SQLite pattern into the PG
     * (schemaPattern, tablePattern) pair — PG keeps the per-account prefix
     * in the schema name, so the table-name pattern is the suffix past
     * `%_`.
     *
     * @private
     * @param {string} likePattern - SQLite-style LIKE pattern
     * @returns {string} pattern with leading `%_` removed (if present)
     */
    _stripWildcardPrefix(likePattern) {
        if (typeof likePattern === 'string' && likePattern.startsWith('%_')) {
            return likePattern.slice(2);
        }
        return likePattern;
    }

    /**
     * Split a schema-qualified table identifier into `{ schema, name }`.
     *
     * `'account_xxx.feed_gps'` → `{ schema: 'account_xxx', name: 'feed_gps' }`;
     * `'public.gamelog_location'` → `{ schema: 'public', name: 'gamelog_location' }`;
     * bare `'gamelog_location'` → `{ schema: 'public', name: 'gamelog_location' }`
     * (bare names default to the `public` schema, matching how
     * `initGlobalSchema` registers them and how business modules query
     * them via the default `search_path`).
     *
     * @private
     * @param {string} table - optionally schema-qualified table name
     * @returns {{ schema: string, name: string }}
     */
    _splitQualified(table) {
        const dot = table.indexOf('.');
        if (dot >= 0) {
            return { schema: table.slice(0, dot), name: table.slice(dot + 1) };
        }
        return { schema: 'public', name: table };
    }

    /**
     * Enumerate table names matching a SQLite-style LIKE pattern.
     *
     * Three input shapes (§4.1.9 + §10.2 S5):
     *   - `'%_suffix'` → user tables across every `account_*` schema whose
     *     table name matches `suffix`. Returns `['account_abc.feed_gps', ...]`.
     *   - `'%'` / `null` / `undefined` → every table in every `account_*`
     *     schema (no table-name filter).
     *   - any other literal (e.g. `'gamelog_location'`, `'gamelog_%'`) →
     *     tables in the `public` schema matching that pattern.
     *
     * Returns schema-qualified two-segment identifiers (INV-02 / D4) so
     * callers can use the entries directly in `ALTER TABLE ${ret}` /
     * `SELECT ... FROM ${ret}` without re-attaching a prefix.
     *
     * R11: PG LIKE treats `_` as a single-char wildcard, so `account_%`
     * would match `accountX` (no underscore). The pattern is therefore
     * `account\_%` with an explicit `ESCAPE '\'` clause to make `_` literal.
     * With `standard_conforming_strings = on` (PG ≥ 9.1 default), the
     * string literal `'account\_%'` is the 10 chars `account\_%` and the
     * LIKE engine interprets `\_` as an escaped underscore.
     *
     * @override
     * @param {string} [likePattern] - SQLite-style LIKE pattern
     * @returns {Promise<string[]>} schema-qualified table names
     */
    async listTables(likePattern) {
        // C# `PostgreSQL.ExecuteJson` returns each row as a positional
        // array (`object[][]` serialised as `[[col1, col2, ...], ...]`),
        // NOT a keyed object — see `execute` JSDoc. The SELECT below
        // projects `schemaname, tablename` in that order, so `row[0]` is
        // the schema and `row[1]` is the table name. Named-property
        // access (`row.schemaname`) would yield `undefined` and produce
        // `'undefined.undefined'` entries (QA H1 root cause).
        const tables = [];
        if (typeof likePattern === 'string' && likePattern.startsWith('%_')) {
            // User tables across account_* schemas.
            const tablePattern = this._stripWildcardPrefix(likePattern);
            await this.execute(
                (row) => tables.push(`${row[0]}.${row[1]}`),
                `SELECT schemaname, tablename FROM pg_catalog.pg_tables
                 WHERE schemaname LIKE @schemaPattern ESCAPE '\\' AND tablename LIKE @tablePattern`,
                { schemaPattern: 'account\\_%', tablePattern }
            );
        } else if (
            likePattern === '%' ||
            likePattern === undefined ||
            likePattern === null
        ) {
            // Every table in every account_* schema (no table-name filter).
            await this.execute(
                (row) => tables.push(`${row[0]}.${row[1]}`),
                `SELECT schemaname, tablename FROM pg_catalog.pg_tables
                 WHERE schemaname LIKE @schemaPattern ESCAPE '\\'`,
                { schemaPattern: 'account\\_%' }
            );
        } else {
            // Global tables in the public schema.
            await this.execute(
                (row) => tables.push(`${row[0]}.${row[1]}`),
                `SELECT schemaname, tablename FROM pg_catalog.pg_tables
                 WHERE schemaname = @schemaPattern AND tablename LIKE @tablePattern`,
                { schemaPattern: 'public', tablePattern: likePattern }
            );
        }
        return tables;
    }

    /**
     * Get column metadata for a table.
     *
     * Returns the raw `information_schema.columns` rows for `table`. Each
     * row is a positional array `[column_name, data_type, is_nullable,
     * column_default]` (C# `ExecuteJson` returns `object[][]`, NOT keyed
     * objects — see `execute` JSDoc). R4 (§9) is closed: `getTableColumns`
     * has zero production call sites, so no structural alignment is
     * required; callers (tests only) read columns positionally.
     *
     * @override
     * @param {string} table - optionally schema-qualified table name
     * @returns {Promise<Array<Array>>} positional arrays
     *   `[column_name, data_type, is_nullable, column_default]` per row
     *   (R4 closed: no production caller relies on the SQLite
     *   `PRAGMA table_xinfo` shape)
     */
    async getTableColumns(table) {
        const { schema, name } = this._splitQualified(table);
        const rows = [];
        await this.execute(
            (row) => rows.push(row),
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = @schema AND table_name = @name
             ORDER BY ordinal_position`,
            { schema, name }
        );
        return rows;
    }

    /**
     * Describe a table's columns with SQLiteAdapter-compatible structure.
     *
     * Queries `information_schema.columns` for the base column metadata and
     * `pg_catalog.pg_index` + `pg_attribute` for the primary-key column
     * set, then maps to the `{ name, type, notNull, defaultValue, isPK,
     * isHidden }` shape that `SQLiteAdapter.listTablesTypes` (L644-671)
     * produces. `isHidden` has no PG equivalent and is always `false`.
     *
     * The `data_type` value is the PG type name (e.g. `text`, `bigint`),
     * not the original DDL token (e.g. `TEXT`, `INTEGER`). The sole
     * production consumer (`vrcx.js` L455 `copyTableData`) only reads
     * `name` and `isHidden`, so the divergence is safe.
     *
     * @private
     * @param {string} table - schema-qualified table name
     * @returns {Promise<Array<{name: string, type: string, notNull: boolean, defaultValue: *, isPK: boolean, isHidden: boolean}>>}
     */
    async _describeColumns(table) {
        const { schema, name } = this._splitQualified(table);
        // 1. Base column metadata from information_schema.
        // C# returns positional arrays (QA H2 root cause): the SELECT
        // projects `column_name, data_type, is_nullable, column_default`
        // in that order, so we convert each row into a named object here
        // once. The downstream `cols.map((c) => ({ name: c.column_name,
        // ... }))` then reads named properties correctly.
        const cols = [];
        await this.execute(
            (row) =>
                cols.push({
                    column_name: row[0],
                    data_type: row[1],
                    is_nullable: row[2],
                    column_default: row[3]
                }),
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = @schema AND table_name = @name
             ORDER BY ordinal_position`,
            { schema, name }
        );
        // 2. Primary-key column names from pg_catalog.
        // The SELECT projects only `a.attname`, so `row[0]` is the PK
        // column name (positional access — same root cause as H1/H2).
        const pkColNames = [];
        await this.execute(
            (row) => pkColNames.push(row[0]),
            `SELECT a.attname
             FROM pg_index i
             JOIN pg_attribute a
               ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = (@schema || '.' || @name)::regclass
               AND i.indisprimary`,
            { schema, name }
        );
        const pkSet = new Set(pkColNames);
        // 3. Map to SQLiteAdapter listTablesTypes structure.
        return cols.map((c) => ({
            name: c.column_name,
            type: c.data_type,
            notNull: c.is_nullable === 'NO',
            defaultValue: c.column_default,
            isPK: pkSet.has(c.column_name),
            isHidden: false
        }));
    }

    /**
     * Enumerate all user tables with their column metadata.
     *
     * Iterates `listTables('%')` (every `account_*` schema table) and
     * attaches per-table column descriptors from `_describeColumns`. The
     * returned shape mirrors `SQLiteAdapter.listTablesTypes` (L644-671):
     *   `[{ tableName: 'account_xxx.feed_gps',
     *       columns: [{ name, type, notNull, defaultValue, isPK, isHidden }] }]`
     *
     * The sole production consumer is `vrcx.js` L455 (`copyTableData`),
     * which reads only `tableName` and each column's `name` / `isHidden`.
     *
     * Note: only `account_*` schema tables are enumerated — global tables
     * in `public` are not included (per §4.1.11). PG→PG migration flows
     * that need global tables must enumerate them separately.
     *
     * @override
     * @returns {Promise<Array<{tableName: string, columns: Array<{name: string, type: string, notNull: boolean, defaultValue: *, isPK: boolean, isHidden: boolean}>}>>}
     */
    async listTablesTypes() {
        const tables = await this.listTables('%');
        const result = [];
        for (const table of tables) {
            const columns = await this._describeColumns(table);
            result.push({ tableName: table, columns });
        }
        return result;
    }

    /**
     * Enumerate the global (public-schema) tables with their column metadata.
     *
     * PgSQL-specific extension (not on the base class nor on SQLiteAdapter /
     * MySQLAdapter, which enumerate ALL tables — global + user — flatly via
     * `listTablesTypes`). PostgreSQL keeps user tables in per-account
     * `account_*` schemas and global tables in the `public` schema, so
     * `listTablesTypes` only returns `account_*` tables (per its JSDoc:
     * "only `account_*` schema tables are enumerated — global tables in
     * `public` are not included"). The remote→SQLite backup engine needs to
     * copy BOTH global and user tables, so it calls this method for the
     * global half and `listTablesTypes` for the user half.
     *
     * Returns the same `{ tableName, columns }` shape as
     * `listTablesTypes`, with `tableName` schema-qualified as
     * `public.{name}` so the entries can be fed straight back into SQL
     * identifiers (same convention as `listTables`).
     *
     * @returns {Promise<Array<{tableName: string, columns: Array<{name: string, type: string, notNull: boolean, defaultValue: *, isPK: boolean, isHidden: boolean}>}>>}
     */
    async listGlobalTablesTypes() {
        // Enumerate every table in the `public` schema explicitly. The 16
        // global tables don't share a single LIKE prefix (gamelog_*, cache_*,
        // favorite_*, *_memos, avatar_tags), so a direct schemaname filter is
        // simpler and more robust than multiple LIKE passes.
        const publicTables = [];
        await this.execute(
            (row) => publicTables.push(`${row[0]}.${row[1]}`),
            `SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname = @schema`,
            { schema: 'public' }
        );
        const result = [];
        for (const table of publicTables) {
            const columns = await this._describeColumns(table);
            result.push({ tableName: table, columns });
        }
        return result;
    }

    /**
     * 完备层计数器:`pg_stat_user_tables` 行级 DML 计数聚合
     * (n_tup_ins + n_tup_upd + n_tup_del,DB 级信号)。
     * 仅真实行变更递增——只读事务/查询不计入,避免兜底网被高频查询
     * 打满(假阳性只来自回滚,罕见且无害)。与 C# 漏斗 dv 同一计数器,
     * 基线去重保持一致。详见 docs/architecture/ADAPTER_API.md §9。
     *
     * @override @protected
     * @returns {Promise<number | null>}
     */
    async _readChangeCounter() {
        let version = null;
        await this.execute((row) => {
            version = Number(row[0]);
        }, 'SELECT COALESCE(SUM(n_tup_ins + n_tup_upd + n_tup_del), 0) FROM pg_stat_user_tables');
        return version;
    }
}

export { PgSQLAdapter };
