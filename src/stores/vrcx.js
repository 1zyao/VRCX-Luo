import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';

import {
    DEFAULT_MAX_TABLE_SIZE,
    DEFAULT_SEARCH_LIMIT,
    SEARCH_LIMIT_MAX,
    SEARCH_LIMIT_MIN
} from '../shared/constants';
import { avatarRequest, queryRequest } from '../api';
import { debounce, parseLocation } from '../shared/utils';
import { AppDebug } from '../services/appConfig';
import { database } from '../services/database';
import { refreshCustomScript } from '../shared/utils/base/ui';
import { useAdvancedSettingsStore } from './settings/advanced';
import { useAvatarProviderStore } from './avatarProvider';
import {
    addLocalWorldFavorite,
    addLocalAvatarFavorite
} from '../coordinators/favoriteCoordinator';
import { useFavoriteStore } from './favorite';
import { useGameLogStore } from './gameLog';
import { useGameStore } from './game';
import { showGroupDialog } from '../coordinators/groupCoordinator';
import { showWorldDialog } from '../coordinators/worldCoordinator';
import {
    showAvatarDialog,
    selectAvatarWithConfirmation,
    selectAvatarWithoutConfirmation
} from '../coordinators/avatarCoordinator';
import { showUserDialog, addCustomTag } from '../coordinators/userCoordinator';
import { useLocationStore } from './location';
import { useModalStore } from './modal';
import { useNotificationStore } from './notification';
import { usePhotonStore } from './photon';
import { useSearchStore } from './search';
import { useUpdateLoopStore } from './updateLoop';
import { useUserStore } from './user';
import { useVrcStatusStore } from './vrcStatus';
import { clearVRCXCache } from '../coordinators/vrcxCoordinator';
import { resetSearchIndexOnLogin } from '../coordinators/searchIndexCoordinator';
import { watchState } from '../services/watchState';

import { adapter, createAdapter } from '../services/database/adapter/index.js';
import { normalizeNodeMode } from '../services/database/adapter/readOnlyGate.js';
import configRepository from '../services/config';

// 目标数据库版本
const TARGET_DB_VERSION = 16;

export const useVrcxStore = defineStore('Vrcx', () => {
    const gameStore = useGameStore();
    const locationStore = useLocationStore();
    const notificationStore = useNotificationStore();

    const favoriteStore = useFavoriteStore();
    const userStore = useUserStore();
    const photonStore = usePhotonStore();
    const advancedSettingsStore = useAdvancedSettingsStore();
    const searchStore = useSearchStore();
    const avatarProviderStore = useAvatarProviderStore();
    const gameLogStore = useGameLogStore();
    const updateLoopStore = useUpdateLoopStore();
    const vrcStatusStore = useVrcStatusStore();
    const { t } = useI18n();
    const modalStore = useModalStore();

    const state = reactive({
        databaseVersion: 0,
        locationX: 0,
        locationY: 0,
        sizeWidth: 800,
        sizeHeight: 600,
        windowState: '',
        externalNotifierVersion: 0
    });
    const databaseUpgradeState = ref({
        visible: false,
        fromVersion: 0,
        toVersion: 0,
        // Phase 9 §6.2 — extra fields populated by the SQLite → PgSQL
        // push pipeline (`pushFromSqliteToPgsql` in advanced.js). The
        // DatabaseUpgradeDialog ignores them; they're surfaced here so a
        // future dialog tweak can show per-table progress without changing
        // the ref's shape.
        currentTable: '',
        rowsCopied: 0
    });
    const databaseReadyForAutoLogin = ref(false);
    let resolveDatabaseInit = (..._args) => {};
    const databaseInitComplete = new Promise((resolve) => {
        resolveDatabaseInit = resolve;
    });

    const currentlyDroppingFile = ref(null);
    const isRegistryBackupDialogVisible = ref(false);
    const ipcEnabled = ref(false);
    const clearVRCXCacheFrequency = ref(172800);
    const maxTableSize = ref(DEFAULT_MAX_TABLE_SIZE);
    const searchLimit = ref(DEFAULT_SEARCH_LIMIT);
    const proxyServer = ref('');
    const appStartAt = Date.now();

    /**
     * Pre-login initialization gate.
     *
     * Runs at store creation. Shows a non-cancelable (DatabaseUpgradeDialog) from
     * the very start and keeps it visible until all pre-login work is done —
     * database version upgrade, VRCXStorage init, window state restore, etc.
     *
     * The dialog is hidden in the `finally` block. Any caller that needs to
     * wait for init to complete should await `waitForDatabaseInit()`.
     * `autoLoginAfterMounted()` already does this, so auto-login is naturally
     * blocked until the gate lifts.
     */
    async function init() {
        // BLOCKING GATE: freeze the UI before ANY write-capable operation
        databaseUpgradeState.value = {
            visible: true,
            fromVersion: 0,
            toVersion: 0,
            currentTable: '',
            rowsCopied: 0
        };
        try {
            if (LINUX) {
                try {
                    window.electron.ipcRenderer.on(
                        'launch-command',
                        (command) => {
                            if (command) {
                                eventLaunchCommand(command);
                            }
                        }
                    );

                    window.electron.onWindowPositionChanged(
                        (event, position) => {
                            state.locationX = position.x;
                            state.locationY = position.y;
                            debounce(saveVRCXWindowOption, 300)();
                        }
                    );

                    window.electron.onWindowSizeChanged((event, size) => {
                        state.sizeWidth = size.width;
                        state.sizeHeight = size.height;
                        debounce(saveVRCXWindowOption, 300)();
                    });

                    window.electron.onWindowStateChange((event, newState) => {
                        state.windowState = newState.toString();
                        debounce(saveVRCXWindowOption, 300)();
                    });

                    window.electron.onBrowserFocus(() => {
                        vrcStatusStore.onBrowserFocus();
                    });
                } catch (err) {
                    console.error(
                        'Failed to register Linux IPC handlers:',
                        err
                    );
                }
            }

            state.databaseVersion = await configRepository.getInt(
                'VRCX_databaseVersion',
                0
            );

            // ── 浏览模式旁路（BROWSE_MODE_M1_DESIGN.md §2.4 / §4.4）───
            // browse 模式跳过整个升级决策树（Branch A/B）：只读连接无法
            // 执行 runMigrations / initTables，版本号归 collector 维护。
            // 改为 schema 探测 + 启动日志三连，随后继续启动（configs 表
            // 缺失时 configRepository 走降级读，不崩溃）。
            const nodeMode = normalizeNodeMode(
                await VRCXStorage.Get('VRCX_NodeMode')
            );
            if (nodeMode === 'browse') {
                // schema 探测：listTables 是读操作，只读门禁下透传。
                // 探测失败不阻断启动（fail-safe，同 §4.4「不崩溃」语义）。
                let configsTableExists = false;
                try {
                    const configsTables = await adapter.listTables('configs');
                    configsTableExists =
                        Array.isArray(configsTables) &&
                        configsTables.length > 0;
                } catch (err) {
                    console.warn(
                        '[browse] schema 探测失败:',
                        err instanceof Error ? err.message : String(err)
                    );
                }
                console.log(
                    '[browse] 浏览模式（只读）已启用：VRCX_NodeMode=browse'
                );
                console.log(
                    `[browse] 数据库版本：${state.databaseVersion}（目标 ${TARGET_DB_VERSION}）；` +
                        `schema 探测：configs 表${configsTableExists ? '存在' : '缺失'}`
                );
                if (state.databaseVersion === 0) {
                    console.warn(
                        '[browse] 数据库版本未知（空库或从未初始化）。'
                    );
                } else if (state.databaseVersion < TARGET_DB_VERSION) {
                    console.warn(
                        `[browse] 库版本 ${state.databaseVersion} 低于当前 ${TARGET_DB_VERSION}，` +
                            '浏览模式不执行升级；schema 可能不兼容，部分查询可能失败。' +
                            '建议以 collector 模式启动一次完成升级。'
                    );
                }
                console.log(
                    '[browse] 只读：DB 写入被门禁丢弃；登录状态与本地设置不会持久化；建议单实例多账号'
                );
            } else if (state.databaseVersion > 0) {
                // ── Branch A: 已有版本号的数据库 ──
                if (state.databaseVersion < TARGET_DB_VERSION) {
                    const ok = await upgradeInPlace(
                        state.databaseVersion,
                        TARGET_DB_VERSION
                    );
                    if (!ok) return;
                } else if (state.databaseVersion > TARGET_DB_VERSION) {
                    console.warn(
                        `Database version ${state.databaseVersion} is ahead of built-in target ${TARGET_DB_VERSION}. ` +
                            'Data written by a newer VRCX version may not be fully compatible.'
                    );
                }
                // == target: 无事可做
            } else {
                // ── Branch B: version <= 0 / null（版本丢失或全新库）──
                const ok = await handleUninitializedDatabase(TARGET_DB_VERSION);
                if (!ok) return;
            }

            clearVRCXCacheFrequency.value = await configRepository.getInt(
                'VRCX_clearVRCXCacheFrequency',
                172800
            );

            if (!(await VRCXStorage.Get('VRCX_ProxyServer'))) {
                await VRCXStorage.Set('VRCX_ProxyServer', '');
            }
            if ((await VRCXStorage.Get('VRCX_DisableGpuAcceleration')) === '') {
                await VRCXStorage.Set('VRCX_DisableGpuAcceleration', 'false');
            }
            if (
                (await VRCXStorage.Get(
                    'VRCX_DisableVrOverlayGpuAcceleration'
                )) === ''
            ) {
                await VRCXStorage.Set(
                    'VRCX_DisableVrOverlayGpuAcceleration',
                    'false'
                );
            }
            proxyServer.value = await VRCXStorage.Get('VRCX_ProxyServer');
            state.locationX = parseInt(
                await VRCXStorage.Get('VRCX_LocationX'),
                10
            );
            state.locationY = parseInt(
                await VRCXStorage.Get('VRCX_LocationY'),
                10
            );
            state.sizeWidth = parseInt(
                await VRCXStorage.Get('VRCX_SizeWidth'),
                10
            );
            state.sizeHeight = parseInt(
                await VRCXStorage.Get('VRCX_SizeHeight'),
                10
            );
            state.windowState = await VRCXStorage.Get('VRCX_WindowState');

            maxTableSize.value = await configRepository.getInt(
                'VRCX_maxTableSize_v2',
                DEFAULT_MAX_TABLE_SIZE
            );
            database.setMaxTableSize(maxTableSize.value);

            searchLimit.value = await configRepository.getInt(
                'VRCX_searchLimit',
                DEFAULT_SEARCH_LIMIT
            );
            if (searchLimit.value < SEARCH_LIMIT_MIN) {
                searchLimit.value = SEARCH_LIMIT_MIN;
            }
            if (searchLimit.value > SEARCH_LIMIT_MAX) {
                searchLimit.value = SEARCH_LIMIT_MAX;
            }
            database.setSearchTableSize(searchLimit.value);

            refreshCustomScript();
            databaseReadyForAutoLogin.value = true;
        } finally {
            // Lift the gate: hide dialog, signal waiters
            databaseUpgradeState.value = {
                visible: false,
                fromVersion: 0,
                toVersion: 0,
                currentTable: '',
                rowsCopied: 0
            };
            resolveDatabaseInit();
        }
    }

    resetSearchIndexOnLogin();
    init();

    // ── 内部 Helper ─────────────────────────────────────────────────

    /**
     * 运行所有数据修复和 schema 变更操作。
     * 委托给声明式 .map 迁移系统；操作幂等，可安全重复执行。
     * @param {number} targetVersion
     * @param {object} [options] - 透传给 runMigrations（如 { oldDb }）
     */
    async function runFixes(targetVersion, options = {}) {
        await database.runMigrations(
            state.databaseVersion,
            targetVersion,
            options
        );
    }

    /**
     * 分支 A: 原地升级 —— 当前 DB 版本 > 0 且 < target。
     *
     * @param {number} fromVersion
     * @param {number} targetVersion
     * @returns {Promise<boolean>}
     */
    async function upgradeInPlace(fromVersion, targetVersion) {
        databaseUpgradeState.value.fromVersion = fromVersion;
        databaseUpgradeState.value.toVersion = targetVersion;
        console.log(`升级数据库从 ${fromVersion} 到 ${targetVersion}...`);
        try {
            await runFixes(targetVersion);
            await configRepository.setInt(
                'VRCX_databaseVersion',
                targetVersion
            );
            console.log('数据库升级完成。');
            state.databaseVersion = targetVersion;
            databaseUpgradeState.value.visible = false;
        } catch (err) {
            console.error(err);
            databaseUpgradeState.value.visible = false;
            await modalStore.alert({
                title: t('message.database.upgrade_failed_title'),
                description: t('message.database.upgrade_failed_description'),
                dismissible: false
            });
            AppApi.ShowDevTools();
            return false;
        }
        return true;
    }

    /**
     * 分支 B: version == 0 / null —— 尝试从 .bak 恢复。
     *
     * @param {number} targetVersion
     * @returns {Promise<boolean>}
     */
    async function handleUninitializedDatabase(targetVersion) {
        let bakConfig = null;
        try {
            const bakJson = await VRCXStorage.GetBackup();
            if (bakJson && bakJson !== '{}') {
                bakConfig = JSON.parse(bakJson);
            }
        } catch (err) {
            console.warn('Failed to read backup config:', err);
        }

        const bakDbName =
            bakConfig?.['VRCX_Database.name'] ||
            bakConfig?.['VRCX_DatabaseLocation'];
        const currentDbName = await VRCXStorage.Get('VRCX_Database.name');

        // Resolve both names to canonical paths for robust identity comparison.
        // Wrapped in try/catch because ResolveDatabaseName now validates paths
        // (traversal, null bytes, etc.) and may throw InvalidOperationException.
        // On validation failure, fall back to in-place init.
        let bakIdentity, currentIdentity;
        try {
            [bakIdentity, currentIdentity] = await Promise.all([
                AppApi.ResolveDatabaseName(bakDbName || ''),
                AppApi.ResolveDatabaseName(currentDbName || '')
            ]);
        } catch (err) {
            console.warn(
                'Path validation failed for database name — falling back to in-place init:',
                err.message || String(err)
            );
            return await initAndFixInPlace(targetVersion);
        }

        // ── Self-reference 去重 ──
        // Both paths are now canonicalized via ValidateAndCanonicalizeDatabasePath
        // (Path.GetFullPath + boundary checks), so string equality reliably
        // detects the same database file regardless of path form.
        // bak 指向当前已连上的数据库 → 环境不可信 → 跳过 bak
        if (bakDbName && bakIdentity === currentIdentity) {
            console.warn(
                'Backup refers to the current database file — environment untrustworthy. ' +
                    'Falling back to in-place init + fix.'
            );
            return await initAndFixInPlace(targetVersion);
        }

        // ── bak 指向不同的旧库 → 搬迁迁移 ──
        if (bakDbName && bakIdentity !== currentIdentity) {
            return await migrateFromOldDb(bakIdentity, targetVersion);
        }

        // ── 无 bak / 无 DB 配置 → 当前库 init + fix ──
        return await initAndFixInPlace(targetVersion);
    }

    /**
     * 在当前库上 init（补表）+ fix（修数据）+ 设版本。
     * 适用于全新安装、bak 为空、或 self-reference 去重后。
     */
    async function initAndFixInPlace(targetVersion) {
        console.log('未找到有效的备份配置。正在原地初始化 + 修复...');
        databaseUpgradeState.value.fromVersion = 0;
        databaseUpgradeState.value.toVersion = targetVersion;

        try {
            await database.initTables();
            await runFixes(targetVersion);
            await configRepository.setInt(
                'VRCX_databaseVersion',
                targetVersion
            );
            state.databaseVersion = targetVersion;
            console.log('数据库初始化 + 修复完成。');
        } catch (err) {
            console.error('数据库初始化 + 修复失败:', err);
            await modalStore.alert({
                title: t('message.database.repair_failed_title'),
                description: t('message.database.repair_failed_description', {
                    error: err.message || String(err)
                }),
                dismissible: false
            });
            return false;
        }
        return true;
    }

    /**
     * 从 bak 指定的旧库搬迁到当前（新）库。
     * 旧库以只读方式打开，全部写只发生在当前连接上。
     *
     * @param {string} oldPath
     * @param {number} targetVersion
     * @returns {Promise<boolean>}
     */
    async function migrateFromOldDb(oldPath, targetVersion) {
        console.log(`正在从旧数据库迁移数据: ${oldPath}`);
        databaseUpgradeState.value.fromVersion = -1; // 标记「迁移中」
        databaseUpgradeState.value.toVersion = targetVersion;

        const oldDb = await createAdapter({
            connection: `sqlite:///${oldPath}`
        });

        try {
            // 1) 读出旧库版本号
            const versionRows = [];
            await oldDb.execute(
                (row) => versionRows.push(row),
                'SELECT value FROM configs WHERE key = @key',
                { key: 'config:VRCX_databaseversion' }
            );
            const oldVersion =
                versionRows && versionRows.length > 0
                    ? parseInt(versionRows[0][0], 10)
                    : 0;

            const oldIsAhead = oldVersion > targetVersion;
            if (oldIsAhead) {
                console.warn(
                    `旧数据库版本 ${oldVersion} 高于目标版本 ${targetVersion}。` +
                        '将按原样复制数据，部分功能可能行为异常。'
                );
            }

            // 2) 确保新库有完整的表结构
            await database.initTables();

            // 3) 枚举旧库所有表及其列信息，搬运数据
            const tables = await oldDb.listTablesTypes();

            for (const { tableName, columns } of tables) {
                await copyTableData(oldDb, tableName, columns);
            }

            // 4) 对新库跑迁移/修复
            await runFixes(targetVersion, { oldDb });

            // 5) 设版本号 — 保留旧库和目标版本中的较高值，避免降级
            const finalVersion = Math.max(oldVersion, targetVersion);
            await configRepository.setInt('VRCX_databaseVersion', finalVersion);
            state.databaseVersion = finalVersion;
            console.log('数据库迁移完成。');
            return true;
        } catch (err) {
            console.error('数据库迁移失败:', err);
            await modalStore.alert({
                title: t('message.database.repair_failed_title'),
                description: t('message.database.repair_failed_description', {
                    error: err.message || String(err)
                }),
                dismissible: false
            });
            AppApi.ShowDevTools();
            return false;
        }
    }

    /**
     * 通过只读连接从旧库读出一个表的所有数据，写入当前库。
     * 使用 INSERT OR IGNORE 跳过主键冲突的行。
     */
    async function copyTableData(oldDb, tableName, columns) {
        const visibleColumns = columns.filter((c) => !c.isHidden);
        if (visibleColumns.length === 0) return;

        const colList = visibleColumns.map((c) => c.name).join(', ');

        const dataRows = [];
        await oldDb.execute(
            (row) => dataRows.push(row),
            `SELECT ${colList} FROM "${tableName}"`
        );
        if (!dataRows || dataRows.length === 0) return;

        const rowsAsObjects = dataRows.map((row) => {
            const obj = {};
            visibleColumns.forEach((col, i) => {
                // DBNull 经 C# 封送为 undefined,兜底为 null 保证参数对象
                // 无 undefined 值(源恒 SQLite,列名无需转义)。
                obj[col.name] = row[i] ?? null;
            });
            return obj;
        });

        await adapter.bulkInsert(tableName, rowsAsObjects, 'ignore');
    }

    async function waitForDatabaseInit() {
        await databaseInitComplete;
        return databaseReadyForAutoLogin.value;
    }

    /**
     * @param {string} value
     */
    function setProxyServer(value) {
        proxyServer.value = value;
    }

    /**
     * @param {boolean} value
     */
    function setIpcEnabled(value) {
        ipcEnabled.value = value;
    }

    /**
     * @param {number} value
     */
    function setClearVRCXCacheFrequency(value) {
        clearVRCXCacheFrequency.value = value;
    }

    /**
     * @param {number} value
     */
    function setMaxTableSize(value) {
        maxTableSize.value = value;
    }

    /**
     * @param {number} value
     */
    function setSearchLimit(value) {
        searchLimit.value = value;
    }

    /**
     *
     * @param data
     */
    function eventVrcxMessage(data) {
        let entry;
        switch (data.MsgType) {
            case 'CustomTag':
                addCustomTag(data);
                break;
            case 'ClearCustomTags':
                userStore.customUserTags.forEach((value, key) => {
                    userStore.customUserTags.delete(key);
                    const ref = userStore.cachedUsers.get(key);
                    if (typeof ref !== 'undefined') {
                        ref.$customTag = '';
                        ref.$customTagColour = '';
                    }
                });
                break;
            case 'Noty':
                if (
                    photonStore.photonLoggingEnabled ||
                    (state.externalNotifierVersion &&
                        state.externalNotifierVersion > 21)
                ) {
                    return;
                }
                entry = {
                    created_at: new Date().toJSON(),
                    type: 'Event',
                    data: data.Data
                };
                database.addGamelogEventToDatabase(entry);
                notificationStore.queueGameLogNoty(entry);
                gameLogStore.addGameLog(entry);
                break;
            case 'External': {
                const displayName = data.DisplayName ?? '';
                const notify = data.notify ?? true;
                entry = {
                    created_at: new Date().toJSON(),
                    type: 'External',
                    message: data.Data,
                    displayName,
                    userId: data.UserId,
                    location: locationStore.lastLocation.location
                };
                database.addGamelogExternalToDatabase(entry);
                if (notify) {
                    notificationStore.queueGameLogNoty(entry);
                }
                gameLogStore.addGameLog(entry);
                break;
            }
            default:
                console.log('VRCXMessage:', data);
                break;
        }
    }

    /**
     *
     */
    async function saveVRCXWindowOption() {
        if (LINUX) {
            VRCXStorage.Set('VRCX_LocationX', state.locationX.toString());
            VRCXStorage.Set('VRCX_LocationY', state.locationY.toString());
            VRCXStorage.Set('VRCX_SizeWidth', state.sizeWidth.toString());
            VRCXStorage.Set('VRCX_SizeHeight', state.sizeHeight.toString());
            VRCXStorage.Set('VRCX_WindowState', state.windowState);
        }
    }

    /**
     *
     * @param path
     */
    async function processScreenshot(path) {
        let newPath = path;
        if (advancedSettingsStore.screenshotHelper) {
            const location = parseLocation(locationStore.lastLocation.location);
            const metadata = {
                application: 'VRCX',
                version: 1,
                author: {
                    id: userStore.currentUser.id,
                    displayName: userStore.currentUser.displayName
                },
                world: {
                    name: locationStore.lastLocation.name,
                    id: location.worldId,
                    instanceId: locationStore.lastLocation.location
                },
                players: []
            };
            for (const user of locationStore.lastLocation.playerList.values()) {
                metadata.players.push({
                    id: user.userId,
                    displayName: user.displayName
                });
            }
            try {
                newPath = await AppApi.AddScreenshotMetadata(
                    path,
                    JSON.stringify(metadata),
                    location.worldId,
                    advancedSettingsStore.screenshotHelperModifyFilename
                );
            } catch (e) {
                console.error('Failed to add screenshot metadata', e);
                if (e.message?.includes('UnauthorizedAccessException')) {
                    toast.error(
                        'Failed to add screenshot metadata, access denied. Make sure VRCX has permission to access the screenshot folder.',
                        { duration: 10000 }
                    );
                }
                return;
            }
            if (!newPath) {
                console.error('Failed to add screenshot metadata', path);
                return;
            }
            console.log('Screenshot metadata added', newPath);
        }
        if (advancedSettingsStore.screenshotHelperCopyToClipboard) {
            await AppApi.CopyImageToClipboard(newPath);
            console.log('Screenshot copied to clipboard', newPath);
        }
    }

    // use in C# side
    /**
     *
     * @param json
     */
    function ipcEvent(json) {
        if (!watchState.isLoggedIn) {
            return;
        }
        let data;
        try {
            data = JSON.parse(json);
        } catch {
            console.log(`IPC invalid JSON, ${json}`);
            return;
        }

        switch (data.type) {
            case 'OnEvent':
                if (!gameStore.isGameRunning) {
                    console.log('Game closed, skipped event', data);
                    return;
                }
                if (AppDebug.debugPhotonLogging || AppDebug.debugIPC) {
                    console.log(
                        'OnEvent',
                        data.OnEventData.Code,
                        'Param[254]:',
                        data.OnEventData.Parameters?.[254],
                        data.OnEventData
                    );
                }
                photonStore.parsePhotonEvent(data.OnEventData, data.dt);
                photonStore.photonEventPulse();
                break;
            case 'OnOperationResponse':
                if (!gameStore.isGameRunning) {
                    console.log('Game closed, skipped event', data);
                    return;
                }
                if (AppDebug.debugPhotonLogging || AppDebug.debugIPC) {
                    console.log(
                        'OnOperationResponse',
                        data.OnOperationResponseData.OperationCode,
                        'Param[254]:',
                        data.OnOperationResponseData.Parameters?.[254],
                        data.OnOperationResponseData
                    );
                }
                photonStore.parseOperationResponse(
                    data.OnOperationResponseData,
                    data.dt
                );
                photonStore.photonEventPulse();
                break;
            case 'OnOperationRequest':
                if (!gameStore.isGameRunning) {
                    console.log('Game closed, skipped event', data);
                    return;
                }
                if (AppDebug.debugPhotonLogging || AppDebug.debugIPC) {
                    console.log(
                        'OnOperationRequest',
                        data.OnOperationRequestData.OperationCode,
                        data.OnOperationRequestData
                    );
                }
                break;
            case 'VRCEvent':
                if (!gameStore.isGameRunning) {
                    console.log('Game closed, skipped event', data);
                    return;
                }
                if (AppDebug.debugIPC) {
                    console.log('VRCEvent:', data);
                }
                photonStore.parseVRCEvent(data);
                photonStore.photonEventPulse();
                break;
            case 'Event7List':
                if (AppDebug.debugIPC) {
                    console.log('Event7List:', data);
                }
                photonStore.photonEvent7List.clear();
                for (const [id, dt] of Object.entries(data.Event7List)) {
                    photonStore.photonEvent7List.set(parseInt(id, 10), dt);
                }
                photonStore.setPhotonLastEvent7List(Date.parse(data.dt));
                break;
            case 'VrcxMessage':
                if (AppDebug.debugPhotonLogging || AppDebug.debugIPC) {
                    console.log('VrcxMessage:', data);
                }
                eventVrcxMessage(data);
                break;
            case 'Ping':
                if (AppDebug.debugIPC) {
                    console.log('IPC Ping');
                }
                if (!photonStore.photonLoggingEnabled) {
                    photonStore.setPhotonLoggingEnabled();
                }
                ipcEnabled.value = true;
                updateLoopStore.setIpcTimeout(60); // 30 seconds
                break;
            case 'MsgPing':
                if (AppDebug.debugIPC) {
                    console.log('MsgPing:', data);
                }
                state.externalNotifierVersion = data.version;
                break;
            case 'LaunchCommand':
                eventLaunchCommand(data.command);
                break;
            case 'VRCXLaunch':
                console.log('VRCXLaunch:', data);
                break;
            default:
                console.log('IPC:', data);
        }
    }

    /**
     * This function is called by .NET(CefCustomDragHandler#CefCustomDragHandler) when a file is dragged over a drop zone in the app window.
     * @param {string} filePath - The full path to the file being dragged into the window
     */
    function dragEnterCef(filePath) {
        currentlyDroppingFile.value = filePath;
    }

    watch(
        () => watchState.isLoggedIn,
        (isLoggedIn) => {
            isRegistryBackupDialogVisible.value = false;
            if (isLoggedIn) {
                startupLaunchCommand();
            }
        },
        { flush: 'sync' }
    );

    /**
     *
     */
    async function startupLaunchCommand() {
        const command = await AppApi.GetLaunchCommand();
        if (!command) {
            return;
        }
        if (command.startsWith('crash/')) {
            const crashMessage = command.replace('crash/', '');
            console.error('VRCX recovered from crash:', crashMessage);

            if (advancedSettingsStore.sentryErrorReporting) {
                try {
                    import('@sentry/vue').then((Sentry) => {
                        Sentry.withScope((scope) => {
                            scope.setLevel('fatal');
                            scope.setTag('reason', 'crash-recovery');
                            scope.setContext('session', {
                                sessionTime: performance.now() / 1000 / 60
                            });
                            Sentry.captureMessage(
                                `crash message: ${crashMessage}`
                            );
                        });
                    });
                } catch (error) {
                    console.error('Error setting up Sentry feedback:', error);
                }
            }

            toast.success(t('message.crash.vrcx_reload'));
            return;
        }
        eventLaunchCommand(command);
    }

    // called from C#
    /**
     *
     * @param input
     */
    function eventLaunchCommand(input) {
        if (!watchState.isLoggedIn) {
            return;
        }
        console.log('LaunchCommand:', input);
        const args = input.split('/');
        const command = args[0];
        const commandArg = args[1]?.trim();
        let shouldFocusWindow = true;
        switch (command) {
            case 'world':
                if (
                    !searchStore.directAccessWorld(input.replace('world/', ''))
                ) {
                    // fallback for mangled world ids
                    showWorldDialog(commandArg);
                }
                break;
            case 'avatar':
                showAvatarDialog(commandArg);
                break;
            case 'user':
                showUserDialog(commandArg);
                break;
            case 'group':
                showGroupDialog(commandArg);
                break;
            case 'local-favorite-world':
                console.log('local-favorite-world', commandArg);
                const [id, group] = commandArg.split(':');
                if (!id || !group) {
                    toast.error('Invalid local favorite world command');
                    break;
                }
                queryRequest
                    .fetch('world.location', { worldId: id })
                    .then(() => {
                        searchStore.directAccessWorld(id);
                        addLocalWorldFavorite(id, group);
                    });
                break;
            case 'local-favorite-avatar':
                console.log('local-favorite-avatar', commandArg);
                const [avatarIdFav, avatarGroup] = commandArg.split(':');
                if (!avatarIdFav || !avatarGroup) {
                    toast.error('Invalid local favorite avatar command');
                    break;
                }
                avatarRequest.getAvatar({ avatarId: avatarIdFav }).then(() => {
                    showAvatarDialog(avatarIdFav);
                    addLocalAvatarFavorite(avatarIdFav, avatarGroup);
                });
                break;
            case 'addavatardb':
                avatarProviderStore.addAvatarProvider(
                    input.replace('addavatardb/', '')
                );
                break;
            case 'switchavatar':
                const avatarId = commandArg;
                const regexAvatarId =
                    /avtr_[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}/g;
                if (!avatarId.match(regexAvatarId) || avatarId.length !== 41) {
                    toast.error('Invalid Avatar ID');
                    break;
                }
                if (advancedSettingsStore.showConfirmationOnSwitchAvatar) {
                    selectAvatarWithConfirmation(avatarId);
                    // Makes sure the window is focused
                    shouldFocusWindow = true;
                } else {
                    selectAvatarWithoutConfirmation(avatarId).then(() => {
                        toast.success('Avatar changed via launch command');
                    });
                    shouldFocusWindow = false;
                }
                break;
            case 'import':
                const type = args[1];
                if (!type) break;
                const data = input.replace(`import/${type}/`, '');
                if (type === 'avatar') {
                    favoriteStore.setAvatarImportDialogInput(data);
                    favoriteStore.showAvatarImportDialog();
                } else if (type === 'world') {
                    favoriteStore.setWorldImportDialogInput(data);
                    favoriteStore.showWorldImportDialog();
                } else if (type === 'friend') {
                    favoriteStore.setFriendImportDialogInput(data);
                    favoriteStore.showFriendImportDialog();
                }
                break;
        }
        if (shouldFocusWindow) {
            AppApi.FocusWindow();
        }
    }

    /**
     *
     * @param name
     */
    async function backupVrcRegistry(name) {
        let regJson;
        try {
            if (WINDOWS) {
                regJson = await AppApi.GetVRChatRegistry();
            } else {
                regJson = await AppApi.GetVRChatRegistryJson();
                regJson = JSON.parse(regJson);
            }
        } catch (e) {
            console.error('Failed to get VRChat registry for backup:', e);
            return;
        }
        const newBackup = {
            name,
            date: new Date().toJSON(),
            data: regJson
        };
        let backupsJson = await configRepository.getString(
            'VRCX_VRChatRegistryBackups'
        );
        if (!backupsJson) {
            backupsJson = JSON.stringify([]);
        }
        const backups = JSON.parse(backupsJson);
        backups.push(newBackup);
        await configRepository.setString(
            'VRCX_VRChatRegistryBackups',
            JSON.stringify(backups)
        );
        // await this.updateRegistryBackupDialog();
    }

    /**
     *
     */
    async function checkAutoBackupRestoreVrcRegistry() {
        if (
            !advancedSettingsStore.vrcRegistryAutoBackup ||
            !advancedSettingsStore.vrcRegistryAskRestore
        ) {
            return;
        }

        // check for auto restore
        const hasVRChatRegistryFolder = await AppApi.HasVRChatRegistryFolder();
        if (!hasVRChatRegistryFolder) {
            const lastBackupDate = await configRepository.getString(
                'VRCX_VRChatRegistryLastBackupDate'
            );
            const lastRestoreCheck = await configRepository.getString(
                'VRCX_VRChatRegistryLastRestoreCheck'
            );
            if (
                !lastBackupDate ||
                (lastRestoreCheck &&
                    lastBackupDate &&
                    lastRestoreCheck === lastBackupDate)
            ) {
                // only ask to restore once and when backup is present
                return;
            }
            // popup message about auto restore
            modalStore.alert({
                description: t('dialog.registry_backup.restore_prompt'),
                title: t('dialog.registry_backup.header')
            });
            showRegistryBackupDialog();
            await AppApi.FocusWindow();
            await configRepository.setString(
                'VRCX_VRChatRegistryLastRestoreCheck',
                lastBackupDate
            );
        } else {
            await tryAutoBackupVrcRegistry();
        }
    }

    /**
     *
     */
    function showRegistryBackupDialog() {
        isRegistryBackupDialogVisible.value = true;
    }

    /**
     *
     */
    async function tryAutoBackupVrcRegistry() {
        if (!advancedSettingsStore.vrcRegistryAutoBackup) {
            return;
        }
        const date = new Date();
        const lastBackupDate = await configRepository.getString(
            'VRCX_VRChatRegistryLastBackupDate'
        );
        if (lastBackupDate) {
            const lastBackup = new Date(lastBackupDate);
            const diff = date.getTime() - lastBackup.getTime();
            const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (diffDays < 3) {
                return;
            }
        }
        let backupsJson = await configRepository.getString(
            'VRCX_VRChatRegistryBackups'
        );
        if (!backupsJson) {
            backupsJson = JSON.stringify([]);
        }
        const backups = JSON.parse(backupsJson);
        for (let i = backups.length - 1; i >= 0; i--) {
            const backupDate = new Date(backups[i].date);
            // remove backups older than 2 weeks
            if (
                backups[i].name === 'Auto Backup' &&
                backupDate.getTime() < date.getTime() - 1209600000 // 2 weeks in milliseconds
            ) {
                backups.splice(i, 1);
            }
        }
        await configRepository.setString(
            'VRCX_VRChatRegistryBackups',
            JSON.stringify(backups)
        );
        backupVrcRegistry('Auto Backup');
        await configRepository.setString(
            'VRCX_VRChatRegistryLastBackupDate',
            date.toJSON()
        );
    }

    return {
        state,

        appStartAt,
        databaseUpgradeState,
        databaseReadyForAutoLogin,
        proxyServer,
        setProxyServer,
        setIpcEnabled,
        setClearVRCXCacheFrequency,
        setMaxTableSize,
        setSearchLimit,
        currentlyDroppingFile,
        isRegistryBackupDialogVisible,
        ipcEnabled,
        clearVRCXCacheFrequency,
        maxTableSize,
        searchLimit,
        clearVRCXCache,
        eventVrcxMessage,
        eventLaunchCommand,
        showRegistryBackupDialog,
        checkAutoBackupRestoreVrcRegistry,
        tryAutoBackupVrcRegistry,
        processScreenshot,
        ipcEvent,
        dragEnterCef,
        backupVrcRegistry,
        upgradeInPlace,
        waitForDatabaseInit
    };
});
