/**
 * ConfigRepository degrade-read tests (browse-mode M1, MEDIUM-4 / M8).
 *
 * When the `configs` table is missing (browse + uninitialized database),
 * reads degrade to the default value with a once-per-process warn instead
 * of throwing. All other errors keep the original rethrow behaviour, and a
 * present table behaves exactly as before.
 *
 * The adapter singleton is mocked — only `selectOne` is exercised here.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { adapterMock } = vi.hoisted(() => ({
    adapterMock: { selectOne: vi.fn() }
}));

vi.mock('../adapter/index.js', () => ({ adapter: adapterMock }));

import { ConfigRepository } from '../configRepository.js';

let repo;

beforeEach(() => {
    adapterMock.selectOne.mockReset();
    repo = new ConfigRepository();
});

afterEach(() => {
    repo = undefined;
});

describe('configRepository degrade reads (missing configs table)', () => {
    test('"no such table" → getString returns the default value', async () => {
        adapterMock.selectOne.mockRejectedValue(
            new Error('no such table: configs')
        );
        await expect(repo.getString('browse.mode', 'collector')).resolves.toBe(
            'collector'
        );
    });

    test('"does not exist" (PG-style) → getString returns the default value', async () => {
        adapterMock.selectOne.mockRejectedValue(
            new Error('relation "configs" does not exist')
        );
        await expect(repo.getString('k', 'd')).resolves.toBe('d');
    });

    test('"doesn\'t exist" (MySQL-style) → default value + warn-once', async () => {
        // Fresh module instance so the once-per-process warn guard is reset.
        vi.resetModules();
        const { ConfigRepository: FreshRepo } =
            await import('../configRepository.js');
        const fresh = new FreshRepo();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // MySqlConnector 消息变体 (MEDIUM-2): Table 'db.configs' doesn't exist
        adapterMock.selectOne.mockRejectedValue(
            new Error("Table 'db.configs' doesn't exist")
        );
        await expect(fresh.getString('k', 'd')).resolves.toBe('d');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
            '[browse] configs 表不存在，读取降级为默认值: k'
        );
        warnSpy.mockRestore();
    });

    test('"no such table" → getInt returns the default value (via getString)', async () => {
        adapterMock.selectOne.mockRejectedValue(
            new Error('no such table: configs')
        );
        await expect(repo.getInt('db.version', 42)).resolves.toBe(42);
    });

    test('missing table warns exactly once across repeated reads', async () => {
        // Fresh module instance so the once-per-process warn guard is reset.
        vi.resetModules();
        const { ConfigRepository: FreshRepo } =
            await import('../configRepository.js');
        const fresh = new FreshRepo();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        adapterMock.selectOne.mockRejectedValue(
            new Error('no such table: configs')
        );
        await fresh.getString('k1', 'd1');
        await fresh.getString('k2', 'd2');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
            '[browse] configs 表不存在，读取降级为默认值: k1'
        );
        warnSpy.mockRestore();
    });

    test('table exists → normal read returns the stored value', async () => {
        adapterMock.selectOne.mockResolvedValue(['stored']);
        await expect(repo.getString('k', 'def')).resolves.toBe('stored');
    });

    test('table exists but no row → default value (original behaviour)', async () => {
        adapterMock.selectOne.mockResolvedValue(null);
        await expect(repo.getString('k', 'def')).resolves.toBe('def');
    });

    test('non-missing-table errors still rethrow', async () => {
        adapterMock.selectOne.mockRejectedValue(
            new Error('database is locked')
        );
        await expect(repo.getString('k', 'def')).rejects.toThrow(
            'database is locked'
        );
    });
});
