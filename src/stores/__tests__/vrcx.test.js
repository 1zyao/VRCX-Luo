/**
 * Vrcx store startup tests — browse-mode M1 upgrade-tree bypass (M11,
 * docs/architecture/BROWSE_MODE_M1_DESIGN.md §2.4 / §4.4 / §6.1).
 *
 * browse 分支：跳过整个升级决策树（Branch A upgradeInPlace / Branch B
 * handleUninitializedDatabase），执行 schema 探测 + 启动日志三连，不写
 * VRCX_databaseVersion；collector / auto 分支决策树行为与改动前一致。
 *
 * The store's `init()` runs at store creation, so every test awaits
 * `store.waitForDatabaseInit()` as the deterministic completion point.
 * upgradeInPlace / handleUninitializedDatabase are closure-internal, so
 * "Branch A/B not invoked" is asserted through their observable side
 * effects: database.runMigrations (A/B), database.initTables (B),
 * VRCXStorage.GetBackup (B) and configRepository.setInt (A/B version
 * write).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    adapterMock: {
        listTables: vi.fn()
    },
    databaseMock: {
        runMigrations: vi.fn(),
        initTables: vi.fn(),
        setMaxTableSize: vi.fn(),
        setSearchTableSize: vi.fn(),
        addGamelogEventToDatabase: vi.fn(),
        addGamelogExternalToDatabase: vi.fn()
    },
    configRepoMock: {
        getInt: vi.fn(),
        getString: vi.fn(),
        setInt: vi.fn(),
        setString: vi.fn(),
        getBool: vi.fn(),
        setBool: vi.fn(),
        getFloat: vi.fn(),
        setFloat: vi.fn(),
        getObject: vi.fn(),
        setObject: vi.fn(),
        getArray: vi.fn(),
        setArray: vi.fn(),
        init: vi.fn(),
        remove: vi.fn()
    },
    refreshCustomScript: vi.fn(),
    nodeRegistryMock: {
        detectActiveCollectors: vi.fn(async () => []),
        startHeartbeat: vi.fn(async () => undefined),
        stopHeartbeat: vi.fn()
    },
    downgradeToReadOnly: vi.fn(async () => undefined),
    upgradeToWritable: vi.fn(() => undefined),
    timers: {
        setInterval: vi.fn(),
        clearInterval: vi.fn()
    }
}));

// ── module mocks (paths relative to src/stores/__tests__/) ────────────

vi.mock('../../services/database/adapter/index.js', () => ({
    adapter: mocks.adapterMock,
    createAdapter: vi.fn(),
    downgradeToReadOnly: mocks.downgradeToReadOnly,
    upgradeToWritable: mocks.upgradeToWritable
}));
vi.mock('../../services/database', () => ({ database: mocks.databaseMock }));
vi.mock('../../services/database/nodeRegistry.js', () => ({
    nodeRegistry: mocks.nodeRegistryMock
}));
vi.mock('../../services/config', () => ({ default: mocks.configRepoMock }));
vi.mock('../../shared/utils/base/ui', () => ({
    refreshCustomScript: mocks.refreshCustomScript
}));
vi.mock('../../shared/utils', () => ({
    debounce: vi.fn(),
    parseLocation: vi.fn()
}));
vi.mock('../../api', () => ({ avatarRequest: {}, queryRequest: {} }));
vi.mock('../../services/watchState', () => ({
    watchState: { isLoggedIn: false }
}));
vi.mock('vue-sonner', () => ({
    toast: { error: vi.fn(), success: vi.fn() }
}));
vi.mock('worker-timers', () => ({
    setInterval: mocks.timers.setInterval,
    clearInterval: mocks.timers.clearInterval
}));

vi.mock('../../coordinators/favoriteCoordinator', () => ({
    addLocalWorldFavorite: vi.fn(),
    addLocalAvatarFavorite: vi.fn()
}));
vi.mock('../../coordinators/groupCoordinator', () => ({
    showGroupDialog: vi.fn()
}));
vi.mock('../../coordinators/worldCoordinator', () => ({
    showWorldDialog: vi.fn()
}));
vi.mock('../../coordinators/avatarCoordinator', () => ({
    showAvatarDialog: vi.fn(),
    selectAvatarWithConfirmation: vi.fn(),
    selectAvatarWithoutConfirmation: vi.fn()
}));
vi.mock('../../coordinators/userCoordinator', () => ({
    showUserDialog: vi.fn(),
    addCustomTag: vi.fn()
}));
vi.mock('../../coordinators/vrcxCoordinator', () => ({
    clearVRCXCache: vi.fn()
}));
vi.mock('../../coordinators/searchIndexCoordinator', () => ({
    resetSearchIndexOnLogin: vi.fn()
}));

vi.mock('../settings/advanced', () => ({
    useAdvancedSettingsStore: () => ({})
}));
vi.mock('../avatarProvider', () => ({ useAvatarProviderStore: () => ({}) }));
vi.mock('../favorite', () => ({ useFavoriteStore: () => ({}) }));
vi.mock('../gameLog', () => ({ useGameLogStore: () => ({}) }));
vi.mock('../game', () => ({ useGameStore: () => ({}) }));
vi.mock('../location', () => ({ useLocationStore: () => ({}) }));
vi.mock('../modal', () => ({ useModalStore: () => ({}) }));
vi.mock('../notification', () => ({ useNotificationStore: () => ({}) }));
vi.mock('../photon', () => ({ usePhotonStore: () => ({}) }));
vi.mock('../search', () => ({ useSearchStore: () => ({}) }));
vi.mock('../updateLoop', () => ({ useUpdateLoopStore: () => ({}) }));
vi.mock('../user', () => ({ useUserStore: () => ({}) }));
vi.mock('../vrcStatus', () => ({ useVrcStatusStore: () => ({}) }));

vi.mock('vue-i18n', async (importOriginal) => {
    const actual = await importOriginal();
    const i18n = actual.createI18n({
        locale: 'en',
        fallbackLocale: 'en',
        legacy: false,
        missingWarn: false,
        fallbackWarn: false
    });
    return {
        ...actual,
        useI18n: () => i18n.global
    };
});

import { useVrcxStore } from '../vrcx';

const TARGET_DB_VERSION = 17;

/**
 * 安装 VRCXStorage 全局 mock。`nodeMode` 为 `VRCX_NodeMode` 的返回值
 * （默认空串 → collector）。
 * @param {string} nodeMode
 * @returns {{ Get: ReturnType<typeof vi.fn>, Set: ReturnType<typeof vi.fn>, GetBackup: ReturnType<typeof vi.fn> }}
 */
function installVrcxStorage(nodeMode = '') {
    const mock = {
        Get: vi.fn(async (key) => (key === 'VRCX_NodeMode' ? nodeMode : '')),
        Set: vi.fn(async () => undefined),
        GetBackup: vi.fn(async () => '{}')
    };
    globalThis.VRCXStorage = mock;
    return mock;
}

/**
 * configRepository.getInt：`VRCX_databaseVersion` 返回给定版本，
 * 其余键返回默认值。
 * @param {number} version
 */
function stubDatabaseVersion(version) {
    mocks.configRepoMock.getInt.mockImplementation(async (key, defaultValue) =>
        key === 'VRCX_databaseVersion' ? version : defaultValue
    );
}

/** @type {{ Get: ReturnType<typeof vi.fn>, Set: ReturnType<typeof vi.fn>, GetBackup: ReturnType<typeof vi.fn> }} */
let vrcxStorageMock;
/** @type {ReturnType<typeof vi.spyOn>} */
let logSpy;
/** @type {ReturnType<typeof vi.spyOn>} */
let warnSpy;

beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    vrcxStorageMock = installVrcxStorage('');
    globalThis.AppApi = {
        ResolveDatabaseName: vi.fn(async () => '/db/main.db'),
        ShowDevTools: vi.fn()
    };
    mocks.adapterMock.listTables.mockResolvedValue(['configs']);
    stubDatabaseVersion(TARGET_DB_VERSION);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
});

describe('vrcx 启动：browse 模式升级树旁路（§2.4 / §4.4）', () => {
    test('browse：跳过 Branch A/B，探测日志三连，不写 VRCX_databaseVersion', async () => {
        vrcxStorageMock = installVrcxStorage('browse');

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        // 版本读取保留在旁路之前（§2.4）
        expect(mocks.configRepoMock.getInt).toHaveBeenCalledWith(
            'VRCX_databaseVersion',
            0
        );
        // 模式判定读取
        expect(vrcxStorageMock.Get).toHaveBeenCalledWith('VRCX_NodeMode');
        // schema 探测
        expect(mocks.adapterMock.listTables).toHaveBeenCalledWith('configs');
        // Branch A/B 均未执行（副作用断言）
        expect(mocks.databaseMock.runMigrations).not.toHaveBeenCalled();
        expect(mocks.databaseMock.initTables).not.toHaveBeenCalled();
        expect(vrcxStorageMock.GetBackup).not.toHaveBeenCalled();
        // 不写版本号（configRepository 与 VRCXStorage 双路径）
        expect(mocks.configRepoMock.setInt).not.toHaveBeenCalled();
        expect(vrcxStorageMock.Set).not.toHaveBeenCalledWith(
            'VRCX_databaseVersion',
            expect.anything()
        );
        // 启动日志三连（§4.4 / §10）
        expect(logSpy).toHaveBeenCalledWith(
            '[browse] 浏览模式（只读）已启用：VRCX_NodeMode=browse'
        );
        expect(logSpy).toHaveBeenCalledWith(
            `[browse] 数据库版本：${TARGET_DB_VERSION}（目标 ${TARGET_DB_VERSION}）；schema 探测：configs 表存在`
        );
        expect(logSpy).toHaveBeenCalledWith(
            '[browse] 只读：DB 写入被门禁丢弃；登录状态与本地设置不会持久化；建议单实例多账号'
        );
        // v >= target 无版本警告
        expect(warnSpy).not.toHaveBeenCalled();
        // 启动完成
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('browse：configs 表缺失 → 探测日志分支「缺失」，启动继续', async () => {
        vrcxStorageMock = installVrcxStorage('browse');
        mocks.adapterMock.listTables.mockResolvedValue([]);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining('schema 探测：configs 表缺失')
        );
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('browse：版本未知（v == 0）→ 警告，不执行 Branch B', async () => {
        vrcxStorageMock = installVrcxStorage('browse');
        stubDatabaseVersion(0);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(warnSpy).toHaveBeenCalledWith(
            '[browse] 数据库版本未知（空库或从未初始化）。'
        );
        expect(vrcxStorageMock.GetBackup).not.toHaveBeenCalled();
        expect(mocks.databaseMock.initTables).not.toHaveBeenCalled();
        expect(mocks.configRepoMock.setInt).not.toHaveBeenCalled();
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('browse：低版本（0 < v < target）→ 警告不执行升级，启动继续', async () => {
        vrcxStorageMock = installVrcxStorage('browse');
        stubDatabaseVersion(5);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(warnSpy).toHaveBeenCalledWith(
            `[browse] 库版本 5 低于当前 ${TARGET_DB_VERSION}，` +
                '浏览模式不执行升级；schema 可能不兼容，部分查询可能失败。' +
                '建议以 collector 模式启动一次完成升级。'
        );
        expect(mocks.databaseMock.runMigrations).not.toHaveBeenCalled();
        expect(mocks.configRepoMock.setInt).not.toHaveBeenCalled();
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('browse：schema 探测失败不阻断启动（fail-safe）', async () => {
        vrcxStorageMock = installVrcxStorage('browse');
        mocks.adapterMock.listTables.mockRejectedValue(
            new Error('attempt to write a readonly database')
        );

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(warnSpy).toHaveBeenCalledWith(
            '[browse] schema 探测失败:',
            'attempt to write a readonly database'
        );
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('browse：大小写/空白不敏感（" BROWSE " → browse，§2.5）', async () => {
        vrcxStorageMock = installVrcxStorage(' BROWSE ');

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(logSpy).toHaveBeenCalledWith(
            '[browse] 浏览模式（只读）已启用：VRCX_NodeMode=browse'
        );
        expect(mocks.databaseMock.runMigrations).not.toHaveBeenCalled();
    });
});

describe('vrcx 启动：collector 分支决策树（改动前行为回归）', () => {
    test('collector：v == target → 无事可做，启动心跳', async () => {
        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(vrcxStorageMock.Get).toHaveBeenCalledWith('VRCX_NodeMode');
        expect(mocks.databaseMock.runMigrations).not.toHaveBeenCalled();
        expect(vrcxStorageMock.GetBackup).not.toHaveBeenCalled();
        expect(mocks.configRepoMock.setInt).not.toHaveBeenCalled();
        expect(mocks.nodeRegistryMock.startHeartbeat).toHaveBeenCalledWith(
            'collector'
        );
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('auto：无活跃采集节点 → collector 心跳启动，v == target 无事可做', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        mocks.nodeRegistryMock.detectActiveCollectors.mockResolvedValue([]);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(mocks.nodeRegistryMock.detectActiveCollectors).toHaveBeenCalled();
        expect(mocks.nodeRegistryMock.startHeartbeat).toHaveBeenCalledWith(
            'collector'
        );
        expect(mocks.downgradeToReadOnly).not.toHaveBeenCalled();
        expect(store.state.effectiveNodeMode).toBe('collector');
        expect(mocks.databaseMock.runMigrations).not.toHaveBeenCalled();
        expect(vrcxStorageMock.GetBackup).not.toHaveBeenCalled();
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('auto：检测到活跃采集节点 → 降级只读，进入浏览模式，不启动心跳', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        mocks.nodeRegistryMock.detectActiveCollectors.mockResolvedValue([
            {
                nodeId: 'node-other',
                mode: 'collector',
                prefixes: 'usr_a',
                heartbeatAt: new Date().toISOString()
            }
        ]);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(mocks.downgradeToReadOnly).toHaveBeenCalled();
        expect(mocks.nodeRegistryMock.startHeartbeat).not.toHaveBeenCalled();
        expect(store.state.effectiveNodeMode).toBe('browse');
        expect(store.state.browseSource).toBe('auto-detected');
        expect(store.state.detectedNodeIds).toEqual(['node-other']);
        expect(logSpy).toHaveBeenCalledWith(
            '[browse] 浏览模式（只读）已启用：检测到其他活跃采集节点（auto）'
        );
        expect(mocks.databaseMock.runMigrations).not.toHaveBeenCalled();
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('auto：检测表缺失（nodeRegistry 内部容错返回空）→ collector 心跳启动', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        mocks.nodeRegistryMock.detectActiveCollectors.mockResolvedValue([]);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(mocks.downgradeToReadOnly).not.toHaveBeenCalled();
        expect(mocks.nodeRegistryMock.startHeartbeat).toHaveBeenCalledWith(
            'collector'
        );
        expect(store.state.effectiveNodeMode).toBe('collector');
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });

    test('collector：v < target → Branch A 原地升级并写版本号', async () => {
        stubDatabaseVersion(10);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(mocks.nodeRegistryMock.startHeartbeat).toHaveBeenCalledWith(
            'collector'
        );
        expect(mocks.databaseMock.initTables).toHaveBeenCalled();
        expect(mocks.databaseMock.runMigrations).toHaveBeenCalledWith(
            10,
            TARGET_DB_VERSION,
            {}
        );
        expect(mocks.configRepoMock.setInt).toHaveBeenCalledWith(
            'VRCX_databaseVersion',
            TARGET_DB_VERSION
        );
        expect(store.state.databaseVersion).toBe(TARGET_DB_VERSION);
        expect(logSpy).toHaveBeenCalledWith(
            `升级数据库从 10 到 ${TARGET_DB_VERSION}...`
        );
        expect(logSpy).toHaveBeenCalledWith('数据库升级完成。');
    });

    test('collector：v == 0 → Branch B 初始化 + 修复并写版本号', async () => {
        stubDatabaseVersion(0);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(mocks.nodeRegistryMock.startHeartbeat).toHaveBeenCalledWith(
            'collector'
        );
        // Branch B 入口：读取备份配置
        expect(vrcxStorageMock.GetBackup).toHaveBeenCalled();
        // bak 指向当前库（self-reference 去重）→ 原地 init + fix
        expect(mocks.databaseMock.initTables).toHaveBeenCalled();
        expect(mocks.databaseMock.runMigrations).toHaveBeenCalledWith(
            0,
            TARGET_DB_VERSION,
            {}
        );
        expect(mocks.configRepoMock.setInt).toHaveBeenCalledWith(
            'VRCX_databaseVersion',
            TARGET_DB_VERSION
        );
        expect(store.state.databaseVersion).toBe(TARGET_DB_VERSION);
    });

    test('collector：v > target → 前瞻警告，无迁移', async () => {
        stubDatabaseVersion(20);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
                `Database version 20 is ahead of built-in target ${TARGET_DB_VERSION}.`
            )
        );
        expect(mocks.databaseMock.runMigrations).not.toHaveBeenCalled();
        expect(store.databaseReadyForAutoLogin).toBe(true);
    });
});

describe('vrcx 运行中自动接管（M3）', () => {
    test('auto 降级 browse 后启动 60s 接管扫描', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        mocks.nodeRegistryMock.detectActiveCollectors.mockResolvedValue([
            {
                nodeId: 'node-other',
                mode: 'collector',
                prefixes: 'usr_a',
                heartbeatAt: new Date().toISOString()
            }
        ]);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        expect(store.state.effectiveNodeMode).toBe('browse');
        expect(mocks.timers.setInterval).toHaveBeenCalledWith(
            expect.any(Function),
            60_000
        );
    });

    test('扫描发现无活跃 collector → 自动接管为 collector 恢复写入', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        mocks.nodeRegistryMock.detectActiveCollectors.mockResolvedValue([]);
        mocks.timers.setInterval.mockImplementation(() => 42);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        // collector 启动，未降级 → 扫描不启动
        expect(store.state.effectiveNodeMode).toBe('collector');
        expect(mocks.timers.setInterval).not.toHaveBeenCalled();
    });

    test('接管扫描：仍有活跃 collector → 保持浏览模式', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        mocks.nodeRegistryMock.detectActiveCollectors.mockResolvedValue([
            {
                nodeId: 'node-other',
                mode: 'collector',
                prefixes: 'usr_a',
                heartbeatAt: new Date().toISOString()
            }
        ]);
        mocks.timers.setInterval.mockImplementation(() => 42);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        // 手动触发扫描：仍检测到 collector → 维持 browse，不升级
        await store.scanForTakeover();

        expect(store.state.effectiveNodeMode).toBe('browse');
        expect(mocks.upgradeToWritable).not.toHaveBeenCalled();
        expect(mocks.nodeRegistryMock.startHeartbeat).not.toHaveBeenCalled();
    });

    test('接管扫描：无活跃 collector → 升级为 collector 恢复写入', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        // 首次检测有 collector → 降级 browse；随后扫描时无 collector
        mocks.nodeRegistryMock.detectActiveCollectors
            .mockResolvedValueOnce([
                {
                    nodeId: 'node-other',
                    mode: 'collector',
                    prefixes: 'usr_a',
                    heartbeatAt: new Date().toISOString()
                }
            ])
            .mockResolvedValueOnce([]);
        mocks.timers.setInterval.mockImplementation(() => 42);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();
        expect(store.state.effectiveNodeMode).toBe('browse');

        await store.scanForTakeover();

        expect(mocks.upgradeToWritable).toHaveBeenCalled();
        expect(store.state.effectiveNodeMode).toBe('collector');
        expect(store.state.browseSource).toBeNull();
        expect(store.state.detectedNodeIds).toEqual([]);
        expect(mocks.nodeRegistryMock.startHeartbeat).toHaveBeenCalledWith(
            'collector'
        );
        expect(logSpy).toHaveBeenCalledWith(
            '[browse] 未检测到活跃 collector，自动接管为 collector（恢复写入）'
        );
    });

    test('接管扫描：检测出错 → 保留浏览模式并告警', async () => {
        vrcxStorageMock = installVrcxStorage('auto');
        mocks.nodeRegistryMock.detectActiveCollectors.mockResolvedValue([
            {
                nodeId: 'node-other',
                mode: 'collector',
                prefixes: 'usr_a',
                heartbeatAt: new Date().toISOString()
            }
        ]);
        mocks.timers.setInterval.mockImplementation(() => 42);

        const store = useVrcxStore();
        await store.waitForDatabaseInit();

        mocks.nodeRegistryMock.detectActiveCollectors.mockRejectedValueOnce(
            new Error('no such table: node_registry')
        );
        await store.scanForTakeover();

        expect(store.state.effectiveNodeMode).toBe('browse');
        expect(mocks.upgradeToWritable).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            '[browse] 接管扫描失败（保留浏览模式）:',
            expect.any(Error)
        );
    });
});
