import { ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';

import { database, dbVars } from '../services/database';
import { adapter } from '../services/database/adapter/index.js';
import { useFriendStore } from './friend';
import { useVrcxStore } from './vrcx';
import { watchState } from '../services/watchState';
import { accountHub } from '../services/accountHub.js';
import { lookupAggregatedFeed } from '../services/aggregatedView.js';

import configRepository from '../services/config';

export const useFeedStore = defineStore('Feed', () => {
    const friendStore = useFriendStore();
    const vrcxStore = useVrcxStore();

    const feedTableData = shallowRef([]);
    const feedTable = ref({
        search: '',
        dateFrom: '',
        dateTo: '',
        vip: false,
        loading: false,
        filter: [],
        pageSize: 20,
        pageSizeLinked: true
    });

    // ── 跨客户端/外部写同步（onTableChange）────────────────────────────
    // 另一个客户端写同一数据库时，本进程不会感知。这里订阅 feed 各物理表的
    // onTableChange（外部写者检测：SQLite data_version / PG xact_commit /
    // MySQL 计数器轮询 + C# 写漏斗），收到变更后静默重查，让外部写入的 feed
    // 显示在本客户端。事件是失效提示（不带行数据），收到即重查即可。
    const FEED_CHANGE_TABLES = [
        'feed_gps',
        'feed_status',
        'feed_bio',
        'feed_avatar',
        'feed_online_offline'
    ];
    /** @type {Array<() => void>} 当前已订阅的退订函数 */
    let feedChangeUnsubs = [];
    let feedReloadScheduled = false;

    function scheduleFeedReload() {
        if (feedReloadScheduled) return;
        feedReloadScheduled = true;
        setTimeout(() => {
            feedReloadScheduled = false;
            feedTableLookup({ silent: true });
        }, 1000);
    }

    /**
     * 订阅/重建外部写监听。未登录或无可订阅前缀时仅清理旧订阅。
     * 合并视图订阅所有账号前缀，单账号订阅当前前缀。
     */
    function subscribeFeedExternalSync() {
        for (const unsub of feedChangeUnsubs) unsub();
        feedChangeUnsubs = [];
        if (!watchState.isLoggedIn) return;
        let prefixes = [];
        if (
            accountHub.isMergedView &&
            accountHub.allUserPrefixes.length > 1
        ) {
            prefixes = accountHub.allUserPrefixes;
        } else if (dbVars.userPrefix) {
            prefixes = [dbVars.userPrefix];
        }
        for (const prefix of prefixes) {
            for (const tableName of FEED_CHANGE_TABLES) {
                const table = adapter.userTable(prefix, tableName);
                try {
                    feedChangeUnsubs.push(
                        adapter.onTableChange(table, () =>
                            scheduleFeedReload()
                        )
                    );
                } catch (err) {
                    console.error(
                        '[feed] onTableChange subscribe failed',
                        table,
                        err
                    );
                }
            }
        }
    }

    watch(
        () => watchState.isLoggedIn,
        (isLoggedIn) => {
            feedTableData.value = [];
            subscribeFeedExternalSync();
            if (isLoggedIn) {
                initFeedTable();
            }
        },
        { flush: 'sync' }
    );

    watch(
        () => accountHub.viewMode,
        () => {
            if (watchState.isLoggedIn) {
                feedTableData.value = [];
                subscribeFeedExternalSync();
                initFeedTable();
            }
        }
    );

    watch(
        () => watchState.isFavoritesLoaded,
        (isFavoritesLoaded) => {
            if (isFavoritesLoaded && feedTable.value.vip) {
                feedTableLookup(); // re-apply VIP filter after friends are loaded
            }
        }
    );

    async function init() {
        feedTable.value.filter = JSON.parse(
            await configRepository.getString('VRCX_feedTableFilters', '[]')
        );
        feedTable.value.vip = await configRepository.getBool(
            'VRCX_feedTableVIPFilter',
            false
        );
    }

    init();

    function feedSearch(row) {
        const value = feedTable.value.search.trim().toUpperCase();
        if (!value) {
            return true;
        }
        if (
            (value.startsWith('wrld_') || value.startsWith('grp_')) &&
            String(row.location).toUpperCase().includes(value)
        ) {
            return true;
        }
        switch (row.type) {
            case 'GPS':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Online':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Offline':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Status':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.status).toUpperCase().includes(value)) {
                    return true;
                }
                if (
                    String(row.statusDescription).toUpperCase().includes(value)
                ) {
                    return true;
                }
                return false;
            case 'Avatar':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.avatarName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Bio':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.bio).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.previousBio).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
        }
        return true;
    }

    async function feedTableLookup(options = {}) {
        const { silent = false } = options;
        await configRepository.setString(
            'VRCX_feedTableFilters',
            JSON.stringify(feedTable.value.filter)
        );
        await configRepository.setBool(
            'VRCX_feedTableVIPFilter',
            feedTable.value.vip
        );
        if (!silent) feedTable.value.loading = true;
        try {
            let vipList = [];
            if (feedTable.value.vip) {
                vipList = Array.from(friendStore.localFavoriteFriends.values());
            }
            const search = feedTable.value.search.trim();
            const { dateFrom, dateTo } = feedTable.value;

            let rows;
            if (accountHub.isMergedView && accountHub.allUserPrefixes.length > 1) {
                // Merged mode: aggregate across all account prefixes
                rows = await lookupAggregatedFeed(
                    accountHub.allUserPrefixes,
                    feedTable.value.filter,
                    vrcxStore.maxTableSize
                );
            } else {
                rows =
                    search || dateFrom || dateTo
                        ? await database.searchFeedDatabase(
                              search,
                              feedTable.value.filter,
                              vipList,
                              vrcxStore.searchLimit,
                              dateFrom,
                              dateTo
                          )
                        : await database.lookupFeedDatabase(
                              feedTable.value.filter,
                              vipList
                          );
            }
            feedTableData.value = [];
            feedTableData.value = [...feedTableData.value, ...rows];
        } finally {
            if (!silent) feedTable.value.loading = false;
        }
    }

    /**
     * Appends a feed entry to the local table if it passes filters.
     * Does NOT trigger notifications or shared feed — that is the caller's responsibility.
     * @param {object} feed The feed entry to add.
     */
    function addFeedEntry(feed) {
        if (
            feedTable.value.filter.length > 0 &&
            !feedTable.value.filter.includes(feed.type)
        ) {
            return;
        }
        if (
            feedTable.value.vip &&
            !friendStore.localFavoriteFriends.has(feed.userId)
        ) {
            return;
        }
        if (!feedSearch(feed)) {
            return;
        }
        if (
            feedTable.value.dateFrom &&
            feed.created_at < feedTable.value.dateFrom
        ) {
            return;
        }
        if (
            feedTable.value.dateTo &&
            feed.created_at > feedTable.value.dateTo
        ) {
            return;
        }
        feedTableData.value = [feed, ...feedTableData.value];
        sweepFeed();
    }

    function sweepFeed() {
        const j = feedTableData.value.length;
        if (j > vrcxStore.maxTableSize + 50) {
            feedTableData.value = feedTableData.value.slice(0, -50);
        }
    }

    async function initFeedTable() {
        feedTable.value.loading = true;
        await feedTableLookup();
        feedTable.value.loading = false;
    }

    return {
        feedTable,
        feedTableData,
        initFeedTable,
        feedTableLookup,
        addFeedEntry
    };
});
