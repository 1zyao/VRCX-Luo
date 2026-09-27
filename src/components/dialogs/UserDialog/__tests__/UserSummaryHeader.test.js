import { describe, expect, test, vi } from 'vitest';
import { flushPromises, shallowMount } from '@vue/test-utils';

const stores = vi.hoisted(() => ({
    userDialog: {
        __v_isRef: true,
        value: {
        id: 'usr_target',
        loading: false,
        isFriend: false,
        friend: null,
        mutualFriendCount: 3,
        previousDisplayNames: [],
        ref: {
            id: 'usr_target',
            displayName: 'Very Long Display Name That Should Remain Visible At High Zoom',
            status: 'active',
            statusDescription: 'A status description that should wrap instead of disappearing.',
            pronouns: 'they/them',
            profilePicOverrideThumbnail: '',
            profilePicOverride: '',
            currentAvatarThumbnailImageUrl: 'https://example.com/avatar.png',
            currentAvatarImageUrl: 'https://example.com/avatar-full.png',
            $languages: [{ key: 'eng', value: 'English' }],
            $trustClass: 'x-tag-known',
            $trustLevel: 'Known User',
            $platform: 'standalonewindows',
            $customTag: ''
        },
        publicProfileRef: {
            iconUrl: 'https://example.com/icon.png',
            badges: [
                {
                    badgeId: 'bdg_1',
                    badgeName: 'Test Badge',
                    badgeDescription: 'Badge description',
                    badgeImageUrl: 'https://example.com/badge.png',
                    hidden: false
                }
            ]
        }
        }
    },
    currentUser: {
        __v_isRef: true,
        value: {
            id: 'usr_current',
            username: 'current-user',
            currentAvatarThumbnailImageUrl: 'https://example.com/self-avatar.png',
            currentAvatarImageUrl: 'https://example.com/self-avatar-full.png'
        }
    },
    toggleFollow: vi.fn(),
    showFullscreenImageDialog: vi.fn()
}));

vi.mock('pinia', async (importOriginal) => ({
    ...(await importOriginal()),
    storeToRefs: (store) => store
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({ t: (key) => key })
}));

vi.mock('../../../../stores', () => ({
    useUserStore: () => ({
        userDialog: stores.userDialog,
        currentUser: stores.currentUser
    }),
    useGalleryStore: () => ({
        showFullscreenImageDialog: stores.showFullscreenImageDialog
    }),
    useAutoFollowStore: () => ({
        isActive: false,
        targetFriendId: '',
        statusText: '',
        toggleFollow: stores.toggleFollow
    })
}));

vi.mock('../../../../composables/useUserDisplay', () => ({
    useUserDisplay: () => ({
        userImage: () => 'https://example.com/icon.png',
        userStatusClass: () => 'x-user-status-active'
    })
}));

// 只有文件名里带 model 的算「模型图」（迁移后 getAvatarName 就是这么判的）
vi.mock('../../../../coordinators/avatarCoordinator', () => ({
    getAvatarName: vi.fn(async (url) =>
        String(url).includes('model')
            ? { ownerId: 'usr_owner', avatarName: 'Mamehinata' }
            : { ownerId: 'usr_owner', avatarName: '' }
    )
}));

vi.mock('../../../../services/database', () => ({
    database: {
        getFriendLogHistoryForUserId: vi.fn().mockResolvedValue([]),
        getLastAvatarChangeForUser: vi.fn().mockResolvedValue(null)
    }
}));

vi.mock('../../../../shared/utils', async (importOriginal) => ({
    ...(await importOriginal()),
    formatDateFilter: (value) => value,
    isFriendOnline: () => false,
    isRealInstance: () => false,
    languageClass: (key) => `flag-${key}`,
    openDiscordProfile: vi.fn()
}));

vi.mock('lucide-vue-next', () => ({
    Apple: { template: '<i />' },
    ChevronDown: { template: '<i />' },
    IdCard: { template: '<i />' },
    Image: { template: '<i />' },
    Info: { template: '<i />' },
    Monitor: { template: '<i />' },
    Navigation: { template: '<i />' },
    Shield: { template: '<i />' },
    Smartphone: { template: '<i />' },
    UserPlus: { template: '<i />' },
    Users: { template: '<i />' }
}));

import UserSummaryHeader from '../UserSummaryHeader.vue';
import { database } from '../../../../services/database';

function mountHeader() {
    return shallowMount(UserSummaryHeader, {
        props: {
            getUserStateText: () => 'Active',
            copyUserDisplayName: vi.fn(),
            toggleBadgeVisibility: vi.fn(),
            toggleBadgeShowcased: vi.fn(),
            userDialogCommand: vi.fn()
        },
        global: {
            stubs: {
                TooltipWrapper: { template: '<span><slot /><slot name="content" /></span>' },
                Badge: { template: '<span><slot /></span>' },
                Button: { template: '<button><slot /></button>' },
                Checkbox: { template: '<input type="checkbox" />' },
                Popover: { template: '<div><slot /></div>' },
                PopoverContent: { template: '<div><slot /></div>' },
                PopoverTrigger: { template: '<div><slot /></div>' },
                UserActionDropdown: { template: '<div data-testid="user-summary-dropdown" />' }
            }
        }
    });
}

describe('UserSummaryHeader.vue', () => {
    test('keeps the avatar, details and action area in a wrapping high-zoom layout', () => {
        const wrapper = mountHeader();

        expect(wrapper.find('[data-testid="user-summary-media"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="user-summary-details"]').text()).toContain('Very Long Display Name');
        expect(wrapper.find('[data-testid="user-summary-badges"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="user-summary-actions"]').exists()).toBe(true);

        // 左上大图 = 模型封面，右上方形 = 头像，不能互换
        expect(
            wrapper.find('[data-testid="user-summary-media"] img').attributes('src')
        ).toBe('https://example.com/avatar.png');
        expect(
            wrapper.find('[data-testid="user-summary-media"] img').attributes('src')
        ).not.toBe('https://example.com/icon.png');
        expect(
            wrapper.find('[data-testid="user-summary-icon"] img').attributes('src')
        ).toBe('https://example.com/icon.png');

        expect(wrapper.find('[data-testid="user-summary-header"]').classes()).toEqual(
            expect.arrayContaining(['flex-wrap', 'min-w-0'])
        );
        expect(wrapper.find('[data-testid="user-summary-details"]').classes()).toEqual(
            expect.arrayContaining(['min-w-0', 'basis-72'])
        );
    });

    test('self dialog uses currentUser avatar image instead of the user icon', () => {
        const dialog = stores.userDialog.value;
        const ref = dialog.ref;
        const id = dialog.id;
        dialog.id = 'usr_current';
        dialog.ref = {
            ...ref,
            id: 'usr_current',
            currentAvatarThumbnailImageUrl: '',
            currentAvatarImageUrl: ''
        };

        try {
            const wrapper = mountHeader();
            const media = wrapper.find('[data-testid="user-summary-media"] img');
            expect(media.attributes('src')).toBe('https://example.com/self-avatar.png');
            expect(media.attributes('src')).not.toBe('https://example.com/icon.png');
        } finally {
            dialog.id = id;
            dialog.ref = ref;
        }
    });

    test('stale ref.currentAvatar* does not override a fresh iconUrl model image', async () => {
        const dialog = stores.userDialog.value;
        const ref = dialog.ref;
        const profile = dialog.publicProfileRef;
        const id = dialog.id;
        dialog.id = 'usr_stranger';
        // ref 上是迁移前遗留的旧模型；iconUrl 才是他现在用的模型图
        dialog.ref = {
            ...ref,
            id: 'usr_stranger',
            currentAvatarImageUrl: 'https://example.com/stale-model.png',
            currentAvatarThumbnailImageUrl: 'https://example.com/stale-model.png'
        };
        dialog.publicProfileRef = { iconUrl: 'https://example.com/model-new.png' };

        try {
            const wrapper = mountHeader();
            await flushPromises();
            const media = wrapper.find('[data-testid="user-summary-media"] img');
            expect(media.attributes('src')).toBe('https://example.com/model-new.png');
            expect(media.attributes('src')).not.toBe('https://example.com/stale-model.png');
        } finally {
            dialog.id = id;
            dialog.ref = ref;
            dialog.publicProfileRef = profile;
        }
    });

    test('falls back to the recorded model cover when the API hides the avatar', async () => {
        const dialog = stores.userDialog.value;
        const ref = dialog.ref;
        const profile = dialog.publicProfileRef;
        const id = dialog.id;
        dialog.id = 'usr_stranger';
        // 实时接口不给 currentAvatar*（玩家设了自定义头像），只剩下本地记录
        dialog.ref = {
            ...ref,
            id: 'usr_stranger',
            currentAvatarThumbnailImageUrl: '',
            currentAvatarImageUrl: ''
        };
        dialog.publicProfileRef = { iconUrl: 'https://example.com/icon.png' };
        database.getLastAvatarChangeForUser.mockResolvedValueOnce({
            currentAvatarImageUrl: 'https://example.com/recorded-full.png',
            currentAvatarThumbnailImageUrl: 'https://example.com/recorded.png',
            createdAt: '2026-09-18T00:00:00.000Z'
        });

        try {
            const wrapper = mountHeader();
            await flushPromises();
            const media = wrapper.find('[data-testid="user-summary-media"] img');
            expect(media.attributes('src')).toBe('https://example.com/recorded.png');
            expect(media.attributes('src')).not.toBe('https://example.com/icon.png');
            expect(
                wrapper.find('[data-testid="user-summary-icon"] img').attributes('src')
            ).toBe('https://example.com/icon.png');
        } finally {
            dialog.id = id;
            dialog.ref = ref;
            dialog.publicProfileRef = profile;
        }
    });
});
