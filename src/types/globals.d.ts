/// <reference types="node" />
/// <reference types="jest" />

declare global {
    const VERSION: string;
    const NIGHTLY: boolean;

    const WINDOWS: boolean;
    const LINUX: boolean;

    interface Window {
        $pinia: any;
        $vr: any;
        $debug: AppDebug;
        AppApi: AppApi;
        AppApiVr: AppApiVr;
        WebApi: WebApi;
        VRCXStorage: VRCXStorage;
        SQLite: SQLite;
        PostgreSQL: PostgreSQL;
        LogWatcher: LogWatcher;
        Discord: Discord;
        AssetBundleManager: AssetBundleManager;
        webApiService: webApiService;
        request: any;
        utils: any;
        dayjs: any;
        configRepository: any;
        database: any;
        gameLogService: any;
        crypto: any;
        isVrOverlay: boolean;
        interopApi: {
            callDotNetMethod: (
                className: any,
                methodName: any,
                args: any
            ) => Promise<any>;
        };
        electron: {
            getArch: () => Promise<string>;
            getClipboardText: () => Promise<string>;
            getNoUpdater: () => Promise<boolean>;
            setTrayIconNotification: (notify: boolean) => Promise<void>;
            setDesktopNotificationsEnabled: (enabled: boolean) => Promise<void>;
            setTraySilentMode: (enabled: boolean) => Promise<void>;
            setVSleepMode: (enabled: boolean) => Promise<void>;
            onDesktopNotificationsUpdated: (
                callback: (enabled: boolean) => void
            ) => () => void;
            onTraySilentModeUpdated: (
                callback: (enabled: boolean) => void
            ) => () => void;
            onVSleepModeUpdated: (
                callback: (enabled: boolean) => void
            ) => () => void;
            openFileDialog: (
                filters?: Array<{ name: string; extensions: string[] }>
            ) => Promise<string>;
            openDirectoryDialog: () => Promise<string>;
            saveFileDialog: (
                defaultPath?: string,
                filters?: Array<{ name: string; extensions: string[] }>
            ) => Promise<string>;
            desktopNotification: (
                displayName: string,
                body?: string,
                image?: string,
                silent?: boolean
            ) => Promise<void>;
            onWindowPositionChanged: (
                Function: (
                    event: any,
                    position: { x: number; y: number }
                ) => void
            ) => () => void;
            onWindowSizeChanged: (
                Function: (
                    event: any,
                    size: { width: number; height: number }
                ) => void
            ) => () => void;
            onWindowStateChange: (
                Function: (event: any, state: { windowState: any }) => void
            ) => () => void;
            onBrowserFocus: (Function: (event: any) => void) => () => void;
            onDbChange: (callback: (payload: string) => void) => () => void;
            restartApp: () => Promise<void>;
            getOverlayWindow: () => Promise<boolean>;
            updateVr: (
                active: boolean,
                hmdOverlay: boolean,
                wristOverlay: boolean,
                menuButton: boolean,
                overlayHand: number
            ) => Promise<void>;
            ipcRenderer: {
                on(
                    channel: String,
                    func: (...args: unknown[]) => void
                ): (() => void) | undefined;
            };
        };
    }

    interface AppDebug {
        debug: boolean;
        debugWebSocket: boolean;
        debugUserDiff: boolean;
        debugPhotonLogging: boolean;
        debugGameLog: boolean;
        debugWebRequests: boolean;
        debugFriendState: boolean;
        debugRecompute: boolean;
        debugIPC: boolean;
        debugVrcPlus: boolean;
        errorNoty: any;
        dontLogMeOut: boolean;
        endpointDomain: string;
        endpointDomainVrchat: string;
        websocketDomain: string;
        websocketDomainVrchat: string;
    }

    const CefSharp: {
        PostMessage: (message: any) => void;
        BindObjectAsync: (...args: string[]) => Promise<any>;
        BindObject: (name: string) => any;
        ExecuteScriptAsync: (script: string) => Promise<any>;
        ExecuteScript: (script: string) => any;
        RemoveObjectFromCache?: (name: string) => void;
        DeleteBoundObject?: (name: string) => void;
    };

    const VRCXStorage: {
        Get(key: string): Promise<string>;
        Set(key: string, value: string): Promise<void>;
        Remove(key: string): Promise<void>;
        GetAll(): Promise<string>;
        Flush(): Promise<void>;
        Save(): Promise<void>;
        Load(): Promise<void>;
        Backup(): Promise<void>;
        GetBackup(): Promise<string>;
        GetArray(key: string): Promise<any[]>;
        SetArray(key: string, value: any[]): Promise<void>;
        GetObject(key: string): Promise<object>;
        SetObject(key: string, value: object): Promise<void>;
    };

    const SQLite: {
        Execute: (sql: string, args: any, connId?: number) => Promise<any[]>;
        ExecuteJson: (...args: any[]) => Promise<string>;
        ExecuteNonQuery: (...args: any[]) => Promise<number>;
        ExecuteJsonOnConnection: (connectionString: string, sql: string, args?: any, connId?: number) => Promise<string>;
        ExecuteNonQueryOnConnection: (connectionString: string, sql: string, args?: any, connId?: number) => Promise<number>;
        BeginTransaction: () => number;
        /**
         * Begin a transaction on an external database file (specified by
         * connectionString) and return a connId. Used by pullEngine's dstAdapter
         * (constructed with a connectionString) so that withTransaction bodies
         * route writes to the target file atomically. The connId enters the same
         * _pinned Map; ExecutePinned/Commit/Rollback route by connId to h.Conn
         * (the target connection), independent of the singleton _connectionString.
         */
        BeginTransactionOnConnection: (connectionString: string) => number;
        CommitTransaction: (connId: number) => void;
        RollbackTransaction: (connId: number) => void;
        /**
         * Reset the sliding idle timer for the transaction pinned to connId
         * without executing any SQL. Returns true if the timer was reset,
         * false if the connId has already timed out / rolled back (no-op).
         */
        KeepAliveTransaction: (connId: number) => boolean;
        /**
         * Returns a JSON snapshot of connection pool three-state metrics:
         * { active, pinnedIdle, availableCapacity, max, totalOpen, idleInPool }.
         * Pure in-memory counter read, no network call. Sampled once per
         * second by StatusBar (Issue #14).
         * totalOpen/idleInPool are extended fields: PG reflects
         * PoolingDataSource.Statistics for true values; MySQL/SQLite
         * estimate from base fields. UI prefers C#-provided extended fields
         * with fallback to base-field computation when absent.
         */
        GetPoolStats: () => Promise<string>;
        /**
         * Clear idle connections from the pool. Busy connections (active /
         * pinned) are unaffected on SQLite/MySQL; Npgsql's Clear() also
         * marks busy connections to close on return (see C# docs).
         */
        ClearIdleConnections: () => Promise<void>;
        /**
         * Returns true when the backend has been initialised. Does not
         * probe the file system — a true return does not guarantee the
         * database file is accessible. Prefer `Ping` for a real liveness
         * check.
         */
        IsConnected: () => Promise<boolean>;
        /**
         * Lightweight liveness probe: executes `SELECT 1` against the pool.
         * Returns true on success, false on failure.
         */
        Ping: () => Promise<boolean>;
        /**
         * Probe with `SELECT 1` and return a JSON health snapshot:
         * `{ connected, latencyMs, lastHealthCheck }`.
         */
        GetHealth: () => Promise<string>;
        /**
         * F7:主库专用观察连接的 data_version,与漏斗事件 dv 同源(非写者
         * 视角);未初始化/失败返回 null。旧桥无此方法 → JS 回退池连接
         * PRAGMA data_version。
         */
        GetDataVersion: () => Promise<number | null>;
        /**
         * 变更通知门控——JS 侧在首个 onTableChange 订阅时开启、最后一个
         * 退订时关闭;无消费者时 C# EmitChange 首行早退,写路径零成本。
         * Promise 形态 = 最宽运行时(Electron IPC 异步;CefSharp 同步值
         * 经 Promise.resolve 统一)。
         */
        SetChangeEnabled: (enabled: boolean) => Promise<void>;
    };

    // PostgreSQL backend bridge (Dotnet/PostgreSQL.cs). Bound via CefSharp
    // (desktop) or Electron main-process IPC. In vitest it is a noopAsync
    // Proxy (see vitest.setup.js). `ExecuteJson`/`ExecuteNonQuery` accept a
    // positional `object[]` bound by `$N`; `IsConnected`/`GetHealth`/`Ping`
    // are status probes used by PgSQLAdapter health checks.
    const PostgreSQL: {
        Execute: (
            sql: string,
            args: any[] | null,
            connId?: number
        ) => Promise<any[]>;
        ExecuteJson: (
            sql: string,
            args: any[] | null,
            connId?: number
        ) => Promise<string>;
        ExecuteNonQuery: (
            sql: string,
            args: any[] | null,
            connId?: number
        ) => Promise<number>;
        ExecuteJsonOnConnection: (connectionString: string, sql: string, args?: any[] | null, connId?: number) => Promise<string>;
        ExecuteNonQueryOnConnection: (connectionString: string, sql: string, args?: any[] | null, connId?: number) => Promise<number>;
        BeginTransaction: () => number;
        /**
         * Begin a transaction on an external database file (specified by
         * connectionString) and return a connId. Used by pullEngine's dstAdapter
         * (constructed with a connectionString) so that withTransaction bodies
         * route writes to the target file atomically. The connId enters the same
         * _pinned Map; ExecutePinned/Commit/Rollback route by connId to h.Conn
         * (the target connection), independent of the singleton _connectionString.
         */
        BeginTransactionOnConnection: (connectionString: string) => number;
        CommitTransaction: (connId: number) => void;
        RollbackTransaction: (connId: number) => void;
        /**
         * Reset the sliding idle timer for the transaction pinned to connId
         * without executing any SQL. Returns true if the timer was reset,
         * false if the connId has already timed out / rolled back (no-op).
         */
        KeepAliveTransaction: (connId: number) => boolean;
        /**
         * Returns true when the data source has been initialised. Does not
         * probe the network — a true return does not guarantee the server is
         * reachable. Prefer `Ping` for a real liveness check.
         */
        IsConnected: () => Promise<boolean>;
        /**
         * Lightweight liveness probe: executes `SELECT 1` against the pool.
         * Worst-case latency bounded by `Timeout` (default 15s) when the
         * server is unreachable. Returns true on success, false on failure.
         */
        Ping: () => Promise<boolean>;
        GetHealth: () => Promise<string>;
        /**
         * Returns a JSON snapshot of connection pool three-state metrics:
         * { active, pinnedIdle, availableCapacity, max, totalOpen, idleInPool }.
         * Pure in-memory counter read, no network call. Sampled once per
         * second by StatusBar (Issue #14).
         * totalOpen/idleInPool are extended fields: PG reflects
         * PoolingDataSource.Statistics for true values; MySQL/SQLite
         * estimate from base fields. UI prefers C#-provided extended fields
         * with fallback to base-field computation when absent.
         */
        GetPoolStats: () => Promise<string>;
        /**
         * Clear idle connections from the pool. Npgsql's Clear() also
         * marks busy connections to close on return (see C# docs).
         */
        ClearIdleConnections: () => Promise<void>;
        /**
         * 变更通知门控——JS 侧在首个 onTableChange 订阅时开启、最后一个
         * 退订时关闭;无消费者时 C# EmitChange 首行早退,写路径零成本。
         * Promise 形态 = 最宽运行时(Electron IPC 异步;CefSharp 同步值
         * 经 Promise.resolve 统一)。
         */
        SetChangeEnabled: (enabled: boolean) => Promise<void>;
        /**
         * 安装/更新 NOTIFY 通知函数(幂等)。装触发器前调用一次。
         * 返回受影响行数(CefSharp int / Electron Promise<number>)。
         */
        EnsureChangeFunction: () => Promise<number>;
        /**
         * 在指定表上安装变更触发器(幂等)。FOR EACH STATEMENT,
         * 负载为模式限定表名;表不存在抛错。返回受影响行数。
         */
        CreateChangeTrigger: (table: string) => Promise<number>;
        /** 移除指定表上的变更触发器(表不存在静默)。返回受影响行数。 */
        DropChangeTrigger: (table: string) => Promise<number>;
        /** 列出所有已装变更触发器的表(JSON 行数组字符串)。 */
        ListChangeTriggers: () => Promise<string>;
    };

    const LogWatcher: {
        Get(): Promise<Array<[string, string, string, ...any[]]>>;
        SetDateTill(date: string): Promise<void>;
        GetLogLines(): Array<any>;
        Reset(): Promise<void>;
    };

    const Discord: {
        SetAssets(
            details: string,
            state: string,
            detailsUrl: string,
            bigIcon: string,
            bigIconText: string,
            smallIcon: string,
            smallIconText: string,
            startTime: number,
            endTime: number,
            partyId: string,
            partySize: number,
            partyMaxSize: number,
            buttonText: string,
            buttonUrl: string,
            appId: string,
            activityType: number,
            statusDisplayType: number
        ): Promise<void>;
        SetActive(active: boolean): Promise<boolean>;
    };

    const AppApi: {
        // Basic App Functions
        ShowDevTools(): Promise<void>;
        SetVR(
            active: boolean,
            hmdOverlay: boolean,
            wristOverlay: boolean,
            menuButton: boolean,
            overlayHand: number
        ): Promise<void>;
        SetZoom(zoomLevel: number): Promise<void>;
        GetZoom(): Promise<number>;
        DesktopNotification(
            boldText: string,
            text?: string,
            image?: string,
            silent?: boolean
        ): Promise<void>;
        RestartApplication(isUpgrade: boolean): Promise<void>;
        CheckForUpdateExe(): Promise<boolean>;
        ExecuteVrOverlayFunction(key: string, json: string): Promise<void>;
        FocusWindow(): Promise<void>;
        ChangeTheme(value: number): Promise<void>;
        DoFunny(): Promise<void>;
        GetClipboard(): Promise<string>;
        SetStartup(enabled: boolean): Promise<void>;
        CopyImageToClipboard(path: string): Promise<void>;
        FlashWindow(): Promise<void>;
        SetUserAgent(): Promise<void>;
        SetTrayIconNotification(notify: boolean): Promise<void>;
        OpenCalendarFile(icsContent: string): Promise<void>;
        GetMemoryCleanupSnapshot(): Promise<string>;
        LaunchMemoryCleanupHelper(deep: boolean): Promise<string | null>;
        HandleClosePromptChoice(
            action: 'tray' | 'exit' | 'cancel',
            dontAskAgain: boolean
        ): Promise<void>;

        // Common Functions
        GetColourFromUserID(userId: string): Promise<number>;
        OpenLink(url: string): Promise<void>;
        OpenDiscordProfile(discordId: string): Promise<void>;
        GetLaunchCommand(): Promise<string>;
        IPCAnnounceStart(): Promise<void>;
        SendIpc(type: string, data: string): Promise<void>;
        CustomCss(): Promise<string>;
        CustomScript(): Promise<string>;
        CurrentCulture(): Promise<string>;
        CurrentLanguage(): Promise<string>;
        GetVersion(): Promise<string>;
        VrcClosedGracefully(): Promise<boolean>;
        GetColourBulk(userIds: string[]): Promise<Record<string, number>>;
        SetAppLauncherSettings(
            enabled: boolean,
            killOnExit: boolean,
            runProcessOnce: boolean
        ): Promise<void>;
        GetFileBase64(path: string): Promise<string | null>;
        TryOpenInstanceInVrc(launchUrl: string): Promise<boolean>;
        ResolveDatabaseName(name: string): Promise<string>;

        // Image Upload (Cef Only)
        MD5File(blob: string): Promise<string>;
        SignFile(blob: string): Promise<string>;
        FileLength(blob: string): Promise<string>;

        // Folders
        GetVRChatAppDataLocation(): Promise<string>;
        GetVRChatPhotosLocation(): Promise<string>;
        GetUGCPhotoLocation(path?: string): Promise<string>;
        GetVRChatScreenshotsLocation(): Promise<string>;
        GetVRChatCacheLocation(): Promise<string>;
        OpenVrcxAppDataFolder(): Promise<boolean>;
        OpenVrcAppDataFolder(): Promise<boolean>;
        OpenVrcPhotosFolder(): Promise<boolean>;
        OpenUGCPhotosFolder(ugcPath?: string): Promise<boolean>;
        OpenVrcScreenshotsFolder(): Promise<boolean>;
        OpenCrashVrcCrashDumps(): Promise<boolean>;
        OpenShortcutFolder(): Promise<void>;
        OpenFolderAndSelectItem(
            path: string,
            isFolder?: boolean
        ): Promise<void>;
        OpenFolderSelectorDialog(defaultPath?: string): Promise<string>;
        OpenFileSelectorDialog(
            defaultPath?: string,
            defaultExt?: string,
            defaultFilter?: string
        ): Promise<string>;
        SaveFileSelectorDialog(
            defaultPath?: string,
            defaultExt?: string,
            defaultFilter?: string
        ): Promise<string>;

        // Game Handler
        OnProcessStateChanged(monitoredProcess: any): Promise<void>;
        CheckGameRunning(): Promise<void>;
        IsGameRunning(): Promise<boolean>;
        IsSteamVRRunning(): Promise<boolean>;
        StartSteamVR(): Promise<boolean>;
        QuitGame(): Promise<number>;
        StartGame(arguments: string): Promise<boolean>;
        StartGameFromPath(path: string, arguments: string): Promise<boolean>;

        // Registry
        GetVRChatRegistryKey(key: string): Promise<any>;
        GetVRChatRegistryKeyString(key: string): Promise<string>;
        SetVRChatRegistryKey(
            key: string,
            value: any,
            typeInt: number
        ): Promise<boolean>;
        GetVRChatRegistry(): Promise<Record<string, Record<string, any>>>;
        SetVRChatRegistry(json: string): Promise<void>;
        HasVRChatRegistryFolder(): Promise<boolean>;
        DeleteVRChatRegistryFolder(): Promise<void>;
        ReadVrcRegJsonFile(filepath: string): Promise<string>;
        GetVRChatRegistryJson: () => Promise<string>;

        // Image Functions
        PopulateImageHosts(json: string): Promise<void>;
        GetImage(url: string, fileId: string, version: string): Promise<string>;
        ResizeImageToFitLimits(base64data: string): Promise<string>;
        CropAllPrints(ugcFolderPath: string): Promise<void>;
        CropPrintImage(path: string): Promise<boolean>;
        SavePrintToFile(
            url: string,
            ugcFolderPath: string,
            monthFolder: string,
            fileName: string
        ): Promise<string>;
        SaveStickerToFile(
            url: string,
            ugcFolderPath: string,
            monthFolder: string,
            fileName: string
        ): Promise<string>;
        SaveEmojiToFile(
            url: string,
            ugcFolderPath: string,
            monthFolder: string,
            fileName: string
        ): Promise<string>;

        // Screenshot
        AddScreenshotMetadata(
            path: string,
            metadataString: string,
            worldId: string,
            changeFilename?: boolean
        ): Promise<string>;
        GetExtraScreenshotData(
            path: string,
            carouselCache: boolean
        ): Promise<string>;
        GetScreenshotMetadata(path: string): Promise<string>;
        FindScreenshotsBySearch(
            searchQuery: string,
            searchType?: number
        ): Promise<string>;
        GetLastScreenshot(): Promise<string>;
        DeleteScreenshotMetadata(path: string): Promise<boolean>;
        DeleteAllScreenshotMetadata(): Promise<void>;

        // Moderations
        GetVRChatModerations(
            currentUserId: string
        ): Promise<Record<string, number> | null>;
        GetVRChatUserModeration(
            currentUserId: string,
            userId: string
        ): Promise<number>;
        SetVRChatUserModeration(
            currentUserId: string,
            userId: string,
            type: number
        ): Promise<boolean>;

        // VRC Config
        ReadConfigFile(): Promise<string>;
        ReadConfigFileSafe(): Promise<string>;
        WriteConfigFile(json: string): Promise<void>;

        // Update
        DownloadUpdate(
            fileUrl: string,
            hashString: string,
            downloadSize: number
        ): Promise<void>;
        CancelUpdate(): Promise<void>;
        CheckUpdateProgress(): Promise<number>;

        // Notifications
        XSNotification(
            title: string,
            content: string,
            timeout: number,
            opacity: number,
            image?: string
        ): Promise<void>;
        OVRTNotification(
            hudNotification: boolean,
            wristNotification: boolean,
            title: string,
            body: string,
            timeout: number,
            opacity: number,
            image?: string
        ): Promise<void>;
    };

    const AppApiVr: {
        Init(): Promise<void>;
        VrInit(): Promise<void>;
        ToggleSystemMonitor(enabled: boolean): Promise<void>;
        CpuUsage(): Promise<number>;
        GetVRDevices(): Promise<string[][]>;
        GetUptime(): Promise<number>;
        CurrentCulture(): Promise<string>;
        CustomVrScript(): Promise<string>;
        GetExecuteVrOverlayFunctionQueue(): Promise<Map<string, string>>;
    };

    const WebApi: {
        ClearCookies(): Promise<void>;
        GetCookies(): Promise<string>;
        SetCookies(cookie: string): Promise<void>;
        Execute(options: any): Promise<{ Item1: number; Item2: string }>;
        ExecuteJson(requestJson: string): Promise<string>;
    };

    const AssetBundleManager: {
        SweepCache(): Promise<string>;
        GetCacheSize(): Promise<number>;
        GetVRChatCacheFullLocation(
            fileId: string,
            fileVersion: number,
            variant: string,
            variantVersion: number
        ): Promise<string>;
        CheckVRChatCache(
            fileId: string,
            fileVersion: number,
            variant: string,
            variantVersion: number
        ): Promise<{ Item1: number; Item2: boolean; Item3: string }>;
        DeleteCache(
            fileId: string,
            fileVersion: number,
            variant: string,
            variantVersion: number
        ): Promise<void>;
        DeleteAllCache: () => Promise<void>;
    };

    const MySQL: {
        Init: () => void;
        Exit: () => void;
        Execute: (sql: string, args: any, connId?: number) => Promise<any[]>;
        ExecuteJson: (...args: any[]) => Promise<string>;
        ExecuteNonQuery: (...args: any[]) => Promise<number>;
        ExecuteJsonOnConnection: (connectionString: string, sql: string, args?: any, connId?: number) => Promise<string>;
        ExecuteNonQueryOnConnection: (connectionString: string, sql: string, args?: any, connId?: number) => Promise<number>;
        BeginTransaction: () => number;
        /**
         * Begin a transaction on an external database file (specified by
         * connectionString) and return a connId. Used by pullEngine's dstAdapter
         * (constructed with a connectionString) so that withTransaction bodies
         * route writes to the target file atomically. The connId enters the same
         * _pinned Map; ExecutePinned/Commit/Rollback route by connId to h.Conn
         * (the target connection), independent of the singleton _connectionString.
         */
        BeginTransactionOnConnection: (connectionString: string) => number;
        CommitTransaction: (connId: number) => void;
        RollbackTransaction: (connId: number) => void;
        /**
         * Reset the sliding idle timer for the transaction pinned to connId
         * without executing any SQL. Returns true if the timer was reset,
         * false if the connId has already timed out / rolled back (no-op).
         */
        KeepAliveTransaction: (connId: number) => boolean;
        /**
         * Reports whether the shared MySQL/MariaDB connection is open. Bound
         * via CefSharp (desktop) or Electron main-process IPC; in vitest it is
         * a noopAsync Proxy (see vitest.setup.js). Symmetric to
         * PostgreSQL.IsConnected — returns true once Init() has been called,
         * does not probe the network. Prefer `Ping` for a real liveness check.
         */
        IsConnected: () => Promise<boolean>;
        /**
         * Lightweight liveness probe symmetric to PostgreSQL.Ping: executes
         * `SELECT 1` against the pool. Worst-case latency bounded by
         * `ConnectionTimeout` (default 15s) when the server is unreachable.
         * Returns true on success, false on failure.
         */
        Ping: () => Promise<boolean>;
        /**
         * Returns a JSON snapshot of connection pool three-state metrics:
         * { active, pinnedIdle, availableCapacity, max, totalOpen, idleInPool }.
         * Pure in-memory counter read, no network call. Sampled once per
         * second by StatusBar (Issue #14).
         * totalOpen/idleInPool are extended fields: PG reflects
         * PoolingDataSource.Statistics for true values; MySQL/SQLite
         * estimate from base fields. UI prefers C#-provided extended fields
         * with fallback to base-field computation when absent.
         */
        GetPoolStats: () => Promise<string>;
        /**
         * Probe with `SELECT 1` and return a JSON health snapshot:
         * `{ connected, latencyMs, lastHealthCheck }`. Symmetric to
         * PostgreSQL.GetHealth.
         */
        GetHealth: () => Promise<string>;
        /**
         * Clear idle connections from the pool. Busy connections are
         * unaffected (MySqlConnector ClearAllPools only drops idle).
         */
        ClearIdleConnections: () => Promise<void>;
        /**
         * 变更通知门控——JS 侧在首个 onTableChange 订阅时开启、最后一个
         * 退订时关闭;无消费者时 C# EmitChange 首行早退,写路径零成本。
         * Promise 形态 = 最宽运行时(Electron IPC 异步;CefSharp 同步值
         * 经 Promise.resolve 统一)。
         */
        SetChangeEnabled: (enabled: boolean) => Promise<void>;
    };

    const webApiService: {
        clearCookies(): Promise<void>;
        getCookies(): Promise<string>;
        setCookies(cookie: string): Promise<void>;
        execute(options: {
            url: string;
            method?: string;
            uploadFilePUT?: boolean;
            fileData?: string;
            fileMIME?: string;
            fileMD5?: string;
            headers?: Record<string, string>;
            data?: any;
        }): Promise<{ status: number; data: string }>;
    };
}

export {};
