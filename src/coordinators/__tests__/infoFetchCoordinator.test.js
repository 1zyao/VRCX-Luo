import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    friendStore: {
        friends: new Map([['usr_a', { id: 'usr_a', name: 'Alice' }]])
    },
    trackedStore: {
        trackedList: []
    },
    vrcxStore: {
        isBrowse: false
    },
    manualRelationsStore: {
        computeSuggestions: vi.fn().mockResolvedValue(undefined)
    },
    userRequest: {
        getUser: vi.fn().mockResolvedValue({
            json: {
                id: 'usr_a',
                displayName: 'Alice',
                bio: 'hello',
                status: 'active',
                statusDescription: ''
            }
        })
    }
}));

vi.mock('../../services/database', () => ({
    database: new Proxy(
        {},
        {
            get: (_target, prop) => {
                if (prop === '__esModule') return false;
                return vi.fn().mockResolvedValue(null);
            }
        }
    )
}));

vi.mock('../../api', () => ({
    userRequest: mocks.userRequest
}));

vi.mock('../../stores', () => ({
    useFriendStore: () => mocks.friendStore,
    useTrackedNonFriendsStore: () => mocks.trackedStore,
    useManualRelationsStore: () => mocks.manualRelationsStore,
    useVrcxStore: () => mocks.vrcxStore
}));

import { infoFetchState, runSilentInfoFetch } from '../infoFetchCoordinator';
import { watchState } from '../../services/watchState';

describe('runSilentInfoFetch browse-mode gate (bot#3)', () => {
    beforeEach(() => {
        watchState.isLoggedIn = true;
        mocks.vrcxStore.isBrowse = false;
        infoFetchState.status = 'idle';
        infoFetchState.done = 0;
        infoFetchState.total = 0;
        vi.clearAllMocks();
        mocks.manualRelationsStore.computeSuggestions.mockResolvedValue(undefined);
        mocks.userRequest.getUser.mockResolvedValue({
            json: {
                id: 'usr_a',
                displayName: 'Alice',
                bio: 'hello',
                status: 'active',
                statusDescription: ''
            }
        });
    });

    test('browse 模式：isBrowse=true 早退，不进 running，不调 API', async () => {
        mocks.vrcxStore.isBrowse = true;

        await runSilentInfoFetch();

        expect(infoFetchState.status).toBe('idle');
        expect(mocks.userRequest.getUser).not.toHaveBeenCalled();
        expect(mocks.manualRelationsStore.computeSuggestions).not.toHaveBeenCalled();
    });

    test('collector 模式：isBrowse=false 正常执行，进 running 并调 API', async () => {
        await runSilentInfoFetch();

        expect(mocks.userRequest.getUser).toHaveBeenCalledWith({ userId: 'usr_a' });
        expect(infoFetchState.status).toBe('done');
    });

    test('未登录：早退不执行', async () => {
        watchState.isLoggedIn = false;

        await runSilentInfoFetch();

        expect(infoFetchState.status).toBe('idle');
        expect(mocks.userRequest.getUser).not.toHaveBeenCalled();
    });
});
