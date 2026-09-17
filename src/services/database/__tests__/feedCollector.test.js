import { afterEach, describe, expect, test, vi } from 'vitest';

import { initFeedCollector, isFeedCollector } from '../feedCollector.js';

const originalStorage = globalThis.VRCXStorage;

function stubStorage(raw) {
    globalThis.VRCXStorage = { Get: vi.fn(async () => raw) };
}

describe('feedCollector', () => {
    afterEach(() => {
        globalThis.VRCXStorage = originalStorage;
        vi.restoreAllMocks();
    });

    // 必须第一个跑：之后用例会把模块内的 enabled 改掉。
    test('未调用 init 时默认归 collector', () => {
        expect(isFeedCollector()).toBe(true);
    });

    test.each([
        ['', true],
        ['true', true],
        ['TRUE', true],
        [' true ', true],
        ['garbage', true],
        ['false', false],
        ['FALSE', false],
        [' false ', false],
        ['0', false],
        ['no', false]
    ])(
        'VRCX_FeedCollector=%p → isFeedCollector()=%s',
        async (raw, expected) => {
            stubStorage(raw);
            await initFeedCollector();
            expect(isFeedCollector()).toBe(expected);
        }
    );

    test('缺省（键不存在）时归 collector', async () => {
        stubStorage(undefined);
        await initFeedCollector();
        expect(isFeedCollector()).toBe(true);
    });

    test('读取异常时 fail-safe 归 collector，不静默停采集', async () => {
        globalThis.VRCXStorage = {
            Get: vi.fn(async () => {
                throw new Error('storage down');
            })
        };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await initFeedCollector();

        expect(isFeedCollector()).toBe(true);
        expect(spy).toHaveBeenCalled();
    });
});
