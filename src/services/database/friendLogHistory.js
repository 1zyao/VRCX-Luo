import { dbVars } from '../database';

import { adapter } from './adapter/index.js';
import { dedupInsert } from './feed.js';

const friendLogHistory = {
    async getFriendLogHistory() {
        const rows = await adapter.select(
            adapter.userTable(dbVars.userPrefix, 'friend_log_history'),
            '*'
        );
        return rows
            .map((dbRow) => {
                var row = {
                    rowId: dbRow[0],
                    created_at: dbRow[1],
                    type: dbRow[2],
                    userId: dbRow[3],
                    displayName: dbRow[4],
                    friendNumber: dbRow[8]
                };
                if (row.type === 'DisplayName') {
                    row.previousDisplayName = dbRow[5];
                } else if (row.type === 'TrustLevel') {
                    row.trustLevel = dbRow[6];
                    row.previousTrustLevel = dbRow[7];
                }
                return row;
            })
            .reverse();
    },

    async addFriendLogHistory(entry) {
        await dedupInsert(
            adapter.userTable(dbVars.userPrefix, 'friend_log_history'),
            {
                created_at: entry.created_at,
                type: entry.type,
                user_id: entry.userId,
                display_name: entry.displayName,
                previous_display_name: entry.previousDisplayName,
                trust_level: entry.trustLevel,
                previous_trust_level: entry.previousTrustLevel,
                friend_number: entry.friendNumber
            }
        );
    },

    // @deprecated Currently unused — kept for future batch-insert callers
    async addFriendLogHistoryArray(inputData) {
        if (inputData.length === 0) {
            return;
        }
        const rows = inputData.map((line) => ({
            created_at:
                typeof line.created_at === 'string' ? line.created_at : null,
            type: typeof line.type === 'string' ? line.type : null,
            user_id: typeof line.userId === 'string' ? line.userId : null,
            display_name:
                typeof line.displayName === 'string' ? line.displayName : null,
            previous_display_name:
                typeof line.previousDisplayName === 'string'
                    ? line.previousDisplayName
                    : null,
            trust_level:
                typeof line.trustLevel === 'string' ? line.trustLevel : null,
            previous_trust_level:
                typeof line.previousTrustLevel === 'string'
                    ? line.previousTrustLevel
                    : null,
            friend_number:
                typeof line.friendNumber === 'string' ? line.friendNumber : null
        }));
        await adapter.bulkInsert(
            `${adapter.userTable(dbVars.userPrefix, 'friend_log_history')}`,
            rows,
            'ignore'
        );
    },

    async getFriendLogHistoryForUserId(userId, types) {
        const table = adapter.userTable(
            dbVars.userPrefix,
            'friend_log_history'
        );
        let rows;
        if (types && types.length > 0) {
            rows = await adapter.selectWhereIn(
                table,
                '*',
                'type',
                types,
                'user_id = @user_id',
                { user_id: userId }
            );
        } else {
            rows = await adapter.selectWhere(table, '*', 'user_id = @user_id', {
                user_id: userId
            });
        }
        return rows.map((dbRow) => {
            const row = {
                rowId: dbRow[0],
                created_at: dbRow[1],
                type: dbRow[2],
                userId: dbRow[3],
                displayName: dbRow[4],
                friendNumber: dbRow[8]
            };
            if (row.type === 'DisplayName') {
                row.previousDisplayName = dbRow[5];
            } else if (row.type === 'TrustLevel') {
                row.trustLevel = dbRow[6];
                row.previousTrustLevel = dbRow[7];
            }
            return row;
        });
    },

    deleteFriendLogHistory(entry) {
        if (entry.rowId != null) {
            adapter.delete(
                `${adapter.userTable(dbVars.userPrefix, 'friend_log_history')}`,
                { id: entry.rowId }
            );
        } else {
            adapter.delete(
                `${adapter.userTable(dbVars.userPrefix, 'friend_log_history')}`,
                {
                    created_at: entry.created_at,
                    type: entry.type,
                    user_id: entry.userId
                }
            );
        }
    }
};

export { friendLogHistory };
