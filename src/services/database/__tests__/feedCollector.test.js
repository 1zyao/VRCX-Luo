import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../nodeRegistry.js', () => ({
    nodeRegistry: {
        nodeId: 'own-node',
        startHeartbeat: vi.fn(),
        stopHeartbeat: vi.fn(),
        removeOwnRow: vi.fn(),
        detectActiveCollectors: vi.fn()
    }
}));

const originalStorage = globalThis.VRCXStorage;

/** @type {typeof import('../feedCollector.js')} */
let feedCollector;
/** @type {{nodeId: string, startHeartbeat: any, removeOwnRow: any, detectActiveCollectors: any}} */
let nodeRegistry;

function stubStorage(raw) {
    globalThis.VRCXStorage = { Get: vi.fn(async () => raw) };
}

/** 造一个活跃候选心跳行 */
function peer(nodeId, mode = 'auto') {
    return {
        nodeId,
        mode,
        heartbeatAt: new Date().toISOString()
    };
}

describe('feedCollector', () => {
    beforeEach(async () => {
        vi.resetModules();
        ({ nodeRegistry } = await import('../nodeRegistry.js'));
        feedCollector = await import('../feedCollector.js');
        // 显式重设实现：vi.resetModules() 不保证 mock 工厂重跑，
        // 上一个用例的 mockRejectedValue 会泄漏到下一个用例。
        nodeRegistry.nodeId = 'own-node';
        nodeRegistry.startHeartbeat.mockReset().mockResolvedValue(undefined);
        nodeRegistry.removeOwnRow.mockReset();
        nodeRegistry.detectActiveCollectors.mockReset().mockResolvedValue([]);
    });

    afterEach(() => {
        feedCollector.stopFeedCollector();
        globalThis.VRCXStorage = originalStorage;
        vi.restoreAllMocks();
    });

    // 必须第一个跑：之后用例会把模块内状态改掉。
    test('未调用 init 时默认归 collector', () => {
        expect(feedCollector.isFeedCollector()).toBe(true);
    });

    test.each([
        ['', true],
        ['garbage', true],
        ['true', true],
        ['TRUE', true],
        [' true ', true],
        ['1', true],
        ['yes', true],
        ['false', false],
        ['FALSE', false],
        [' false ', false],
        ['0', false],
        ['no', false]
    ])(
        'VRCX_FeedCollector=%p → 自动模式下 isFeedCollector()=%s',
        async (raw, expected) => {
            stubStorage(raw);
            await feedCollector.initFeedCollector();
            expect(feedCollector.isFeedCollector()).toBe(expected);
        }
    );

    test('缺省（键不存在）时归 collector', async () => {
        stubStorage(undefined);
        await feedCollector.initFeedCollector();
        expect(feedCollector.isFeedCollector()).toBe(true);
    });

    test('读取异常时 fail-safe 归 collector，不静默停采集', async () => {
        globalThis.VRCXStorage = {
            Get: vi.fn(async () => {
                throw new Error('storage down');
            })
        };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await feedCollector.initFeedCollector();

        expect(feedCollector.isFeedCollector()).toBe(true);
        expect(spy).toHaveBeenCalled();
    });

    test('显式 false：不写心跳、不探测、不采集', async () => {
        stubStorage('false');
        await feedCollector.initFeedCollector();

        expect(feedCollector.isFeedCollector()).toBe(false);
        expect(nodeRegistry.startHeartbeat).not.toHaveBeenCalled();
        expect(nodeRegistry.detectActiveCollectors).not.toHaveBeenCalled();
    });

    test('显式 true：以 forced 身份登记，不探测（强制采集）', async () => {
        stubStorage('true');
        await feedCollector.initFeedCollector();

        expect(nodeRegistry.startHeartbeat).toHaveBeenCalledWith('forced');
        expect(nodeRegistry.detectActiveCollectors).not.toHaveBeenCalled();
        expect(feedCollector.isFeedCollector()).toBe(true);
    });

    test('显式 true 时 refreshPeerState 不改判定（不参与选举）', async () => {
        stubStorage('true');
        await feedCollector.initFeedCollector();

        nodeRegistry.detectActiveCollectors.mockResolvedValue([peer('aaa')]);
        await feedCollector.refreshPeerState();

        expect(feedCollector.isFeedCollector()).toBe(true);
        expect(nodeRegistry.detectActiveCollectors).not.toHaveBeenCalled();
    });

    test('自动模式 + 无对端 → 采集，身份 auto', async () => {
        stubStorage(undefined);
        await feedCollector.initFeedCollector();

        expect(nodeRegistry.startHeartbeat).toHaveBeenCalledWith('auto');
        expect(feedCollector.isFeedCollector()).toBe(true);
    });

    test('自动模式 + auto 对端 node_id 更小 → 让位', async () => {
        stubStorage(undefined);
        nodeRegistry.nodeId = 'zzz';
        nodeRegistry.detectActiveCollectors.mockResolvedValue([peer('aaa')]);

        await feedCollector.initFeedCollector();

        expect(feedCollector.isFeedCollector()).toBe(false);
    });

    test('自动模式 + auto 对端 node_id 更大 → 本节点保持采集（平局裁决）', async () => {
        stubStorage(undefined);
        nodeRegistry.nodeId = 'aaa';
        nodeRegistry.detectActiveCollectors.mockResolvedValue([peer('zzz')]);

        await feedCollector.initFeedCollector();

        expect(feedCollector.isFeedCollector()).toBe(true);
    });

    test('自动模式 + forced 对端（node_id 更大）→ 无条件让位', async () => {
        stubStorage(undefined);
        nodeRegistry.nodeId = 'aaa';
        nodeRegistry.detectActiveCollectors.mockResolvedValue([
            peer('zzz', 'forced')
        ]);

        await feedCollector.initFeedCollector();

        expect(feedCollector.isFeedCollector()).toBe(false);
    });

    test('对端失活后自动接管（refreshPeerState 翻转判定）', async () => {
        stubStorage(undefined);
        nodeRegistry.nodeId = 'zzz';
        nodeRegistry.detectActiveCollectors.mockResolvedValue([peer('aaa')]);
        await feedCollector.initFeedCollector();
        expect(feedCollector.isFeedCollector()).toBe(false);

        // 对端心跳过期被 detectActiveCollectors 过滤掉 → 空数组
        nodeRegistry.detectActiveCollectors.mockResolvedValue([]);
        await feedCollector.refreshPeerState();

        expect(feedCollector.isFeedCollector()).toBe(true);
    });

    test('探测抛错时保持上一次判定，不停采', async () => {
        stubStorage(undefined);
        await feedCollector.initFeedCollector();
        expect(feedCollector.isFeedCollector()).toBe(true);

        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        nodeRegistry.detectActiveCollectors.mockRejectedValue(
            new Error('db down')
        );
        await feedCollector.refreshPeerState();

        expect(feedCollector.isFeedCollector()).toBe(true);
        expect(spy).toHaveBeenCalled();
    });

    test('心跳登记失败时仍按当前判定采集，且照常启动探测', async () => {
        stubStorage(undefined);
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        nodeRegistry.startHeartbeat.mockRejectedValue(new Error('db down'));

        await feedCollector.initFeedCollector();

        expect(feedCollector.isFeedCollector()).toBe(true);
        expect(spy).toHaveBeenCalled();
        // 一次心跳抖动不能永久放弃自动接管：探测照跑
        expect(nodeRegistry.detectActiveCollectors).toHaveBeenCalled();
    });

    test('stopFeedCollector 注销本节点心跳行并重置判定', async () => {
        stubStorage('true');
        await feedCollector.initFeedCollector();

        feedCollector.stopFeedCollector();

        expect(nodeRegistry.removeOwnRow).toHaveBeenCalled();
        // 重置后回到「无对端则采集」的初始判定
        expect(feedCollector.isFeedCollector()).toBe(true);
    });

    test('重复 init 是安全的（不泄漏定时器 / 不残留上次判定）', async () => {
        stubStorage(undefined);
        nodeRegistry.nodeId = 'zzz';
        nodeRegistry.detectActiveCollectors.mockResolvedValue([peer('aaa')]);
        await feedCollector.initFeedCollector();
        expect(feedCollector.isFeedCollector()).toBe(false);

        // 第二次 init：无对端 → 应恢复采集
        nodeRegistry.detectActiveCollectors.mockResolvedValue([]);
        await feedCollector.initFeedCollector();

        expect(feedCollector.isFeedCollector()).toBe(true);
    });
});
