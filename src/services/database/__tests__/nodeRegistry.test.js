import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { adapter, timers } = vi.hoisted(() => {
    const timers = {
        intervalCb: null,
        setInterval: vi.fn((cb) => {
            timers.intervalCb = cb;
            return 1;
        }),
        clearInterval: vi.fn(() => {
            timers.intervalCb = null;
        })
    };
    return {
        adapter: {
            upsertPartial: vi.fn(),
            select: vi.fn(),
            delete: vi.fn()
        },
        timers
    };
});

vi.mock('../adapter/index.js', () => ({ adapter }));
vi.mock('worker-timers', () => ({
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
}));

import { nodeRegistry } from '../nodeRegistry.js';

/** 模拟一次定时心跳 tick。 */
async function tick() {
    if (!timers.intervalCb) return;
    await timers.intervalCb();
}

describe('nodeRegistry', () => {
    beforeEach(() => {
        timers.intervalCb = null;
        adapter.upsertPartial.mockResolvedValue(1);
        adapter.select.mockResolvedValue([]);
        adapter.delete.mockResolvedValue(1);
    });

    afterEach(() => {
        nodeRegistry.stopHeartbeat();
        vi.clearAllMocks();
    });

    describe('startHeartbeat', () => {
        test('heartbeats immediately then every 30s with correct upsert shape', async () => {
            await nodeRegistry.startHeartbeat('collector');
            nodeRegistry.setOwnPrefixes(['userA1', 'userB2']);
            await tick();

            expect(adapter.upsertPartial).toHaveBeenCalledTimes(2);
            expect(timers.setInterval).toHaveBeenCalledTimes(1);
            const [table, insertData, updateData, conflictColumn] =
                adapter.upsertPartial.mock.calls[1];
            expect(table).toBe('node_registry');
            expect(conflictColumn).toBe('node_id');
            expect(insertData.node_id).toBe(nodeRegistry.nodeId);
            expect(insertData.mode).toBe('collector');
            expect(insertData.prefixes).toBe('userA1,userB2');
            expect(insertData.heartbeat_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(updateData).toEqual({
                mode: insertData.mode,
                prefixes: insertData.prefixes,
                heartbeat_at: insertData.heartbeat_at
            });
        });

        test('empty prefixes still heartbeat', async () => {
            await nodeRegistry.startHeartbeat('collector');
            expect(adapter.upsertPartial.mock.calls[0][1].prefixes).toBe('');
        });

        test('startHeartbeat is idempotent across calls (single timer)', async () => {
            await nodeRegistry.startHeartbeat('collector');
            const firstId = nodeRegistry.nodeId;
            await nodeRegistry.startHeartbeat('collector');
            // restart replaces node id but keeps a single active interval
            expect(nodeRegistry.nodeId).not.toBe(firstId);
            expect(timers.intervalCb).not.toBeNull();
            await tick();
            expect(adapter.upsertPartial).toHaveBeenCalledTimes(3);
        });

        test('stopHeartbeat clears the timer', async () => {
            await nodeRegistry.startHeartbeat('collector');
            nodeRegistry.stopHeartbeat();
            expect(timers.clearInterval).toHaveBeenCalledTimes(1);
            await tick();
            expect(adapter.upsertPartial).toHaveBeenCalledTimes(1);
        });
    });

    describe('detectActiveCollectors', () => {
        const row = (nodeId, mode, prefixes, heartbeatAt) => [
            nodeId,
            mode,
            prefixes,
            heartbeatAt
        ];
        const recentIso = (msAgo = 0) =>
            new Date(Date.now() - msAgo).toISOString();

        test('returns only other active collectors within TTL', async () => {
            const rowA = row('a', 'collector', 'p1', recentIso(10_000));
            adapter.select.mockResolvedValue([
                rowA,
                row('b', 'browse', '', recentIso(10_000)),
                row('c', 'collector', 'p3', recentIso(200_000)),
                row('d', 'collector', 'p4', recentIso())
            ]);
            const result = await nodeRegistry.detectActiveCollectors();
            expect(result.map((r) => r.nodeId)).toEqual(['a', 'd']);
            expect(result[0]).toEqual({
                nodeId: 'a',
                mode: 'collector',
                prefixes: 'p1',
                heartbeatAt: rowA[3]
            });
        });

        test('TTL boundary: just inside 120s is active, older than 120s is stale', async () => {
            adapter.select.mockResolvedValue([
                row('stale', 'collector', '', recentIso(120_001)),
                row('fresh', 'collector', '', recentIso(119_999))
            ]);
            const result = await nodeRegistry.detectActiveCollectors();
            expect(result.map((r) => r.nodeId)).toEqual(['fresh']);
        });

        test('excludes own node id', async () => {
            await nodeRegistry.startHeartbeat('collector');
            const me = nodeRegistry.nodeId;
            adapter.select.mockResolvedValue([
                row(me, 'collector', '', recentIso()),
                row('other', 'collector', '', recentIso())
            ]);
            const result = await nodeRegistry.detectActiveCollectors();
            expect(result.map((r) => r.nodeId)).toEqual(['other']);
        });

        test('missing table (any dialect) returns [] and warns once total', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const messages = [
                'no such table: node_registry',
                "Table 'vrcx.node_registry' doesn't exist",
                'relation "node_registry" does not exist'
            ];
            for (const msg of messages) {
                adapter.select.mockRejectedValue(new Error(msg));
                await expect(
                    nodeRegistry.detectActiveCollectors()
                ).resolves.toEqual([]);
            }
            expect(warn).toHaveBeenCalledTimes(1);
            warn.mockRestore();
        });

        test('other errors rethrow', async () => {
            adapter.select.mockRejectedValue(new Error('connection refused'));
            await expect(nodeRegistry.detectActiveCollectors()).rejects.toThrow(
                'connection refused'
            );
        });
    });

    describe('beat cleanup', () => {
        test('deletes stale rows, keeps fresh rows, swallows cleanup errors', async () => {
            await nodeRegistry.startHeartbeat('collector');
            adapter.select.mockResolvedValue([
                ['stale1', new Date(Date.now() - 200_000).toISOString()],
                ['fresh', new Date(Date.now() - 1_000).toISOString()]
            ]);
            await tick();

            expect(adapter.select).toHaveBeenCalledWith('node_registry', [
                'node_id',
                'heartbeat_at'
            ]);
            expect(adapter.delete).toHaveBeenCalledWith('node_registry', {
                node_id: 'stale1'
            });
            expect(adapter.delete).not.toHaveBeenCalledWith('node_registry', {
                node_id: 'fresh'
            });

            // cleanup failure is swallowed
            adapter.select.mockRejectedValue(new Error('boom'));
            await expect(tick()).resolves.toBeUndefined();
        });
    });

    describe('removeOwnRow', () => {
        test('deletes own row then stops heartbeat', async () => {
            await nodeRegistry.startHeartbeat('collector');
            const me = nodeRegistry.nodeId;
            nodeRegistry.removeOwnRow();
            expect(adapter.delete).toHaveBeenCalledWith('node_registry', {
                node_id: me
            });
            await tick();
            expect(adapter.upsertPartial).toHaveBeenCalledTimes(1);
            expect(nodeRegistry.nodeId).toBeNull();
        });
    });
});
