import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { adapter, timers } = vi.hoisted(() => {
    const timers = {
        intervalCb: null,
        intervalDelay: null,
        setInterval: vi.fn((cb, delay) => {
            timers.intervalCb = cb;
            timers.intervalDelay = delay;
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

const originalStorage = globalThis.VRCXStorage;

/** 内存版 VRCXStorage，模拟每机器一份的持久化存储 */
function stubStorage(initial = {}) {
    const store = { ...initial };
    globalThis.VRCXStorage = {
        Get: vi.fn(async (key) => store[key]),
        Set: vi.fn(async (key, value) => {
            store[key] = value;
        })
    };
    return store;
}

/** 模拟一次定时心跳 tick */
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
        stubStorage();
    });

    afterEach(() => {
        nodeRegistry.stopHeartbeat();
        globalThis.VRCXStorage = originalStorage;
        vi.clearAllMocks();
    });

    describe('startHeartbeat', () => {
        test('立即写一拍，然后每 30s 一拍', async () => {
            await nodeRegistry.startHeartbeat('auto');
            await tick();

            expect(adapter.upsertPartial).toHaveBeenCalledTimes(2);
            expect(timers.setInterval).toHaveBeenCalledTimes(1);
            expect(timers.intervalDelay).toBe(30_000);

            const [table, insertData, updateData, conflict] =
                adapter.upsertPartial.mock.calls[0];
            expect(table).toBe('node_registry');
            expect(conflict).toBe('node_id');
            expect(insertData.mode).toBe('auto');
            expect(insertData.prefixes).toBe('');
            expect(typeof insertData.heartbeat_at).toBe('string');
            expect(updateData.mode).toBe('auto');
            expect(insertData.node_id).toBe(nodeRegistry.nodeId);
        });

        test('node_id 跨会话稳定：第二次 start 复用持久化的 id', async () => {
            await nodeRegistry.startHeartbeat('auto');
            const first = nodeRegistry.nodeId;
            expect(first).toBeTruthy();

            // 模拟进程重启：停掉心跳后重新 start
            nodeRegistry.stopHeartbeat();
            await nodeRegistry.startHeartbeat('auto');

            expect(nodeRegistry.nodeId).toBe(first);
        });

        test('首次启动生成 id 并持久化', async () => {
            expect(
                await globalThis.VRCXStorage.Get('VRCX_NodeId')
            ).toBeUndefined();
            await nodeRegistry.startHeartbeat('auto');
            expect(await globalThis.VRCXStorage.Get('VRCX_NodeId')).toBe(
                nodeRegistry.nodeId
            );
        });

        test('存储读取失败时用临时 id，不抛出', async () => {
            globalThis.VRCXStorage = {
                Get: vi.fn(async () => {
                    throw new Error('storage down');
                }),
                Set: vi.fn(async () => {})
            };
            const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            await nodeRegistry.startHeartbeat('auto');

            expect(nodeRegistry.nodeId).toBeTruthy();
            expect(spy).toHaveBeenCalled();
        });

        test('首拍失败仍注册定时器（下一拍重试），错误抛给调用方', async () => {
            adapter.upsertPartial.mockRejectedValue(new Error('db down'));
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(nodeRegistry.startHeartbeat('auto')).rejects.toThrow(
                'db down'
            );
            expect(spy).toHaveBeenCalled();
            // 关键：定时器必须已注册，否则首拍失败后心跳永远不再重试
            expect(timers.setInterval).toHaveBeenCalledTimes(1);

            // 下一拍恢复后正常写入
            adapter.upsertPartial.mockResolvedValue(1);
            await tick();
            expect(adapter.upsertPartial).toHaveBeenCalledTimes(2);
        });

        test('回收只清超过 10 分钟的行，TTL 内的一律保留', async () => {
            await nodeRegistry.startHeartbeat('auto');
            const stale = new Date(Date.now() - 700_000).toISOString(); // 11.6 分钟
            const recent = new Date(Date.now() - 200_000).toISOString(); // 3.3 分钟
            // 清理路径只 select 两列（node_id, heartbeat_at）
            adapter.select.mockResolvedValue([
                ['dead-node', stale],
                ['slow-clock-node', recent]
            ]);

            await tick();

            expect(adapter.delete).toHaveBeenCalledTimes(1);
            expect(adapter.delete).toHaveBeenCalledWith('node_registry', {
                node_id: 'dead-node'
            });
        });
    });

    describe('detectActiveCollectors', () => {
        test('只返回其他节点的、TTL 内的 auto/forced 行', async () => {
            await nodeRegistry.startHeartbeat('auto');
            const own = nodeRegistry.nodeId;
            const fresh = new Date(Date.now() - 1_000).toISOString();
            const stale = new Date(Date.now() - 200_000).toISOString();
            adapter.select.mockResolvedValue([
                [own, 'auto', '', fresh], // 自己 → 排除
                ['peer-a', 'auto', '', fresh], // ✓
                ['peer-b', 'idle', '', fresh], // 未知模式 → 排除
                ['peer-c', 'auto', '', stale], // 过期 → 排除
                ['peer-d', 'forced', '', fresh] // ✓ 显式强制也算候选
            ]);

            const result = await nodeRegistry.detectActiveCollectors();

            expect(result).toEqual([
                { nodeId: 'peer-a', mode: 'auto', heartbeatAt: fresh },
                { nodeId: 'peer-d', mode: 'forced', heartbeatAt: fresh }
            ]);
        });

        test('表缺失时返回 [] 并 warn-once，不抛出', async () => {
            const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            adapter.select.mockRejectedValue(
                new Error("Table 'vrcx.node_registry' doesn't exist")
            );

            await expect(
                nodeRegistry.detectActiveCollectors()
            ).resolves.toEqual([]);
            await expect(
                nodeRegistry.detectActiveCollectors()
            ).resolves.toEqual([]);
            expect(spy).toHaveBeenCalledTimes(1);
        });

        test('其他错误照常抛出', async () => {
            adapter.select.mockRejectedValue(new Error('connection reset'));
            await expect(nodeRegistry.detectActiveCollectors()).rejects.toThrow(
                'connection reset'
            );
        });
    });

    describe('removeOwnRow', () => {
        test('删除本节点行并停掉心跳', async () => {
            await nodeRegistry.startHeartbeat('auto');
            const own = nodeRegistry.nodeId;

            nodeRegistry.removeOwnRow();

            expect(adapter.delete).toHaveBeenCalledWith('node_registry', {
                node_id: own
            });
            expect(timers.clearInterval).toHaveBeenCalled();
            expect(nodeRegistry.nodeId).toBeNull();
        });

        test('未启动时是 no-op', () => {
            nodeRegistry.removeOwnRow();
            expect(adapter.delete).not.toHaveBeenCalled();
        });
    });
});
