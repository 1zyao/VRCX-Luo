import { activityV2 } from './activityV2.js';
import { avatarFavorites } from './avatarFavorites.js';
import { avatarTags } from './avatarTags.js';
import { feed } from './feed.js';
import { friendFavorites } from './friendFavorites.js';
import { friendLogCurrent } from './friendLogCurrent.js';
import { friendLogHistory } from './friendLogHistory.js';
import { gameLog } from './gameLog.js';
import { manualRelations } from './manualRelations.js';
import { memos } from './memos.js';
import { moderation } from './moderation.js';
import { mutualGraph } from './mutualGraph.js';
import { notifications } from './notifications.js';
import { tableSize } from './tableSize.js';
import { trackedNonFriends } from './trackedNonFriends.js';
import { worldFavorites } from './worldFavorites.js';
import { runMigrations } from './migrations/index.js';

import { adapter } from './adapter/index.js';

const dbVars = {
    userId: '',
    userPrefix: '',
    maxTableSize: 500,
    searchTableSize: 5000
};

const database = {
    ...feed,
    ...activityV2,
    ...gameLog,
    ...notifications,
    ...moderation,
    ...friendLogHistory,
    ...friendLogCurrent,
    ...memos,
    ...avatarFavorites,
    ...avatarTags,
    ...friendFavorites,
    ...worldFavorites,
    ...tableSize,
    ...mutualGraph,
    ...trackedNonFriends,
    ...manualRelations,

    setMaxTableSize(limit) {
        dbVars.maxTableSize = limit;
    },

    setSearchTableSize(limit) {
        dbVars.searchTableSize = limit;
    },

    async initUserTables(userId) {
        dbVars.userId = userId;
        dbVars.userPrefix = userId.replaceAll('-', '').replaceAll('_', '');
        if (dbVars.userPrefix.match(/^\d/)) {
            dbVars.userPrefix = '_' + dbVars.userPrefix;
        }
        await adapter.initUserSchema(dbVars.userPrefix);
    },

    getUserPrefix() {
        return dbVars.userPrefix;
    },

    async initTables() {
        await adapter.initGlobalSchema();
    },

    /**
     * 在事务中执行 fn。委托给 adapter.withTransaction,自动管理
     * connId 获取/提交/回滚 + 事务上下文栈。fn 内调用 database
     * 模块的写方法自动走 pinned 连接(事务态)。
     *
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withTransaction(fn) {
        return adapter.withTransaction(fn);
    },

    async vacuum() {
        await adapter.vacuum();
    },

    async optimize() {
        await adapter.optimize();
    },

    /**
     * 执行数据库迁移 (基于 .map 文件的新迁移系统)。
     * @param {number} currentVersion - 当前版本
     * @param {number} targetVersion - 目标版本
     * @param {object} [options] - 选项
     * @param {object} [options.oldDb] - 旧数据库适配器实例
     * @returns {Promise<boolean>}
     */
    async runMigrations(currentVersion, targetVersion, options = {}) {
        return await runMigrations(currentVersion, targetVersion, options);
    }
};

window.database = database;
export { database, dbVars };
