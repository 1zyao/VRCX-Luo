import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../index.js', () => ({
    dbVars: {
        maxTableSize: 500,
        userPrefix: 'usr_test'
    }
}));

import { feed } from '../feed.js';
import { dedupInsert, hasRecentDuplicate } from '../feed.js';
import { adapter } from '../adapter/index.js';

// ── PG strict GROUP BY compliance ────────────────────────────────────
//
// PostgreSQL (unlike SQLite/MySQL) requires every non-aggregated SELECT
// column to appear in GROUP BY. These tests pin the spec emitted by each
// grouped query: bare non-grouped columns must be wrapped in aggregates.

describe('feed strict GROUP BY compliance', () => {
    let groupByMock;

    beforeEach(() => {
        groupByMock = vi
            .spyOn(adapter, 'selectGroupBy')
            .mockResolvedValue([]);
    });

    afterEach(() => {
        groupByMock.mockRestore();
    });

    test('getHotWorlds: world_name aggregated, not bare', async () => {
        await feed.getHotWorlds(30, 30);
        const spec = groupByMock.mock.calls[0][1];
        expect(spec.groupBy).toEqual(['world_id']);
        expect(spec.columns).toEqual([
            `${adapter.sqlExtractWorldId('location')} AS world_id`
        ]);
        expect(spec.aggregates).toContainEqual({
            expr: 'MAX(world_name)',
            alias: 'world_name'
        });
    });

    test('getHotWorldFriendDetail: display_name aggregated, not bare', async () => {
        await feed.getHotWorldFriendDetail('wrld_x', 30);
        const spec = groupByMock.mock.calls[0][1];
        expect(spec.groupBy).toEqual(['user_id']);
        expect(spec.columns).toEqual(['user_id']);
        expect(spec.aggregates).toContainEqual({
            expr: 'MAX(display_name)',
            alias: 'display_name'
        });
    });
});

// ── UNION ALL column type consistency ───────────────────────────────
//
// PostgreSQL rejects `UNION ALL` branches whose corresponding columns
// differ in type (42804). The `time` position is an integer column in
// feed_gps / feed_online_offline, so the NULL-padded branches must cast
// to BIGINT — not TEXT (the generic null helper used elsewhere).

describe('feed UNION ALL column type consistency', () => {
    let unionMock;

    beforeEach(() => {
        unionMock = vi.spyOn(adapter, 'selectUnion').mockResolvedValue([]);
    });

    afterEach(() => {
        unionMock.mockRestore();
    });

    test('time null-pads use BIGINT cast matching the real integer columns', async () => {
        await feed.lookupFeedDatabase([], [], 25);
        const sources = unionMock.mock.calls[0][0];
        // All 5 feed sources: GPS, Status, Bio, Avatar, Online/Offline.
        expect(sources).toHaveLength(5);
        // Position 8 is `time` in the 22-column shared schema.
        const timeExpr = (cols) => cols[8];
        expect(timeExpr(sources[0].columns)).toBe('time'); // GPS real column
        expect(timeExpr(sources[1].columns)).toBe(
            'CAST(NULL AS BIGINT) AS time' // Status
        );
        expect(timeExpr(sources[2].columns)).toBe(
            'CAST(NULL AS BIGINT) AS time' // Bio
        );
        expect(timeExpr(sources[3].columns)).toBe(
            'CAST(NULL AS BIGINT) AS time' // Avatar
        );
        expect(timeExpr(sources[4].columns)).toBe('time'); // Online/Offline
    });

    test('text null-pads for text columns still use TEXT cast', async () => {
        await feed.lookupFeedDatabase([], [], 25);
        const sources = unionMock.mock.calls[0][0];
        // Position 5 is `location` — a TEXT column in every engine.
        expect(sources[1].columns[5]).toBe('CAST(NULL AS TEXT) AS location');
    });
});

// ── addOnlineOfflineToDatabase time normalization ────────────────────
//
// Online events carry no duration; callers pass `time: ''`. PG rejects
// a text empty string into its BIGINT column (42804), while SQLite's
// dynamic typing and MySQL's lenient coercion silently accept it.
// Normalizing '' → NULL keeps every engine happy.

describe('feed.addOnlineOfflineToDatabase time normalization', () => {
    let insertMock;
    let selectWhereMock;

    beforeEach(() => {
        insertMock = vi.spyOn(adapter, 'insert').mockResolvedValue(1);
        // 去重预检：默认无重复 → 走正常插入
        selectWhereMock = vi
            .spyOn(adapter, 'selectWhere')
            .mockResolvedValue([]);
    });

    afterEach(() => {
        insertMock.mockRestore();
        selectWhereMock.mockRestore();
    });

    test('empty-string time is normalized to null', async () => {
        await feed.addOnlineOfflineToDatabase({
            created_at: '2026-07-31T00:00:00Z',
            userId: 'usr_a',
            displayName: 'Alice',
            type: 'Online',
            location: 'wrld_x:1',
            worldName: 'World X',
            groupName: '',
            time: ''
        });
        expect(insertMock).toHaveBeenCalledTimes(1);
        const data = insertMock.mock.calls[0][1];
        expect(data.time).toBeNull();
        expect(data.type).toBe('Online');
    });

    test('numeric time passes through unchanged', async () => {
        await feed.addOnlineOfflineToDatabase({
            created_at: '2026-07-31T00:00:00Z',
            userId: 'usr_a',
            displayName: 'Alice',
            type: 'Offline',
            location: 'wrld_x:1',
            worldName: 'World X',
            groupName: '',
            time: 3600000
        });
        expect(insertMock.mock.calls[0][1].time).toBe(3600000);
    });
});

// ── 跨客户端去重（dedupInsert / hasRecentDuplicate）──────────────────
//
// 两个 VRCX 客户端连同一数据库时，同一事件会被各自写一行（created_at 是本地
// 检测时间，相差几十秒）。写入前预检"窗口内是否存在除 created_at/time 外完全
// 一致的行"，命中则跳过写入。

describe('feed.hasRecentDuplicate (SQLite path)', () => {
    let selectWhereMock;

    beforeEach(() => {
        selectWhereMock = vi.spyOn(adapter, 'selectWhere');
    });

    afterEach(() => {
        selectWhereMock.mockRestore();
    });

    test('窗口内无相同内容 → 返回 false', async () => {
        selectWhereMock.mockResolvedValue([]);
        const dup = await hasRecentDuplicate('usr_test_feed_gps', {
            created_at: '2026-07-31T00:00:00Z',
            user_id: 'usr_a',
            display_name: 'Alice',
            location: 'wrld_x:1',
            world_name: 'World X',
            previous_location: 'wrld_y:1',
            time: 123,
            group_name: ''
        });
        expect(dup).toBe(false);
    });

    test('窗口内已有相同内容 → 返回 true', async () => {
        selectWhereMock.mockResolvedValue([[1]]);
        const dup = await hasRecentDuplicate('usr_test_feed_gps', {
            created_at: '2026-07-31T00:00:00Z',
            user_id: 'usr_a',
            display_name: 'Alice',
            location: 'wrld_x:1',
            world_name: 'World X',
            previous_location: 'wrld_y:1',
            time: 123,
            group_name: ''
        });
        expect(dup).toBe(true);
    });

    test('预检条件排除 created_at 与 time（本地检测时间可不同）', async () => {
        selectWhereMock.mockResolvedValue([]);
        await hasRecentDuplicate('usr_test_feed_gps', {
            created_at: '2026-07-31T00:00:00Z',
            user_id: 'usr_a',
            display_name: 'Alice',
            location: 'wrld_x:1',
            time: 999
        });
        const [whereClause, params] = selectWhereMock.mock.calls[0].slice(2);
        expect(whereClause).not.toContain('created_at =');
        expect(whereClause).not.toContain('time =');
        expect(whereClause).toContain('created_at >= @__cutoff');
        expect(params).toHaveProperty('__cutoff');
        expect(params).toHaveProperty('user_id', 'usr_a');
    });
});

describe('feed.dedupInsert', () => {
    let insertMock;
    let selectWhereMock;

    beforeEach(() => {
        insertMock = vi.spyOn(adapter, 'insert').mockResolvedValue(1);
        selectWhereMock = vi.spyOn(adapter, 'selectWhere');
    });

    afterEach(() => {
        insertMock.mockRestore();
        selectWhereMock.mockRestore();
    });

    test('无重复 → 正常插入一次', async () => {
        selectWhereMock.mockResolvedValue([]);
        await dedupInsert('usr_test_feed_gps', {
            created_at: '2026-07-31T00:00:00Z',
            user_id: 'usr_a',
            display_name: 'Alice',
            location: 'wrld_x:1'
        });
        expect(insertMock).toHaveBeenCalledTimes(1);
    });

    test('窗口内已有相同内容 → 跳过插入（防双客户端双写）', async () => {
        selectWhereMock.mockResolvedValue([[1]]);
        await dedupInsert('usr_test_feed_gps', {
            created_at: '2026-07-31T00:00:00Z',
            user_id: 'usr_a',
            display_name: 'Alice',
            location: 'wrld_x:1'
        });
        expect(insertMock).not.toHaveBeenCalled();
    });

    test('fail-open：预检异常时回退直接插入，绝不丢事件', async () => {
        selectWhereMock.mockRejectedValue(new Error('db locked'));
        await dedupInsert('usr_test_feed_gps', {
            created_at: '2026-07-31T00:00:00Z',
            user_id: 'usr_a',
            display_name: 'Alice',
            location: 'wrld_x:1'
        });
        expect(insertMock).toHaveBeenCalledTimes(1);
    });
});
