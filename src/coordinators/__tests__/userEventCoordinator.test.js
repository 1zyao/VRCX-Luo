import { beforeEach, describe, expect, test, vi } from 'vitest';

const FRIEND_ID = 'usr_test';
const FIXED_NOW_ISO = '2026-08-10T00:00:00.000Z';

const mocks = vi.hoisted(() => ({
    // avatarName 非空 = 该文件确实是模型图（文件名 "Avatar - xxx - Image -"）
    getAvatarName: vi.fn(async (url) => ({
        ownerId: url,
        avatarName: String(url).includes('icon') ? '' : `Model ${url}`
    })),
    database: {
        addAvatarToDatabase: vi.fn()
    },
    feedStore: {
        addFeedEntry: vi.fn()
    },
    friendStore: {
        // vi.hoisted 先于模块级 const 执行，此处不能用 FRIEND_ID 变量
        friends: new Map([['usr_test', { id: 'usr_test' }]])
    },
    notificationStore: {
        queueFeedNoty: vi.fn()
    },
    sharedFeedStore: {
        addEntry: vi.fn()
    },
    userStore: {
        state: {
            instancePlayerCount: new Map()
        },
        userDialog: {
            $location: { tag: '' }
        },
        applyUserDialogLocation: vi.fn(),
        currentUser: { id: 'usr_other' },
        checkNote: vi.fn()
    }
}));

vi.mock('../../shared/utils', () => ({
    getGroupName: vi.fn(async () => ''),
    getWorldName: vi.fn(async () => ''),
    parseLocation: vi.fn(() => ({ tag: '', worldId: '', groupId: '' }))
}));

vi.mock('../../services/appConfig', () => ({
    AppDebug: { debugFriendState: false }
}));

vi.mock('../../services/database', () => ({
    database: {
        addGPSToDatabase: vi.fn(),
        addAvatarToDatabase: (...args) =>
            mocks.database.addAvatarToDatabase(...args),
        addStatusToDatabase: vi.fn(),
        addBioToDatabase: vi.fn()
    }
}));

vi.mock('../avatarCoordinator', () => ({
    getAvatarName: (...args) => mocks.getAvatarName(...args)
}));

vi.mock('../../stores/feed', () => ({
    useFeedStore: () => mocks.feedStore
}));

vi.mock('../../stores/friend', () => ({
    useFriendStore: () => mocks.friendStore
}));

vi.mock('../../stores/group', () => ({
    useGroupStore: () => ({ groupDialog: { id: '' } })
}));

vi.mock('../../stores/instance', () => ({
    useInstanceStore: () => ({
        applyWorldDialogInstances: vi.fn(),
        applyGroupDialogInstances: vi.fn()
    })
}));

vi.mock('../../stores/notification', () => ({
    useNotificationStore: () => mocks.notificationStore
}));

vi.mock('../../stores/sharedFeed', () => ({
    useSharedFeedStore: () => mocks.sharedFeedStore
}));

vi.mock('../../stores/user', () => ({
    useUserStore: () => mocks.userStore
}));

vi.mock('../../stores/world', () => ({
    useWorldStore: () => ({ worldDialog: { id: '' } })
}));

import { runHandleUserUpdateFlow } from '../userEventCoordinator';

const testSeams = {
    now: () => 1000,
    nowIso: () => FIXED_NOW_ISO
};

describe('runHandleUserUpdateFlow 模型变更检测（iconUrl → 落库）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('iconUrl 变成另一张模型图 → 落库，图片取 iconUrl', async () => {
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            iconUrl: 'img://modelB'
        };
        const props = {
            iconUrl: ['img://modelB', 'img://modelA']
        };

        await runHandleUserUpdateFlow(ref, props, testSeams);

        expect(mocks.database.addAvatarToDatabase).toHaveBeenCalledTimes(1);
        expect(mocks.notificationStore.queueFeedNoty).toHaveBeenCalledTimes(1);
        expect(mocks.sharedFeedStore.addEntry).toHaveBeenCalledTimes(1);
        expect(mocks.feedStore.addFeedEntry).toHaveBeenCalledTimes(1);

        const feed = mocks.database.addAvatarToDatabase.mock.calls[0][0];
        expect(feed).toMatchObject({
            created_at: FIXED_NOW_ISO,
            type: 'Avatar',
            userId: FRIEND_ID,
            displayName: 'Friend A',
            currentAvatarImageUrl: 'img://modelB',
            previousCurrentAvatarImageUrl: 'img://modelA',
            currentAvatarThumbnailImageUrl: 'img://modelB',
            previousCurrentAvatarThumbnailImageUrl: 'img://modelA',
            avatarName: 'Model img://modelB',
            previousAvatarName: 'Model img://modelA'
        });
    });

    test('iconUrl 变化 → 落库（原版宽松判定：只看 ownerId，名字可能为空）', async () => {
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            iconUrl: 'img://icon-custom'
        };
        const props = {
            iconUrl: ['img://icon-custom', 'img://modelA']
        };

        await runHandleUserUpdateFlow(ref, props, testSeams);

        expect(mocks.database.addAvatarToDatabase).toHaveBeenCalledTimes(1);
        const feed = mocks.database.addAvatarToDatabase.mock.calls[0][0];
        expect(feed.currentAvatarImageUrl).toBe('img://icon-custom');
        expect(feed.avatarName).toBe('');
    });

    test('没有 iconUrl 变化 → 不落库', async () => {
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            iconUrl: 'img://modelA'
        };

        await runHandleUserUpdateFlow(ref, {}, testSeams);

        expect(mocks.getAvatarName).not.toHaveBeenCalled();
        expect(mocks.database.addAvatarToDatabase).not.toHaveBeenCalled();
    });

    test('上一张是自定义头像 → previous* 照原版直接沿用旧 iconUrl', async () => {
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            iconUrl: 'img://modelA'
        };
        const props = {
            iconUrl: ['img://modelA', 'img://icon-custom']
        };

        await runHandleUserUpdateFlow(ref, props, testSeams);

        const feed = mocks.database.addAvatarToDatabase.mock.calls[0][0];
        expect(feed.currentAvatarImageUrl).toBe('img://modelA');
        expect(feed.previousCurrentAvatarImageUrl).toBe('img://icon-custom');
        expect(feed.previousCurrentAvatarThumbnailImageUrl).toBe(
            'img://icon-custom'
        );
    });
});
