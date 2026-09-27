import { dbVars } from '../database';

import { adapter } from './adapter/index.js';

/**
 * 跨客户端双写去重窗口(ms)。
 *
 * 两个 VRCX 客户端连同一数据库时，各自轮询到同一 feed 事件会分别写一行，
 * 且 created_at = 客户端本地检测时间(nowIso())，两行差几十秒(实测集中在
 * 30~120s)。因此写前用"内容全等 + created_at 落在本窗口"判定是否为同一事件，
 * 命中则跳过本次写入。窗口需覆盖主要轮询偏差；不宜过大(如 300s)，否则会误
 * 合并一个人在几个房间/世界间快速来回切换的合法事件。
 */
export const FEED_DEDUP_WINDOW_MS = 120000;

/**
 * 写 feed 前预检：目标表最近 FEED_DEDUP_WINDOW_MS 内是否已存在
 * "除 created_at/time 外完全一致"的行。命中（说明该事件已写入，通常是
 * 另一客户端）→ 返回 true。
 *
 * MySQL/PostgreSQL 下在事务栈(withTransaction)内用加锁读 `FOR UPDATE`：
 * 对同一 user_id 的行加锁 → 两个客户端对同一事件的"查+插"串行化，
 * 后到者等先到者提交后能查到其行而跳过 → 竞态安全(需 user_id 索引支撑)。
 * SQLite 文件锁天然串行写、且不支持 FOR UPDATE，故走普通查询。
 *
 * @param {string} table 物理表名（含账号前缀）
 * @param {object} data 即将写入的列值映射
 * @returns {Promise<boolean>} true=窗口内已有相同内容，应跳过本次写入
 */
export async function hasRecentDuplicate(table, data) {
    const cutoff = new Date(Date.now() - FEED_DEDUP_WINDOW_MS).toJSON();
    const where = [];
    const params = { __cutoff: cutoff };
    for (const [key, value] of Object.entries(data)) {
        if (key === 'created_at' || key === 'time' || value === undefined) {
            continue;
        }
        where.push(`${key} = @${key}`);
        params[key] = value;
    }
    if (where.length === 0) return false;
    const cond = `${where.join(' AND ')} AND created_at >= @__cutoff`;
    if (adapter.engineType === 'mysql' || adapter.engineType === 'postgresql') {
        let found = false;
        await adapter.execute(
            (_row) => {
                found = true;
            },
            `SELECT id FROM ${table} WHERE ${cond} ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            params
        );
        if (found) return true;
        return false;
    }
    const rows = await adapter.selectWhere(table, ['id'], cond, params, {
        order: 'id DESC',
        limit: 1
    });
    if (rows.length > 0) return true;
    return false;
}

/**
 * 跨客户端去重写入：预检命中（窗口内已有相同内容，通常是另一客户端已写入）
 * → 跳过插入；未命中 → 正常插入。
 *
 * fail-open：预检/事务任何异常都回退到直接 insert，绝不因去重逻辑丢失事件
 * （最坏只是多写一行重复，与现状一致，而不是少写一条真实记录）。
 *
 * @param {string} table 物理表名（含账号前缀）
 * @param {object} data 即将写入的列值映射
 * @returns {Promise<void>}
 */
export async function dedupInsert(table, data) {
    try {
        if (
            adapter.engineType === 'mysql' ||
            adapter.engineType === 'postgresql'
        ) {
            // 加锁读必须落在事务内才生效；两客户端对同一事件的"查+插"被串行化。
            await adapter.withTransaction(async () => {
                if (await hasRecentDuplicate(table, data)) return;
                await adapter.insert(table, data, 'ignore');
            });
        } else {
            if (await hasRecentDuplicate(table, data)) return;
            await adapter.insert(table, data, 'ignore');
        }
    } catch (err) {
        console.error(
            `[feed] dedup write failed (${table}), falling back to direct insert:`,
            err
        );
        try {
            await adapter.insert(table, data, 'ignore');
        } catch (fallbackErr) {
            console.error(
                `[feed] fallback insert failed (${table}):`,
                fallbackErr
            );
        }
    }
}

/**
 * 22-column schema shared by all feed UNION ALL queries.
 * Each source realises different positions and NULL-pads the rest.
 */
const FEED_COLUMNS = [
    'id',
    'created_at',
    'user_id',
    'display_name',
    'type',
    'location',
    'world_name',
    'previous_location',
    'time',
    'group_name',
    'status',
    'status_description',
    'previous_status',
    'previous_status_description',
    'bio',
    'previous_bio',
    'owner_id',
    'avatar_name',
    'current_avatar_image_url',
    'current_avatar_thumbnail_image_url',
    'previous_current_avatar_image_url',
    'previous_current_avatar_thumbnail_image_url'
];
const FEED_COL_STR = FEED_COLUMNS.join(', ');
const N = (name) => `CAST(NULL AS TEXT) AS ${name}`; // inline null helper — CAST gives TEXT affinity so System.Data.SQLite doesn't NPE on null decltype
// `time` 在 feed_gps / feed_online_offline 中是有符号整数列（各引擎均为
// INTEGER/BIGINT），其余分支必须用同类型 NULL 填充，否则 PG 的
// UNION ALL 会报 42804（bigint 与 text 无法匹配）。SQLite/MySQL
// 容忍类型不一致，但保持全引擎一致的 BIGINT 空值 CAST 更安全。
const NB = (name) => `CAST(NULL AS BIGINT) AS ${name}`;

/**
 * Build a structured source descriptor for adapter.selectUnion.
 * @param {string} table  - table name (with prefix)
 * @param {string[]} cols - real column expressions for this source (22 positions)
 * @param {object}  opts  - { where, params, order, limit }
 * @returns {object} selectUnion source descriptor
 */
function feedSource(table, cols, { where, params, order, limit }) {
    return { table, columns: cols, where, params, order, limit };
}

/** Real columns for the GPS feed sub-query (positions 0-9). */
const GPS_COLS = [
    'id',
    'created_at',
    'user_id',
    'display_name',
    "'GPS' AS type",
    'location',
    'world_name',
    'previous_location',
    'time',
    'group_name',
    ...FEED_COLUMNS.slice(10).map(N)
];

/** Real columns for the Status feed sub-query (positions 0-4, 10-13). */
const STATUS_COLS = [
    'id',
    'created_at',
    'user_id',
    'display_name',
    "'Status' AS type",
    N('location'),
    N('world_name'),
    N('previous_location'),
    NB('time'),
    N('group_name'),
    'status',
    'status_description',
    'previous_status',
    'previous_status_description',
    ...FEED_COLUMNS.slice(14).map(N)
];

/** Real columns for the Bio feed sub-query (positions 0-4, 14-15). */
const BIO_COLS = [
    'id',
    'created_at',
    'user_id',
    'display_name',
    "'Bio' AS type",
    N('location'),
    N('world_name'),
    N('previous_location'),
    NB('time'),
    N('group_name'),
    N('status'),
    N('status_description'),
    N('previous_status'),
    N('previous_status_description'),
    'bio',
    'previous_bio',
    ...FEED_COLUMNS.slice(16).map(N)
];

/** Real columns for the Avatar feed sub-query (positions 0-4, 16-21). */
const AVATAR_COLS = [
    'id',
    'created_at',
    'user_id',
    'display_name',
    "'Avatar' AS type",
    N('location'),
    N('world_name'),
    N('previous_location'),
    NB('time'),
    N('group_name'),
    N('status'),
    N('status_description'),
    N('previous_status'),
    N('previous_status_description'),
    N('bio'),
    N('previous_bio'),
    'owner_id',
    'avatar_name',
    'current_avatar_image_url',
    'current_avatar_thumbnail_image_url',
    'previous_current_avatar_image_url',
    'previous_current_avatar_thumbnail_image_url'
];

/** Real columns for the Online/Offline feed sub-query (positions 0-6, 8-9). */
const ONOFF_COLS = [
    'id',
    'created_at',
    'user_id',
    'display_name',
    'type',
    'location',
    'world_name',
    N('previous_location'),
    'time',
    'group_name',
    N('status'),
    N('status_description'),
    N('previous_status'),
    N('previous_status_description'),
    N('bio'),
    N('previous_bio'),
    N('owner_id'),
    N('avatar_name'),
    N('current_avatar_image_url'),
    N('current_avatar_thumbnail_image_url'),
    N('previous_current_avatar_image_url'),
    N('previous_current_avatar_thumbnail_image_url')
];

/** Shared row → object mapper for all feed UNION ALL results. */
function mapFeedRow(dbRow) {
    const type = dbRow[4];
    const row = {
        rowId: dbRow[0],
        created_at: dbRow[1],
        userId: dbRow[2],
        displayName: dbRow[3],
        type
    };
    switch (type) {
        case 'GPS':
            row.location = dbRow[5];
            row.worldName = dbRow[6];
            row.previousLocation = dbRow[7];
            row.time = dbRow[8];
            row.groupName = dbRow[9];
            break;
        case 'Status':
            row.status = dbRow[10];
            row.statusDescription = dbRow[11];
            row.previousStatus = dbRow[12];
            row.previousStatusDescription = dbRow[13];
            break;
        case 'Bio':
            row.bio = dbRow[14];
            row.previousBio = dbRow[15];
            break;
        case 'Avatar':
            row.ownerId = dbRow[16];
            row.avatarName = dbRow[17];
            row.currentAvatarImageUrl = dbRow[18];
            row.currentAvatarThumbnailImageUrl = dbRow[19];
            row.previousCurrentAvatarImageUrl = dbRow[20];
            row.previousCurrentAvatarThumbnailImageUrl = dbRow[21];
            break;
        case 'Online':
        case 'Offline':
            row.location = dbRow[5];
            row.worldName = dbRow[6];
            row.time = dbRow[8];
            row.groupName = dbRow[9];
            break;
    }
    return row;
}

const feed = {
    async addGPSToDatabase(entry) {
        await dedupInsert(adapter.userTable(dbVars.userPrefix, 'feed_gps'), {
            created_at: entry.created_at,
            user_id: entry.userId,
            display_name: entry.displayName,
            location: entry.location,
            world_name: entry.worldName,
            previous_location: entry.previousLocation,
            time: entry.time,
            group_name: entry.groupName
        });
    },

    async addStatusToDatabase(entry) {
        await dedupInsert(adapter.userTable(dbVars.userPrefix, 'feed_status'), {
            created_at: entry.created_at,
            user_id: entry.userId,
            display_name: entry.displayName,
            status: entry.status,
            status_description: entry.statusDescription,
            previous_status: entry.previousStatus,
            previous_status_description: entry.previousStatusDescription
        });
    },

    async addBioToDatabase(entry) {
        await dedupInsert(adapter.userTable(dbVars.userPrefix, 'feed_bio'), {
            created_at: entry.created_at,
            user_id: entry.userId,
            display_name: entry.displayName,
            bio: entry.bio,
            previous_bio: entry.previousBio
        });
    },

    async getLastBioChangeForUser(userId) {
        const rows = await adapter.selectWhere(
            adapter.userTable(dbVars.userPrefix, 'feed_bio'),
            ['bio', 'previous_bio', 'created_at'],
            'user_id = @userId',
            { userId },
            { order: 'id DESC', limit: 1 }
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            bio: row[0],
            previousBio: row[1],
            createdAt: row[2]
        };
    },

    async searchBiosByContent(query, limit = 10) {
        const bioTable = adapter.userTable(dbVars.userPrefix, 'feed_bio');
        const maxRows = await adapter.selectGroupBy(bioTable, {
            columns: ['user_id'],
            aggregates: [{ expr: 'MAX(id)', alias: 'max_id' }],
            groupBy: ['user_id']
        });
        const maxIds = maxRows.map((r) => r[1]);
        if (maxIds.length === 0) return [];

        const rows = await adapter.selectWhereIn(
            bioTable,
            ['user_id', 'display_name', 'bio'],
            'id',
            maxIds,
            'bio LIKE @searchLike',
            { searchLike: `%${query}%` },
            { limit }
        );
        return rows.map((row) => ({
            userId: row[0],
            displayName: row[1],
            bio: row[2]
        }));
    },

    async getLastStatusChangeForUser(userId) {
        const rows = await adapter.selectWhere(
            adapter.userTable(dbVars.userPrefix, 'feed_status'),
            [
                'status',
                'status_description',
                'previous_status',
                'previous_status_description',
                'created_at'
            ],
            'user_id = @userId',
            { userId },
            { order: 'id DESC', limit: 1 }
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            status: row[0],
            statusDescription: row[1],
            previousStatus: row[2],
            previousStatusDescription: row[3],
            createdAt: row[4]
        };
    },

    /**
     * 最近一次记录到的模型封面（feed_avatar 变更事件）。
     * 用于资料页：VRChat 不返回某玩家的 currentAvatar* 时（例如他设了 VRC+ 头像、
     * 或本节点还没收到 WS 更新），退回本地记录过的封面，而不是拿头像顶替。
     * @param {string} userId
     * @returns {Promise<{currentAvatarImageUrl: string, currentAvatarThumbnailImageUrl: string, createdAt: string}|null>}
     */
    async getLastAvatarChangeForUser(userId) {
        const rows = await adapter.selectWhere(
            adapter.userTable(dbVars.userPrefix, 'feed_avatar'),
            [
                'current_avatar_image_url',
                'current_avatar_thumbnail_image_url',
                'avatar_name',
                'created_at'
            ],
            "user_id = @userId AND ((current_avatar_image_url IS NOT NULL AND current_avatar_image_url != '') OR (current_avatar_thumbnail_image_url IS NOT NULL AND current_avatar_thumbnail_image_url != ''))",
            { userId },
            { order: 'id DESC', limit: 1 }
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            currentAvatarImageUrl: row[0] || '',
            currentAvatarThumbnailImageUrl: row[1] || '',
            avatarName: row[2] || '',
            createdAt: row[3]
        };
    },

    async getRecentBioChangesForUser(userId, limit = 50) {
        const rows = await adapter.selectWhere(
            adapter.userTable(dbVars.userPrefix, 'feed_bio'),
            ['bio', 'previous_bio', 'created_at'],
            'user_id = @userId',
            { userId },
            { order: 'id DESC', limit: limit }
        );
        return rows.map((row) => ({
            bio: row[0],
            previousBio: row[1],
            createdAt: row[2]
        }));
    },

    async addAvatarToDatabase(entry) {
        await dedupInsert(adapter.userTable(dbVars.userPrefix, 'feed_avatar'), {
            created_at: entry.created_at,
            user_id: entry.userId,
            display_name: entry.displayName,
            owner_id: entry.ownerId,
            avatar_name: entry.avatarName,
            current_avatar_image_url: entry.currentAvatarImageUrl,
            current_avatar_thumbnail_image_url:
                entry.currentAvatarThumbnailImageUrl,
            previous_current_avatar_image_url:
                entry.previousCurrentAvatarImageUrl,
            previous_current_avatar_thumbnail_image_url:
                entry.previousCurrentAvatarThumbnailImageUrl
        });
    },

    /**
     * Purges avatar feed data from the database.
     * !!!!
     * @param {string|null} cutoffDate - ISO date string. Deletes records older than this date. If null, deletes all records.
     */
    async purgeAvatarFeedData(cutoffDate) {
        if (cutoffDate) {
            await adapter.deleteWhere(
                adapter.userTable(dbVars.userPrefix, 'feed_avatar'),
                'created_at < @cutoff',
                { cutoff: cutoffDate }
            );
        } else {
            await adapter.deleteAll(
                adapter.userTable(dbVars.userPrefix, 'feed_avatar')
            );
        }
    },

    async addOnlineOfflineToDatabase(entry) {
        await dedupInsert(
            adapter.userTable(dbVars.userPrefix, 'feed_online_offline'),
            {
                created_at: entry.created_at,
                user_id: entry.userId,
                display_name: entry.displayName,
                type: entry.type,
                location: entry.location,
                world_name: entry.worldName,
                // Online 事件无时长，调用方传空串；PG BIGINT 列拒绝 text
                // 空串（42804），SQLite/MySQL 因动态类型/宽松转换容忍。
                // 统一归一化为 NULL —— 三引擎均接受，语义也更准确。
                time: entry.time === '' ? null : entry.time,
                group_name: entry.groupName
            }
        );
    },

    /**
     * Returns all status change records for a specific user, ordered by time.
     * Used to build the status distribution chart in the user dialog.
     *
     * @param {string} userId
     * @returns {Promise<Array<{createdAt: string, status: string}>>}
     */
    async getStatusHistoryForUser(userId) {
        const rows = await adapter.selectWhere(
            adapter.userTable(dbVars.userPrefix, 'feed_status'),
            ['created_at', 'status'],
            'user_id = @userId',
            { userId },
            { order: 'created_at ASC' }
        );
        return rows.map((row) => ({
            createdAt: row[0],
            status: row[1]
        }));
    },

    /**
     * Returns all online/offline records for a specific user, ordered by time.
     * Used to calculate actual duration spent in each status.
     *
     * @param {string} userId
     * @returns {Promise<Array<{createdAt: string, type: 'Online'|'Offline'}>>}
     */
    async getOnlineOfflineHistoryForUser(userId) {
        const rows = await adapter.selectWhere(
            adapter.userTable(dbVars.userPrefix, 'feed_online_offline'),
            ['created_at', 'type'],
            'user_id = @userId',
            { userId },
            { order: 'created_at ASC' }
        );
        return rows.map((row) => ({
            createdAt: row[0],
            type: row[1]
        }));
    },

    /**
     * Returns the most recent timestamp at which a friend arrived at the given
     * location, as recorded in the GPS feed table.  Works for both real
     * instances and "private" / "private:private" locations.
     *
     * @param {string} userId
     * @param {string} location
     * @returns {Promise<number|null>} Unix timestamp (ms) or null
     */
    async getLastGPSArrivalTimeForUser(userId, location) {
        const rows = await adapter.selectWhere(
            adapter.userTable(dbVars.userPrefix, 'feed_gps'),
            ['created_at'],
            'user_id = @userId AND location = @location',
            { userId, location },
            { order: 'id DESC', limit: 1 }
        );
        if (rows.length === 0) return null;
        const ts = Date.parse(rows[0][0]);
        return isNaN(ts) ? null : ts;
    },

    async searchFeedDatabase(
        search,
        filters,
        vipList,
        maxEntries = dbVars.searchTableSize,
        dateFrom = '',
        dateTo = ''
    ) {
        if (search.startsWith('wrld_') || search.startsWith('grp_')) {
            return this.getFeedByInstanceId(search, filters, vipList);
        }
        let vipQuery = '';
        const vipArgs = {};
        if (vipList.length > 0) {
            const vipPlaceholders = [];
            vipList.forEach((vip, i) => {
                const key = `vip_${i}`;
                vipArgs[key] = vip;
                vipPlaceholders.push(`@${key}`);
            });
            vipQuery = `AND user_id IN (${vipPlaceholders.join(', ')})`;
        }
        let dateQuery = '';
        if (dateFrom) {
            dateQuery += 'AND created_at >= @dateFrom ';
        }
        if (dateTo) {
            dateQuery += 'AND created_at <= @dateTo ';
        }
        let gps = true;
        let status = true;
        let bio = true;
        let avatar = true;
        let online = true;
        let offline = true;
        const aviPublic = search.includes('public');
        const aviPrivate = search.includes('private');
        if (filters.length > 0) {
            gps = false;
            status = false;
            bio = false;
            avatar = false;
            online = false;
            offline = false;
            filters.forEach((filter) => {
                switch (filter) {
                    case 'GPS':
                        gps = true;
                        break;
                    case 'Status':
                        status = true;
                        break;
                    case 'Bio':
                        bio = true;
                        break;
                    case 'Avatar':
                        avatar = true;
                        break;
                    case 'Online':
                        online = true;
                        break;
                    case 'Offline':
                        offline = true;
                        break;
                }
            });
        }
        const searchLike = `%${search}%`;
        const sharedParams = { searchLike, ...vipArgs };
        if (dateFrom) {
            sharedParams.dateFrom = dateFrom;
        }
        if (dateTo) {
            sharedParams.dateTo = dateTo;
        }
        const srcOpts = {
            order: 'created_at DESC, id DESC',
            limit: maxEntries
        };
        const pushSource = (cols, table, where) => {
            sources.push(
                feedSource(table, cols, {
                    where,
                    params: sharedParams,
                    ...srcOpts
                })
            );
        };
        const sources = [];

        if (gps)
            pushSource(
                GPS_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_gps'),
                `(display_name LIKE @searchLike OR world_name LIKE @searchLike OR group_name LIKE @searchLike) ${dateQuery} ${vipQuery}`
            );
        if (status)
            pushSource(
                STATUS_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_status'),
                `(display_name LIKE @searchLike OR status LIKE @searchLike OR status_description LIKE @searchLike) ${dateQuery} ${vipQuery}`
            );
        if (bio)
            pushSource(
                BIO_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_bio'),
                `(display_name LIKE @searchLike OR bio LIKE @searchLike) ${dateQuery} ${vipQuery}`
            );
        if (avatar) {
            let avatarQuery = '';
            if (aviPrivate) avatarQuery = 'OR user_id = owner_id';
            else if (aviPublic) avatarQuery = 'OR user_id != owner_id';
            pushSource(
                AVATAR_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_avatar'),
                `(display_name LIKE @searchLike OR avatar_name LIKE @searchLike) ${avatarQuery} ${dateQuery} ${vipQuery}`
            );
        }
        if (online || offline) {
            let query = '';
            if (!online || !offline) {
                if (online) query = "AND type = 'Online'";
                else if (offline) query = "AND type = 'Offline'";
            }
            pushSource(
                ONOFF_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_online_offline'),
                `(display_name LIKE @searchLike OR world_name LIKE @searchLike OR group_name LIKE @searchLike) ${query} ${dateQuery} ${vipQuery}`
            );
        }
        if (sources.length === 0) return [];

        const rows = await adapter.selectUnion(sources, {
            schema: FEED_COL_STR,
            order: 'created_at DESC, id DESC',
            limit: maxEntries
        });
        return rows.map(mapFeedRow);
    },

    async lookupFeedDatabase(
        filters,
        vipList,
        maxEntries = dbVars.maxTableSize,
        prefixOverride
    ) {
        if (prefixOverride) {
            return adapter.withPrefix(prefixOverride, () =>
                this.lookupFeedDatabase(filters, vipList, maxEntries)
            );
        }
        let vipQuery = '';
        const vipArgs = {};
        if (vipList.length > 0) {
            const vipPlaceholders = [];
            vipList.forEach((vip, i) => {
                const key = `vip_${i}`;
                vipArgs[key] = vip;
                vipPlaceholders.push(`@${key}`);
            });
            vipQuery = `AND user_id IN (${vipPlaceholders.join(', ')})`;
        }
        let gps = true;
        let status = true;
        let bio = true;
        let avatar = true;
        let online = true;
        let offline = true;
        if (filters.length > 0) {
            gps = false;
            status = false;
            bio = false;
            avatar = false;
            online = false;
            offline = false;
            filters.forEach((filter) => {
                switch (filter) {
                    case 'GPS':
                        gps = true;
                        break;
                    case 'Status':
                        status = true;
                        break;
                    case 'Bio':
                        bio = true;
                        break;
                    case 'Avatar':
                        avatar = true;
                        break;
                    case 'Online':
                        online = true;
                        break;
                    case 'Offline':
                        offline = true;
                        break;
                }
            });
        }
        const srcOpts = { order: 'id DESC', limit: maxEntries };
        const sources = [];
        const pushSource = (cols, table, where) => {
            sources.push(
                feedSource(table, cols, { where, params: vipArgs, ...srcOpts })
            );
        };
        if (gps)
            pushSource(
                GPS_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_gps'),
                `1=1 ${vipQuery}`
            );
        if (status)
            pushSource(
                STATUS_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_status'),
                `1=1 ${vipQuery}`
            );
        if (bio)
            pushSource(
                BIO_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_bio'),
                `1=1 ${vipQuery}`
            );
        if (avatar)
            pushSource(
                AVATAR_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_avatar'),
                `1=1 ${vipQuery}`
            );
        if (online || offline) {
            let query = '';
            if (!online || !offline) {
                if (online) query = "AND type = 'Online'";
                else if (offline) query = "AND type = 'Offline'";
            }
            pushSource(
                ONOFF_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_online_offline'),
                `1=1 ${query} ${vipQuery}`
            );
        }
        if (sources.length === 0) return [];

        const rows = await adapter.selectUnion(sources, {
            schema: FEED_COL_STR,
            order: 'created_at DESC, id DESC',
            limit: maxEntries
        });
        return rows.map(mapFeedRow);
    },

    async getFeedByInstanceId(instanceId, filters, vipList) {
        let vipQuery = '';
        const vipArgs = {};
        if (vipList.length > 0) {
            const vipPlaceholders = [];
            vipList.forEach((vip, i) => {
                const key = `vip_${i}`;
                vipArgs[key] = vip;
                vipPlaceholders.push(`@${key}`);
            });
            vipQuery = `AND user_id IN (${vipPlaceholders.join(', ')})`;
        }
        let gps = true;
        let online = true;
        let offline = true;
        if (filters.length > 0) {
            gps = false;
            online = false;
            offline = false;
            filters.forEach((filter) => {
                switch (filter) {
                    case 'GPS':
                        gps = true;
                        break;
                    case 'Online':
                        online = true;
                        break;
                    case 'Offline':
                        offline = true;
                        break;
                }
            });
        }
        const instanceWhere = `location LIKE @instanceLike`;
        const srcOpts = {
            order: 'created_at DESC, id DESC',
            limit: dbVars.searchTableSize
        };
        const sources = [];
        const pushSource = (cols, table, where) => {
            sources.push(
                feedSource(table, cols, { where, params: vipArgs, ...srcOpts })
            );
        };
        vipArgs.instanceLike = `%${instanceId}%`;

        if (gps)
            pushSource(
                GPS_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_gps'),
                `${instanceWhere} ${vipQuery}`
            );
        if (online || offline) {
            let query = '';
            if (!online || !offline) {
                if (online) query = "AND type = 'Online'";
                else if (offline) query = "AND type = 'Offline'";
            }
            pushSource(
                ONOFF_COLS,
                adapter.userTable(dbVars.userPrefix, 'feed_online_offline'),
                `${instanceWhere} ${query} ${vipQuery}`
            );
        }
        if (sources.length === 0) return [];

        const rows = await adapter.selectUnion(sources, {
            schema: FEED_COL_STR,
            order: 'created_at DESC, id DESC',
            limit: dbVars.searchTableSize
        });
        return rows.map(mapFeedRow);
    },

    /**
     * @param {number} days - Number of days to look back
     * @param {number} limit - Max number of worlds to return
     * @returns {Promise<Array>} Ranked list of hot worlds
     */
    async getHotWorlds(days = 30, limit = 30) {
        const halfDays = Math.floor(days / 2);
        const daysAgo = adapter.daysAgoISO(days);
        const halfAgo = adapter.daysAgoISO(halfDays);
        const gpsTable = adapter.userTable(dbVars.userPrefix, 'feed_gps');
        const baseWhere = `created_at >= @daysAgo AND location LIKE 'wrld_%' AND ${adapter.sqlHasInstanceId('location')} AND world_name IS NOT NULL AND world_name != ''`;

        const mainRows = await adapter.selectGroupBy(gpsTable, {
            columns: [`${adapter.sqlExtractWorldId('location')} AS world_id`],
            aggregates: [
                { expr: 'MAX(world_name)', alias: 'world_name' },
                { expr: 'COUNT(*)', alias: 'visit_count' },
                { expr: 'COUNT(DISTINCT user_id)', alias: 'unique_friends' },
                { expr: 'MAX(created_at)', alias: 'last_visited' }
            ],
            groupBy: ['world_id'],
            where: baseWhere,
            params: { daysAgo },
            order: 'unique_friends DESC, visit_count DESC',
            limit
        });
        const results = mainRows.map((dbRow) => ({
            worldId: dbRow[0],
            worldName: dbRow[1],
            visitCount: dbRow[2],
            uniqueFriends: dbRow[3],
            lastVisited: dbRow[4]
        }));

        const trendRows = await adapter.selectGroupBy(gpsTable, {
            columns: [`${adapter.sqlExtractWorldId('location')} AS world_id`],
            aggregates: [
                { expr: 'COUNT(DISTINCT user_id)', alias: 'unique_friends' }
            ],
            groupBy: ['world_id'],
            where: `created_at >= @daysAgo AND created_at < @halfAgo AND location LIKE 'wrld_%' AND ${adapter.sqlHasInstanceId('location')} AND world_name IS NOT NULL AND world_name != ''`,
            params: { daysAgo, halfAgo }
        });
        const trendMap = new Map();
        for (const dbRow of trendRows) trendMap.set(dbRow[0], dbRow[1]);

        const recentRows = await adapter.selectGroupBy(gpsTable, {
            columns: [`${adapter.sqlExtractWorldId('location')} AS world_id`],
            aggregates: [
                { expr: 'COUNT(DISTINCT user_id)', alias: 'unique_friends' }
            ],
            groupBy: ['world_id'],
            where: `created_at >= @halfAgo AND location LIKE 'wrld_%' AND ${adapter.sqlHasInstanceId('location')} AND world_name IS NOT NULL AND world_name != ''`,
            params: { halfAgo }
        });
        const recentMap = new Map();
        for (const dbRow of recentRows) recentMap.set(dbRow[0], dbRow[1]);

        for (const world of results) {
            const oldFriends = trendMap.get(world.worldId) || 0;
            const newFriends = recentMap.get(world.worldId) || 0;
            if (newFriends > oldFriends) {
                world.trend = 'rising';
            } else if (newFriends < oldFriends) {
                world.trend = 'cooling';
            } else {
                world.trend = 'stable';
            }
        }

        return results;
    },

    /**
     * @param {string} worldId - The world ID (e.g. wrld_xxx)
     * @param {number} days - Number of days to look back
     * @returns {Promise<Array>} List of friends who visited
     */
    async getHotWorldFriendDetail(worldId, days = 30) {
        const daysAgo = adapter.daysAgoISO(days);
        const rows = await adapter.selectGroupBy(
            adapter.userTable(dbVars.userPrefix, 'feed_gps'),
            {
                columns: ['user_id'],
                aggregates: [
                    { expr: 'MAX(display_name)', alias: 'display_name' },
                    { expr: 'COUNT(*)', alias: 'visit_count' },
                    { expr: 'MAX(created_at)', alias: 'last_visit' }
                ],
                groupBy: ['user_id'],
                where: `${adapter.sqlExtractWorldId('location')} = @worldId AND created_at >= @daysAgo`,
                params: { worldId, daysAgo },
                order: 'visit_count DESC'
            }
        );
        return rows.map((dbRow) => ({
            userId: dbRow[0],
            displayName: dbRow[1],
            visitCount: dbRow[2],
            lastVisit: dbRow[3]
        }));
    }
};

export { feed };
