import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { adapter } = vi.hoisted(() => ({
    adapter: {
        insert: vi.fn(),
        updateWhere: vi.fn(),
        deleteWhere: vi.fn()
    }
}));

vi.mock('../adapter/index.js', () => ({ adapter }));

import { feedCollectorLease } from '../feedCollectorLease.js';

describe('feedCollectorLease', () => {
    beforeEach(() => {
        adapter.insert.mockResolvedValue(1);
        adapter.updateWhere.mockResolvedValue(1);
        adapter.deleteWhere.mockResolvedValue(1);
    });

    afterEach(() => {
        feedCollectorLease.stop();
        vi.clearAllMocks();
    });

    test('owns the lease after a successful start and releases local ownership on stop', async () => {
        expect(feedCollectorLease.isOwner()).toBe(false);

        await feedCollectorLease.start();

        expect(feedCollectorLease.isOwner()).toBe(true);
        expect(adapter.updateWhere).toHaveBeenCalledTimes(1);

        feedCollectorLease.stop();

        expect(feedCollectorLease.isOwner()).toBe(false);
        expect(adapter.deleteWhere).toHaveBeenCalledTimes(1);
    });
});
