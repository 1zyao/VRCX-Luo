/**
 * ConfigRepository 大值写入列升级测试（MySQL Data too long 修复）。
 *
 * 当写入 configs 的 value 超过安全阈值(≈64KB TEXT 上限)时,setString 应
 * 惰性触发 `adapter.initValueColumnsLongText?.()` 把列升级为 LONGTEXT,
 * 再执行 insert;小值不触发;SQLite/PG 无此方法(文本列无界)防御式跳过。
 *
 * The adapter singleton is mocked — only insert / initValueColumnsLongText
 * are exercised here.
 */

import { describe, expect, test, vi } from 'vitest';

const { adapterMock } = vi.hoisted(() => ({
    adapterMock: { insert: vi.fn() }
}));

vi.mock('../adapter/index.js', () => ({ adapter: adapterMock }));

import { ConfigRepository } from '../configRepository.js';

describe('configRepository 大值写入触发列升级（MySQL Data too long 修复）', () => {
    beforeEach(() => {
        adapterMock.insert.mockReset();
        delete adapterMock.initValueColumnsLongText;
    });

    test('setString 写入超过 60KB → 先调 initValueColumnsLongText 再 insert', async () => {
        adapterMock.insert = vi.fn().mockResolvedValue(0);
        adapterMock.initValueColumnsLongText = vi.fn().mockResolvedValue();
        const repo = new ConfigRepository();
        const big = 'x'.repeat(61000);
        await repo.setString('big.key', big);
        expect(adapterMock.initValueColumnsLongText).toHaveBeenCalledTimes(1);
        expect(adapterMock.insert).toHaveBeenCalledWith(
            'configs',
            { key: 'config:big.key', value: big },
            'replace'
        );
    });

    test('setString 小值不触发列升级（避免逐写探测开销）', async () => {
        adapterMock.insert = vi.fn().mockResolvedValue(0);
        adapterMock.initValueColumnsLongText = vi.fn().mockResolvedValue();
        const repo = new ConfigRepository();
        await repo.setString('small.key', 'hi');
        expect(adapterMock.initValueColumnsLongText).not.toHaveBeenCalled();
        expect(adapterMock.insert).toHaveBeenCalledTimes(1);
    });

    test('引擎无 initValueColumnsLongText（SQLite/PG）→ 防御式跳过', async () => {
        adapterMock.insert = vi.fn().mockResolvedValue(0);
        const repo = new ConfigRepository();
        const big = 'x'.repeat(61000);
        await expect(repo.setString('big.key', big)).resolves.toBeUndefined();
        expect(adapterMock.insert).toHaveBeenCalledTimes(1);
    });
});
