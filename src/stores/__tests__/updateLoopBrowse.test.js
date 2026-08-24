import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    updateAutoStateChange: vi.fn(),
    runRefreshFriendsListFlow: vi.fn(),
    runUpdateIsGameRunningFlow: vi.fn(),
    addGameLogEvent: vi.fn(),
    runRefreshPlayerModerationsFlow: vi.fn(),
    refreshTrackedNonFriendsFlow: vi.fn(),
    clearVRCXCache: vi.fn(),
    handleGroupUserInstances: vi.fn(),
    groupRequest: { getUsersGroupInstances: vi.fn() },
    database: { optimize: vi.fn() },
    vrcxStore: {
        isBrowse: false,
        clearVRCXCacheFrequency: 0,
        tryAutoBackupVrcRegistry: vi.fn(),
        setIpcEnabled: vi.fn()
    },
    authStore: { updateStoredUser: vi.fn() },
    discordPresenceSettingsStore: {
        discordActive: false,
        updateDiscord: vi.fn()
    },
    friendStore: { setIsRefreshFriendsLoading: vi.fn() },
    userStore: { currentUser: null },
    vrcxUpdaterStore: { autoUpdateVRCX: 'Off', checkForVRCXUpdate: vi.fn() },
    vrStore: { vrInit: vi.fn() },
    setTimeoutCb: vi.fn()
}));

vi.mock('../../services/database', () => ({ database: mocks.database }));
vi.mock('../../api', () => ({ groupRequest: mocks.groupRequest }));
vi.mock('../../coordinators/friendSyncCoordinator', () => ({
    runRefreshFriendsListFlow: mocks.runRefreshFriendsListFlow
}));
vi.mock('../../coordinators/gameCoordinator', () => ({
    runUpdateIsGameRunningFlow: mocks.runUpdateIsGameRunningFlow
}));
vi.mock('../../coordinators/gameLogCoordinator', () => ({
    addGameLogEvent: mocks.addGameLogEvent
}));
vi.mock('../../coordinators/moderationCoordinator', () => ({
    runRefreshPlayerModerationsFlow: mocks.runRefreshPlayerModerationsFlow
}));
vi.mock('../../coordinators/nonFriendCoordinator', () => ({
    refreshTrackedNonFriendsFlow: mocks.refreshTrackedNonFriendsFlow
}));
vi.mock('../../coordinators/vrcxCoordinator', () => ({
    clearVRCXCache: mocks.clearVRCXCache
}));
vi.mock('../../coordinators/groupCoordinator', () => ({
    handleGroupUserInstances: mocks.handleGroupUserInstances
}));
vi.mock('../../coordinators/userCoordinator', () => ({
    getCurrentUser: mocks.getCurrentUser,
    updateAutoStateChange: mocks.updateAutoStateChange
}));
vi.mock('../auth', () => ({ useAuthStore: () => mocks.authStore }));
vi.mock('../settings/discordPresence', () => ({
    useDiscordPresenceSettingsStore: () => mocks.discordPresenceSettingsStore
}));
vi.mock('../friend', () => ({ useFriendStore: () => mocks.friendStore }));
vi.mock('../user', () => ({ useUserStore: () => mocks.userStore }));
vi.mock('../vrcxUpdater', () => ({
    useVRCXUpdaterStore: () => mocks.vrcxUpdaterStore
}));
vi.mock('../vr', () => ({ useVrStore: () => mocks.vrStore }));
vi.mock('../vrcx', () => ({ useVrcxStore: () => mocks.vrcxStore }));
vi.mock('../modal', () => ({ useModalStore: () => ({}) }));
vi.mock('worker-timers', () => ({
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (cb) => mocks.setTimeoutCb(cb),
    clearTimeout: () => {}
}));

import { setActivePinia, createPinia } from 'pinia';
import { watchState } from '../../services/watchState';

const { useUpdateLoopStore } = await import('../updateLoop');

describe('updateLoop browse-mode gate (M3)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        watchState.isLoggedIn = true;
        mocks.vrcxStore.isBrowse = false;
        vi.clearAllMocks();
    });

    afterEach(() => {
        watchState.isLoggedIn = false;
        mocks.vrcxStore.isBrowse = false;
    });

    test('collector 模式：登录后按周期刷新当前用户', async () => {
        const store = useUpdateLoopStore();
        store.setNextCurrentUserRefresh(1);
        await store.updateLoop();

        expect(mocks.getCurrentUser).toHaveBeenCalled();
        expect(mocks.setTimeoutCb).toHaveBeenCalledTimes(1);
    });

    test('browse 模式：跳过全部刷新周期，但仍调度下一拍', async () => {
        mocks.vrcxStore.isBrowse = true;
        const store = useUpdateLoopStore();
        await store.updateLoop();

        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.runRefreshFriendsListFlow).not.toHaveBeenCalled();
        expect(mocks.runRefreshPlayerModerationsFlow).not.toHaveBeenCalled();
        expect(mocks.database.optimize).not.toHaveBeenCalled();
        expect(mocks.setTimeoutCb).toHaveBeenCalledTimes(1);
    });

    test('未登录：同样跳过全部刷新周期', async () => {
        watchState.isLoggedIn = false;
        const store = useUpdateLoopStore();
        await store.updateLoop();

        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.setTimeoutCb).toHaveBeenCalledTimes(1);
    });
});
