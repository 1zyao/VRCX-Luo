import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import { getAvatarName } from '../../../../coordinators/avatarCoordinator';
import { database } from '../../../../services/database';
import { useUserStore } from '../../../../stores';

/**
 * 解析资料页「正在使用的模型」图片（VRChat profile 端点迁移后的取数顺序）。
 *
 * 迁移后 `currentAvatarImageUrl` / `currentAvatarThumbnailImageUrl` 不再随 user 对象
 * 返回，原版 VRCX 的替代做法是把 `iconUrl`（玩家头像）当成模型图 —— 玩家没设自定义
 * 头像时 `iconUrl` 就是他当前模型的图片。判定依据是文件元数据里的 avatarName
 * （只有模型图文件的名字是 `Avatar - xxx - Image -`），比只看 ownerId 准确：
 * 自定义 VRC+ 头像文件同样有 ownerId，但 avatarName 为空。
 *
 * 取数顺序：
 *   1. 自己 → `currentUser.currentAvatar*`
 *   2. 他人 → user ref（WS/缓存）→ `publicProfileRef`（profile/{id}）的 currentAvatar*
 *   3. `iconUrl` 且它确实是模型图（avatarName 非空）
 *   4. 本机记录过的最近一次模型封面（feed_avatar 变更事件）
 *   5. 都没有 → 空（由调用方显示占位/未知）
 *
 * @returns {{ avatarImageUrl: import('vue').ComputedRef<string>,
 *             avatarThumbnailImageUrl: import('vue').ComputedRef<string>,
 *             hasAvatarInfo: import('vue').ComputedRef<boolean> }}
 */
export function useUserAvatarImage() {
    const { userDialog, currentUser } = storeToRefs(useUserStore());

    const userIconUrl = computed(
        () =>
            userDialog.value.publicProfileRef?.iconUrl ||
            userDialog.value.ref?.iconUrl ||
            ''
    );

    /** `iconUrl` 本身就是模型图时缓存下来 */
    const iconAsAvatarImageUrl = ref('');
    watch(
        [() => userDialog.value.id, () => userIconUrl.value],
        async ([userId, iconUrl]) => {
            if (!userId || !iconUrl) {
                iconAsAvatarImageUrl.value = '';
                return;
            }
            try {
                const info = await getAvatarName(iconUrl);
                if (
                    userDialog.value.id === userId &&
                    userIconUrl.value === iconUrl &&
                    info?.avatarName
                ) {
                    iconAsAvatarImageUrl.value = iconUrl;
                    return;
                }
            } catch (err) {
                console.error('Failed to resolve avatar image:', err);
            }
            if (userDialog.value.id === userId && userIconUrl.value === iconUrl) {
                iconAsAvatarImageUrl.value = '';
            }
        },
        { immediate: true }
    );

    /** 本机记录过的最近一次模型封面（feed_avatar 变更事件） */
    const recordedAvatarImageUrl = ref('');
    const recordedAvatarFullImageUrl = ref('');
    const recordedAvatarName = ref('');
    watch(
        () => userDialog.value.id,
        async (userId) => {
            recordedAvatarImageUrl.value = '';
            recordedAvatarFullImageUrl.value = '';
            recordedAvatarName.value = '';
            if (!userId) {
                return;
            }
            try {
                const last = await database.getLastAvatarChangeForUser(userId);
                if (userDialog.value.id !== userId || !last) {
                    return;
                }
                recordedAvatarImageUrl.value =
                    last.currentAvatarThumbnailImageUrl ||
                    last.currentAvatarImageUrl ||
                    '';
                recordedAvatarFullImageUrl.value =
                    last.currentAvatarImageUrl ||
                    last.currentAvatarThumbnailImageUrl ||
                    '';
                recordedAvatarName.value = last.avatarName || '';
            } catch (err) {
                console.error('Failed to load recorded avatar cover:', err);
            }
        },
        { immediate: true }
    );

    const isSelf = computed(
        () => userDialog.value.id === currentUser.value.id
    );

    /**
     * 实时来源：自己看 `currentUser`（auth/user 仍带 currentAvatar*）；
     * 他人只看 `profile/{id}` —— 它是打开弹窗时现拉的。
     */
    const liveAvatarImageUrl = computed(() => {
        const profile = userDialog.value.publicProfileRef || {};
        if (isSelf.value) {
            return (
                currentUser.value.currentAvatarImageUrl ||
                currentUser.value.currentAvatarThumbnailImageUrl ||
                ''
            );
        }
        return (
            profile.currentAvatarImageUrl ||
            profile.currentAvatarThumbnailImageUrl ||
            ''
        );
    });

    const liveAvatarThumbnailImageUrl = computed(() => {
        const profile = userDialog.value.publicProfileRef || {};
        if (isSelf.value) {
            return (
                currentUser.value.currentAvatarThumbnailImageUrl ||
                currentUser.value.currentAvatarImageUrl ||
                ''
            );
        }
        return (
            profile.currentAvatarThumbnailImageUrl ||
            profile.currentAvatarImageUrl ||
            ''
        );
    });

    /**
     * 兜底来源（按新鲜度）：`iconUrl`（本身就是模型图时）→ 本机记录过的封面；
     * 最后才是 user ref 上的 `currentAvatar*` —— 那是迁移前遗留的旧值，新 API
     * 不再刷新它，排前面就会「Feed 已经记录换了模型，主页还显示上一个模型」。
     */
    const fallbackThumbnailUrl = computed(
        () => iconAsAvatarImageUrl.value || recordedAvatarImageUrl.value
    );
    const fallbackFullImageUrl = computed(
        () => iconAsAvatarImageUrl.value || recordedAvatarFullImageUrl.value
    );
    const legacyAvatarImageUrl = computed(() => {
        if (isSelf.value) {
            return '';
        }
        const ref = userDialog.value.ref || {};
        return ref.currentAvatarImageUrl || ref.currentAvatarThumbnailImageUrl || '';
    });
    const legacyAvatarThumbnailImageUrl = computed(() => {
        if (isSelf.value) {
            return '';
        }
        const ref = userDialog.value.ref || {};
        return ref.currentAvatarThumbnailImageUrl || ref.currentAvatarImageUrl || '';
    });

    const avatarImageUrl = computed(
        () =>
            liveAvatarImageUrl.value ||
            fallbackFullImageUrl.value ||
            legacyAvatarImageUrl.value
    );
    const avatarThumbnailImageUrl = computed(
        () =>
            liveAvatarThumbnailImageUrl.value ||
            fallbackThumbnailUrl.value ||
            legacyAvatarThumbnailImageUrl.value
    );
    const hasAvatarInfo = computed(() => Boolean(avatarImageUrl.value));

    /**
     * 模型名：先用「正在显示的那张图」反查（这样名字永远和图片一致；文件名叫不上时
     * 为空），再退回 profile/{id} 的 `currentAvatarName`、本机记录的名字，
     * 最后才是 user ref 上的旧值。
     */
    const fileAvatarName = ref('');
    watch(
        () => avatarImageUrl.value,
        async (imageUrl) => {
            fileAvatarName.value = '';
            if (!imageUrl) {
                return;
            }
            try {
                const info = await getAvatarName(imageUrl);
                if (avatarImageUrl.value === imageUrl && info?.avatarName) {
                    fileAvatarName.value = info.avatarName;
                }
            } catch (err) {
                console.error('Failed to resolve avatar name:', err);
            }
        },
        { immediate: true }
    );
    const avatarNameHint = computed(
        () =>
            fileAvatarName.value ||
            userDialog.value.publicProfileRef?.currentAvatarName ||
            recordedAvatarName.value ||
            userDialog.value.ref?.currentAvatarName ||
            ''
    );

    return {
        avatarImageUrl,
        avatarThumbnailImageUrl,
        avatarNameHint,
        hasAvatarInfo,
        userIconUrl
    };
}
