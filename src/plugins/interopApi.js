// @ts-nocheck
import InteropApi from '../ipc-electron/interopApi.js';
import configRepository from '../services/config.js';
import vrcxJsonStorage from '../services/jsonStorage.js';
import { initAdapter } from '../services/database/adapter/index.js';
import { normalizeNodeMode } from '../services/database/adapter/readOnlyGate.js';

/**
 * Snapshot of the persisted `VRCX_Database.*` keys read at boot, i.e. the
 * exact connection parameters the C# layer used to `Init()` the active
 * backend (SQLite / PostgreSQL / MySQL) this session. The renderer-side
 * adapter singleton was constructed from the same `VRCX_Database.mode`
 * value, so this snapshot is the authoritative description of where the
 * live adapter is actually writing.
 *
 * The migration UI keeps editable refs (`pgsqlHost`, `mysqlPort`, …) that
 * the user may change — and even persist via `VRCXStorage.Set` — without
 * restarting. Until a restart, those edits do NOT reach the running C#
 * pool / adapter singleton, so a migration triggered from the UI would
 * silently target the boot-time connection while the form shows the new
 * values. To block that, the Advanced settings store compares the current
 * UI refs against this snapshot (see `canPushToRemote` in
 * `stores/settings/advanced.js`); a mismatch means "restart required
 * before pushing".
 *
 * Defaults mirror `loadDatabaseEngineConfig` fallbacks so the comparison
 * is stable when keys are absent (fresh install / vitest stubs).
 * @type {{ mode: string, host: string, port: string, username: string, password: string, name: string }}
 */
export const bootDbConfig = {
    mode: 'sqlite',
    host: 'localhost',
    port: '',
    username: '',
    password: '',
    name: ''
};

export async function initInteropApi(isVrOverlay = false) {
    if (isVrOverlay) {
        if (WINDOWS) {
            await CefSharp.BindObjectAsync('AppApiVr');
        } else {
            // @ts-ignore
            window.AppApiVr = InteropApi.AppApiVrElectron;
        }
    } else {
        // #region | Init Cef C# bindings
        if (WINDOWS) {
            // PostgreSQL is registered by C# `JavascriptBindings.cs` (L14)
            // alongside SQLite, so it is available to be bound here.
            // MySQL is NOT yet registered on the C# side in this branch —
            // adding it to `BindObjectAsync` now would reject the whole
            // promise and break Cef startup. Once the MySQL branch's
            // `JavascriptBindings.cs` change merges in, append 'MySQL'
            // to this list. The Electron branch below already wires up
            // `window.MySQL` via the InteropApi Proxy (safe — the proxy
            // only forwards calls at runtime, so an unimplemented .NET
            // MySQL class does not block startup).
            await CefSharp.BindObjectAsync(
                'AppApi',
                'WebApi',
                'VRCXStorage',
                'SQLite',
                'MySQL',
                'PostgreSQL',
                'LogWatcher',
                'Discord',
                'AssetBundleManager'
            );
        } else {
            window.AppApi = InteropApi.AppApiElectron;
            window.WebApi = InteropApi.WebApi;
            window.VRCXStorage = InteropApi.VRCXStorage;
            window.SQLite = InteropApi.SQLite;
            // Electron: the InteropApi Proxy (see ipc-electron/interopApi.js)
            // forwards any property access to `window.interopApi.callDotNetMethod`,
            // so `window.PostgreSQL` / `window.MySQL` are usable as soon as
            // the .NET side registers those classes — no static binding
            // needed. The assignments here exist for parity with the
            // SQLite/AppApi lines above (ESLint `no-undef` + readability).
            // `src-electron/main.js` calls `PostgreSQL.Init()` when the
            // user selects `postgresql` mode; MySQL will get the same
            // treatment once the MySQL branch's main.js change merges.
            window.PostgreSQL = InteropApi.PostgreSQL;
            window.MySQL = InteropApi.MySQL;
            window.LogWatcher = InteropApi.LogWatcher;
            window.Discord = InteropApi.Discord;
            window.AssetBundleManager = InteropApi.AssetBundleManager;
            window.AppApiVrElectron = InteropApi.AppApiVrElectron;
        }

        // Initialise the DB adapter singleton before `configRepository`
        // or any module that touches the database runs. The mode is read
        // from VRCXStorage once here (the authoritative source for user
        // config at startup) and passed into `initAdapter(mode)`, which
        // lazy-imports the appropriate adapter class. This aligns with
        // the MySQL branch's call contract (`initAdapter(mode)` takes
        // an explicit mode argument) and keeps the adapter module free
        // of VRCXStorage reads so it can be unit-tested in isolation.
        //
        // VRCXStorage.Get is typed as `Promise<string>` (callers `await`
        // it defensively), but the C# binding returns a string
        // synchronously at runtime. `await` on a string is a no-op, so
        // this works in both Cef (sync string) and vitest (real Promise
        // stubbed to resolve to '' → falls through to the 'sqlite'
        // default). The `typeof === 'string' && mode` guard rejects
        // empty/non-string values without throwing.
        const dbMode = await VRCXStorage.Get('VRCX_Database.mode');
        // Snapshot the full connection config the C# layer is booting with,
        // BEFORE any user edit can reach VRCXStorage. This is the source of
        // truth for "what the live adapter is actually connected to this
        // session" — see `bootDbConfig` doc above. Read alongside `dbMode`
        // so the snapshot and the adapter init see a consistent view.
        // `VRCX_NodeMode` is read in the same batch: browse mode boots the
        // adapter wrapped in the read-only gate (see readOnlyGate.js), so
        // the gate decision and the connection snapshot see one consistent
        // startup view.
        const [dbHost, dbPort, dbUser, dbPass, dbName, rawNodeMode] =
            await Promise.all([
                VRCXStorage.Get('VRCX_Database.host'),
                VRCXStorage.Get('VRCX_Database.port'),
                VRCXStorage.Get('VRCX_Database.username'),
                VRCXStorage.Get('VRCX_Database.password'),
                VRCXStorage.Get('VRCX_Database.name'),
                VRCXStorage.Get('VRCX_NodeMode')
            ]);
        const bootMode =
            typeof dbMode === 'string' && dbMode ? dbMode : 'sqlite';
        bootDbConfig.mode = bootMode;
        bootDbConfig.host =
            typeof dbHost === 'string' && dbHost ? dbHost : 'localhost';
        bootDbConfig.port = typeof dbPort === 'string' ? dbPort : '';
        bootDbConfig.username = typeof dbUser === 'string' ? dbUser : '';
        bootDbConfig.password = typeof dbPass === 'string' ? dbPass : '';
        bootDbConfig.name = typeof dbName === 'string' ? dbName : '';
        const bootNodeMode = normalizeNodeMode(rawNodeMode);
        await initAdapter(bootMode, { readOnly: bootNodeMode === 'browse' });

        await configRepository.init();
        new vrcxJsonStorage(VRCXStorage);

        AppApi.SetUserAgent();
    }
}
