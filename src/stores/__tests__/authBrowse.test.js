import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createPinia, setActivePinia } from 'pinia';
import { createRequire } from 'node:module';
import { reactive } from 'vue';

const nodeRequire = createRequire(import.meta.url);
const NodeModule = nodeRequire('module');
const originalModuleLoad = NodeModule._load;

const mockWatchState = reactive({
    isLoggedIn: false,
    isFriendsLoaded: false,
    isFavoritesLoaded: false
});

const mocks = vi.hoisted(() => ({
    isBrowse: false,
    toast: {
        dismiss: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn()
    },
    request: vi.fn(),
    authRequest: {
        getConfig: vi.fn()
    },
    runLoginSuccessFlow: vi.fn(),
    runLogoutFlow: vi.fn(),
    runHandleAutoLoginFlow: vi.fn(),
    getCurrentUser: vi.fn(),
    initWebsocket: vi.fn(),
    advancedSettingsStore: {
        enablePrimaryPassword: false,
        setEnablePrimaryPassword: vi.fn(),
        setEnablePrimaryPasswordConfigRepository: vi.fn(),
        runAvatarAutoCleanup: vi.fn()
    },
    generalSettingsStore: {
        autoLoginDelayEnabled: false,
        autoLoginDelaySeconds: 0
    },
    modalStore: {
        prompt: vi.fn(),
        otpPrompt: vi.fn(),
        confirm: vi.fn(),
        alert: vi.fn()
    },
    updateLoopStore: {
        setNextCurrentUserRefresh: vi.fn(),
        setIpcTimeout: vi.fn()
    },
    userStore: {
        currentUser: {
            id: 'usr_me',
            displayName: 'Tester'
        },
        setUserDialogVisible: vi.fn()
    },
    vrcxStore: {
        waitForDatabaseInit: vi.fn().mockResolvedValue(true)
    },
    configRepository: {
        getString: vi.fn(),
        getBool: vi.fn(),
        setString: vi.fn(),
        setBool: vi.fn(),
        remove: vi.fn()
    },
    webApiService: {
        clearCookies: vi.fn().mockResolvedValue(undefined),
        getCookies: vi.fn().mockResolvedValue([]),
        setCookies: vi.fn().mockResolvedValue(undefined),
        createSecondaryClient: vi.fn()
    },
    security: {
        encrypt: vi.fn(),
        decrypt: vi.fn()
    },
    notyShow: vi.fn(),
    appDebug: {
        endpointDomain: '',
        websocketDomain: '',
        endpointDomainVrchat: 'https://vrchat.com',
        websocketDomainVrchat: 'wss://pubsub.vrchat.com',
        errorNoty: null
    },
    database: {
        initUserTables: vi.fn().mockResolvedValue(undefined),
        getUserPrefix: vi.fn().mockReturnValue('usr_me')
    },
    nodeRegistry: {
        setOwnPrefixes: vi.fn()
    }
}));

vi.mock('vue-sonner', () => ({
    toast: mocks.toast
}));

vi.mock('noty', () => ({
    default: vi.fn().mockImplementation(function NotyMock() {
        this.show = (...args) => mocks.notyShow(...args);
    })
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({
        t: (key) => key
    })
}));

vi.mock('../../services/request', () => ({
    request: (...args) => mocks.request(...args)
}));

vi.mock('../../api', () => ({
    authRequest: mocks.authRequest
}));

vi.mock('../../coordinators/authCoordinator', () => ({
    runLoginSuccessFlow: (...args) => mocks.runLoginSuccessFlow(...args),
    runLogoutFlow: (...args) => mocks.runLogoutFlow(...args)
}));

vi.mock('../../coordinators/authAutoLoginCoordinator', () => ({
    runHandleAutoLoginFlow: (...args) => mocks.runHandleAutoLoginFlow(...args)
}));

vi.mock('../../coordinators/userCoordinator', () => ({
    getCurrentUser: (...args) => mocks.getCurrentUser(...args)
}));

vi.mock('../../services/appConfig', () => ({
    AppDebug: mocks.appDebug,
    isApiLogSuppressed: vi.fn(() => true),
    logWebRequest: vi.fn()
}));

vi.mock('../../shared/utils', () => ({
    escapeTag: (value) => value
}));

vi.mock('../../stores/activity', () => ({
    useActivityStore: () => ({
        startFullCacheBuild: vi.fn()
    })
}));

vi.mock('../../stores/manualRelations', () => ({
    useManualRelationsStore: () => ({
        loadManualRelations: vi.fn().mockResolvedValue(undefined)
    })
}));

vi.mock('../../stores/trackedNonFriends', () => ({
    useTrackedNonFriendsStore: () => ({
        loadTrackedNonFriends: vi.fn().mockResolvedValue(undefined)
    })
}));

vi.mock('../../services/accountHub', () => ({
    accountHub: { primaryId: null }
}));

vi.mock('../../services/accountSession', () => ({
    AccountSession: vi.fn()
}));

vi.mock('../../services/database', () => ({
    database: mocks.database
}));

vi.mock('../../services/security', () => ({
    default: mocks.security
}));

vi.mock('../../services/webapi', () => ({
    default: mocks.webApiService
}));

vi.mock('../../services/watchState', () => ({
    watchState: mockWatchState
}));

vi.mock('../../services/config', () => ({
    default: mocks.configRepository
}));

vi.mock('../../services/websocket', () => ({
    initWebsocket: (...args) => mocks.initWebsocket(...args),
    closeWebSocket: vi.fn()
}));

vi.mock('../../stores/settings/advanced', () => ({
    useAdvancedSettingsStore: () => mocks.advancedSettingsStore
}));

vi.mock('../../stores/settings/general', () => ({
    useGeneralSettingsStore: () => mocks.generalSettingsStore
}));

vi.mock('../../stores/modal', () => ({
    useModalStore: () => mocks.modalStore
}));

vi.mock('../../stores/updateLoop', () => ({
    useUpdateLoopStore: () => mocks.updateLoopStore
}));

vi.mock('../../stores/user', () => ({
    useUserStore: () => mocks.userStore
}));

vi.mock('../../stores/vrcx', () => ({
    useVrcxStore: () => ({
        ...mocks.vrcxStore,
        isBrowse: mocks.isBrowse
    })
}));

vi.mock('../../services/database/nodeRegistry.js', () => ({
    nodeRegistry: mocks.nodeRegistry
}));

vi.mock('worker-timers', () => ({
    setTimeout: vi.fn()
}));

function flushPromises() {
    return Promise.resolve().then(() => Promise.resolve());
}

function installRequireStub() {
    NodeModule._load = function testModuleLoad(request, parent, isMain) {
        if (typeof request === 'string' && request.includes('accountHub')) {
            return { accountHub: { primaryId: null } };
        }
        return originalModuleLoad.call(this, request, parent, isMain);
    };
}

function restoreRequireStub() {
    NodeModule._load = originalModuleLoad;
}

async function createAuthStore() {
    setActivePinia(createPinia());
    const { useAuthStore } = await import('../auth');
    const store = useAuthStore();
    await flushPromises();
    return store;
}

describe('auth browse-mode login guards (M23)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isBrowse = false;
        installRequireStub();
    });

    afterEach(() => {
        mocks.isBrowse = false;
        restoreRequireStub();
    });

    test('login() returns early in browse mode without clearing cookies', async () => {
        mocks.isBrowse = true;
        const store = await createAuthStore();

        await store.login();

        expect(mocks.webApiService.clearCookies).not.toHaveBeenCalled();
    });

    test('login() proceeds past the guard in collector mode', async () => {
        const store = await createAuthStore();

        await store.login().catch(() => {});

        expect(mocks.webApiService.clearCookies).toHaveBeenCalled();
    });

    test('relogin() returns early in browse mode without clearing cookies', async () => {
        mocks.isBrowse = true;
        const store = await createAuthStore();
        const savedUser = {
            user: { id: 'usr_saved', displayName: 'Saved User' },
            loginParams: {
                username: 'saved@example.com',
                password: 'password',
                endpoint: '',
                websocket: ''
            }
        };

        await store.relogin(savedUser);

        expect(mocks.webApiService.clearCookies).not.toHaveBeenCalled();
    });

    test('loginComplete() does not set own prefixes in browse mode', async () => {
        mocks.isBrowse = true;
        const store = await createAuthStore();

        await store.loginComplete();

        expect(mocks.database.initUserTables).toHaveBeenCalledWith('usr_me');
        expect(mocks.nodeRegistry.setOwnPrefixes).not.toHaveBeenCalled();
    });

    test('loginComplete() sets own prefixes in collector mode', async () => {
        const store = await createAuthStore();

        await store.loginComplete();

        expect(mocks.database.initUserTables).toHaveBeenCalledWith('usr_me');
        expect(mocks.nodeRegistry.setOwnPrefixes).toHaveBeenCalledWith([
            'usr_me'
        ]);
    });

    test('autoLoginAfterMounted() 在 browse 模式下仍正常执行（锁定不 guard）', async () => {
        mocks.isBrowse = true;
        mocks.configRepository.getString.mockResolvedValue(null);
        const store = await createAuthStore();

        await store.autoLoginAfterMounted();

        expect(mocks.vrcxStore.waitForDatabaseInit).toHaveBeenCalled();
    });

    test('migrateStoredUsers() 在 browse 模式下仍正常执行（锁定不 guard）', async () => {
        mocks.isBrowse = true;
        mocks.configRepository.getString.mockResolvedValue('{}');
        const store = await createAuthStore();

        await store.migrateStoredUsers();

        expect(mocks.configRepository.setString).toHaveBeenCalledWith(
            'savedCredentials',
            '{}'
        );
    });
});
