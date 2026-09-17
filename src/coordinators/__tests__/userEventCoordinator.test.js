import { beforeEach, describe, expect, test, vi } from 'vitest';

const FRIEND_ID = 'usr_test';
const FIXED_NOW_ISO = '2026-08-10T00:00:00.000Z';

const mocks = vi.hoisted(() => ({
    getAvatarName: vi.fn(async (url) => ({
        ownerId: url,
        avatarName: `Model ${url}`
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
    generalSettingsStore: {
        logEmptyAvatars: false
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

vi.mock('../../stores/settings/general', () => ({
    useGeneralSettingsStore: () => mocks.generalSettingsStore
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

describe('runHandleUserUpdateFlow avatar 检测（触发→验证→落库）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.generalSettingsStore.logEmptyAvatars = false;
    });

    test('缩略图变化、模型图片 URL 未变 → 不落库（启动补全场景，核心修复）', async () => {
        // 启动时：离线好友缩略图 空''→有值，图片 URL 未变（diffObjectProps 删除相等字段，
        // 故 props 中无 currentAvatarImageUrl/currentAvatarTags，仅缩略图变化）
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            currentAvatarImageUrl: 'img://modelA',
            currentAvatarThumbnailImageUrl: 'img://thumbA',
            currentAvatarTags: ['a'],
            profilePicOverride: ''
        };
        const props = {
            currentAvatarThumbnailImageUrl: ['img://thumbA', '']
        };

        await runHandleUserUpdateFlow(ref, props, testSeams);

        expect(mocks.database.addAvatarToDatabase).not.toHaveBeenCalled();
        expect(mocks.notificationStore.queueFeedNoty).not.toHaveBeenCalled();
        expect(mocks.sharedFeedStore.addEntry).not.toHaveBeenCalled();
        expect(mocks.feedStore.addFeedEntry).not.toHaveBeenCalled();
    });

    test('模型图片 URL 变化 → 落库（真实换模型）', async () => {
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            currentAvatarImageUrl: 'img://modelB',
            currentAvatarThumbnailImageUrl: 'img://thumbB',
            currentAvatarTags: ['b'],
            profilePicOverride: ''
        };
        const props = {
            currentAvatarImageUrl: ['img://modelB', 'img://modelA'],
            currentAvatarThumbnailImageUrl: ['img://thumbB', 'img://thumbA']
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
            currentAvatarThumbnailImageUrl: 'img://thumbB',
            previousCurrentAvatarThumbnailImageUrl: 'img://thumbA',
            avatarName: 'Model img://modelB',
            previousAvatarName: 'Model img://modelA'
        });
    });

    test('仅标签变化、图片未变 → 不落库', async () => {
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            currentAvatarImageUrl: 'img://modelA',
            currentAvatarThumbnailImageUrl: 'img://thumbA',
            currentAvatarTags: ['newtag'],
            profilePicOverride: ''
        };
        const props = {
            currentAvatarTags: ['newtag', 'oldtag']
        };

        await runHandleUserUpdateFlow(ref, props, testSeams);

        expect(mocks.database.addAvatarToDatabase).not.toHaveBeenCalled();
        expect(mocks.notificationStore.queueFeedNoty).not.toHaveBeenCalled();
    });

    test('自定义头像占位图（profilePicOverride）+ 标签变化 → 不落库', async () => {
        // 自定义头像下 VRChat 把模型图换成机器人占位图，模型真实变更被隐藏，
        // 仅标签变化触发探测时，占位图路径应清空 ref 图片并跳过落库
        const ref = {
            id: FRIEND_ID,
            displayName: 'Friend A',
            currentAvatarImageUrl: 'img://robot',
            currentAvatarThumbnailImageUrl: 'img://robot-thumb',
            currentAvatarTags: ['newtag'],
            profilePicOverride: 'https://example.com/pic'
        };
        const props = {
            currentAvatarTags: ['newtag', 'oldtag']
        };

        await runHandleUserUpdateFlow(ref, props, testSeams);

        expect(mocks.getAvatarName).not.toHaveBeenCalled();
        expect(mocks.database.addAvatarToDatabase).not.toHaveBeenCalled();
        expect(mocks.notificationStore.queueFeedNoty).not.toHaveBeenCalled();
        // 占位图场景：ref 图片被清空（"forget last seen avatar"）
        expect(ref.currentAvatarImageUrl).toBe('');
        expect(ref.currentAvatarThumbnailImageUrl).toBe('');
    });
});
